import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { GuiContent, type GuiPage } from "./gui-content.ts";
import type { NativeContentIndex } from "./content.ts";
import { parseGuiRequest, type GuiAction, type GuiSetting } from "./gui-protocol.ts";
import type { TranscriptLayout } from "./layout.ts";

type GuiControls = { state(): ReturnType<TranscriptLayout["guiState"]>; action(action: GuiAction): void;
  setting(setting: GuiSetting): void; renderer(): ReturnType<TranscriptLayout["guiRenderer"]>;
  search(): ReturnType<TranscriptLayout["guiSearchModel"]> };

const LABEL = "herdr.stereo.bridge";
const REQUEST_LIMIT = 4096;
const RESPONSE_LIMIT = 3 * 1024 * 1024;
/** A short page can be followed by another request; one oversized entry cannot. */
export function encodeGuiPage(page: GuiPage, limit = RESPONSE_LIMIT): string {
  let count = page.entries.length;
  while (true) {
    const output = JSON.stringify({ ...page, entries: page.entries.slice(0, count) });
    if (Buffer.byteLength(output) <= limit) return output;
    if (count <= 1) throw new Error("Entry is too large");
    count = Math.max(1, Math.floor(count / 2));
  }
}
function publishLabel(terminal: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.env.HC_BIN || "hc", ["label", terminal, `${LABEL}=${label}`], { timeout: 4000, windowsHide: true }, error => {
      if (error) reject(error); else resolve();
    });
  });
}

/** Expose bounded pages from the live Pi process through a private Unix socket. */
export async function startGuiBridge(terminal: string, index: () => NativeContentIndex | undefined,
  publish: (terminal: string, label: string) => Promise<void> = publishLabel,
  controls?: () => GuiControls | undefined): Promise<() => Promise<void>> {
  if (process.platform === "win32") throw new Error("Native Windows bridge is not supported yet");
  const directory = await mkdtemp(join("/tmp", "stereo-"));
  const socketPath = join(directory, "s");
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  let currentIndex: NativeContentIndex | undefined;
  let content: GuiContent | undefined;
  try {
    server = createServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setTimeout(3000, () => socket.destroy());
      let request = "";
      socket.on("error", () => socket.destroy());
      socket.on("data", chunk => {
        request += chunk.toString("utf8");
        if (Buffer.byteLength(request) > REQUEST_LIMIT) { socket.destroy(); return; }
        const end = request.indexOf("\n");
        if (end < 0) return;
        socket.pause();
        try {
          const parsed = parseGuiRequest(JSON.parse(request.slice(0, end)));
          if (!parsed) throw new Error("Invalid request");
          if (parsed.op !== "page") {
            const current = controls?.();
            if (!current) throw new Error("Controls are unavailable");
            if (parsed.op === "state") socket.end(JSON.stringify(current.state()) + "\n");
            else if (parsed.op === "image") {
              const chunk = current.renderer()?.imageChunk(parsed.id, parsed.offset, parsed.length);
              if (!chunk) throw new Error("Image unavailable");
              socket.end(JSON.stringify({ v: 1, ...chunk }) + "\n");
            }
            else if (parsed.op === "view") {
              const renderer = current.renderer();
              if (!renderer) throw new Error("History is unavailable");
              const { pane, top, height, width, following } = parsed;
              const search = pane === "combined" ? undefined : current.search();
              if (search && pane !== "combined") void search.refresh(pane);
              const output = JSON.stringify({ v: 1, ...renderer.page(pane, { top, height, width, following }),
                ...(search && pane !== "combined" ? { search: search.state(pane) } : {}) });
              if (Buffer.byteLength(output) > RESPONSE_LIMIT) throw new Error("View is too large");
              socket.end(output + "\n");
            } else if (parsed.op === "search") {
              const search = current.search();
              if (!search) throw new Error("Search is unavailable");
              const pane = parsed.pane;
              const reply = (result: unknown): void => { if (!socket.destroyed) socket.end(JSON.stringify({ v: 1, ...result as object }) + "\n"); };
              if (parsed.action === "query") {
                void search.query(pane, parsed.query).then(reply, error => {
                  if (!socket.destroyed) socket.end(JSON.stringify({ error: error instanceof Error ? error.message : "Search failed" }) + "\n");
                });
              } else if (parsed.action === "open") reply(search.open(pane, parsed));
              else if (parsed.action === "close") reply({ ...search.state(pane), restored: search.close(pane), open: false });
              else if (parsed.action === "next" || parsed.action === "previous") reply(search.step(pane, parsed.action === "next" ? 1 : -1));
              else reply(search.state(pane));
            } else if (parsed.op === "mouse") {
              const renderer = current.renderer();
              if (!renderer) throw new Error("History is unavailable");
              socket.end(JSON.stringify({ v: 1, ok: renderer.mouse(parsed.pane, parsed.frame, parsed.event) }) + "\n");
            } else {
              if (parsed.op === "action") current.action(parsed.action);
              else current.setting({ key: parsed.key, value: parsed.value });
              socket.end(JSON.stringify({ v: 1, ok: true }) + "\n");
            }
            return;
          }
          const nextIndex = index();
          if (!nextIndex) throw new Error("History is unavailable");
          if (nextIndex !== currentIndex) { currentIndex = nextIndex; content = new GuiContent(nextIndex); }
          const page = content!.page(parsed.pane, parsed.start, parsed.count, parsed.width);
          const output = encodeGuiPage(page);
          socket.end(output + "\n");
        } catch (error) {
          socket.end(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed" }) + "\n");
        }
      });
    });
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => { server!.removeListener("error", reject); resolve(); });
    });
    const label = JSON.stringify({ v: 1, pid: process.pid, socket: socketPath });
    await publish(terminal, label);
  } catch (error) {
    if (server?.listening) server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
}
