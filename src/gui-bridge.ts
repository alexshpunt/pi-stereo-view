import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { GuiContent, type GuiPage } from "./gui-content.ts";
import { attachTreeStream } from "./gui-stream.ts";
import { GuiTree } from "./gui-tree.ts";
import type { NativeContentIndex } from "./content.ts";
import { parseGuiRequest, type GuiAction, type GuiSetting } from "./gui-protocol.ts";
import type { TranscriptLayout } from "./layout.ts";

type GuiControls = { state(): ReturnType<TranscriptLayout["guiState"]>; action(action: GuiAction): void;
  setting(setting: GuiSetting): void; renderer(): ReturnType<TranscriptLayout["guiRenderer"]>;
  search(): ReturnType<TranscriptLayout["guiSearchModel"]>; surface?(target?: "dock"): ReturnType<TranscriptLayout["guiSurface"]>;
  overlays?(): ReturnType<TranscriptLayout["guiOverlays"]> };

const LABEL = "herdr.stereo.bridge";
/** LPT-1943 benchmark: report how long Pi spent rendering and encoding each view page. */
const BENCH = process.env.STEREO_BENCH === "1";
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
  const tree = new GuiTree(index);
  type PasteChunk = Extract<import("./gui-protocol.ts").GuiRequest, { op: "surface-paste" | "overlay-paste" }>;
  type PendingPaste = { key: string; surface: object; frame: number; count: number; next: number; bytes: number; pieces: string[]; expires: number };
  const pastes = new Map<string, PendingPaste>();
  const expirePastes = (): void => { for (const [id, paste] of pastes) if (paste.expires <= Date.now()) pastes.delete(id); };
  const appendPaste = (chunk: PasteChunk, current: GuiControls): boolean => {
    expirePastes();
    const overlays = chunk.op === "overlay-paste" ? current.overlays?.() : undefined;
    const surface = chunk.op === "surface-paste" ? current.surface?.(chunk.target) : undefined;
    const owner = overlays ?? surface;
    const key = chunk.op === "overlay-paste" ? `overlay:${chunk.revision}:${chunk.id}` : `surface:${chunk.target ?? "dialog"}`;
    const valid = chunk.op === "overlay-paste" ? overlays?.accepts(chunk.revision, chunk.id, chunk.frame) : surface?.accepts(chunk.frame);
    const existing = pastes.get(chunk.transaction);
    if (!owner || !valid || (existing && (existing.key !== key || existing.surface !== owner || existing.frame !== chunk.frame ||
        existing.count !== chunk.count || existing.next !== chunk.index)) || (!existing && chunk.index !== 0)) {
      pastes.delete(chunk.transaction);
      return false;
    }
    if (!existing && pastes.size >= 8) return false;
    const paste = existing ?? { key, surface: owner, frame: chunk.frame, count: chunk.count, next: 0, bytes: 0, pieces: [], expires: Date.now() + 30_000 };
    paste.bytes += Buffer.byteLength(chunk.data);
    if (paste.bytes > 1024 * 1024) { pastes.delete(chunk.transaction); return false; }
    paste.pieces.push(chunk.data);
    paste.next++;
    paste.expires = Date.now() + 30_000;
    if (paste.next < paste.count) { pastes.set(chunk.transaction, paste); return true; }
    pastes.delete(chunk.transaction);
    const data = `\x1b[200~${paste.pieces.join("")}\x1b[201~`;
    return chunk.op === "overlay-paste" ? overlays!.key(chunk.revision, chunk.id, chunk.frame, data) : surface!.key(chunk.frame, data);
  };
  const pasteTimer = setInterval(expirePastes, 10_000);
  pasteTimer.unref();
  try {
    server = createServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setTimeout(3000, () => socket.destroy());
      let request = "", requestBytes = 0;
      const decoder = new StringDecoder("utf8");
      socket.on("error", () => socket.destroy());
      socket.on("data", chunk => {
        requestBytes += chunk.length;
        if (requestBytes > REQUEST_LIMIT) { socket.destroy(); return; }
        request += decoder.write(chunk);
        const end = request.indexOf("\n");
        if (end < 0) return;
        socket.pause();
        let pasteTransaction: string | undefined;
        try {
          const raw: unknown = JSON.parse(request.slice(0, end));
          // LPT-1943: a long-lived element-tree stream takes the connection over; it has no request timeout.
          if (raw && typeof raw === "object" && "op" in raw && raw.op === "open" && "pane" in raw && (raw.pane === "chat" || raw.pane === "activity")) {
            socket.removeAllListeners("data");
            socket.resume();
            attachTreeStream(socket, tree, raw.pane, request.slice(end + 1));
            return;
          }
          if (raw && typeof raw === "object" && "transaction" in raw && typeof raw.transaction === "string") pasteTransaction = raw.transaction;
          const parsed = parseGuiRequest(raw);
          if (!parsed) throw new Error("Invalid request");
          if (parsed.op !== "page") {
            const current = controls?.();
            if (!current) {
              if (parsed.op === "surface-paste" || parsed.op === "overlay-paste") pastes.delete(parsed.transaction);
              throw new Error("Controls are unavailable");
            }
            if (parsed.op === "state") socket.end(JSON.stringify(current.state()) + "\n");
            else if (parsed.op === "surface-paste" || parsed.op === "overlay-paste")
              socket.end(JSON.stringify({ v: 1, ok: appendPaste(parsed, current) }) + "\n");
            else if (parsed.op === "overlays") {
              const overlays = current.overlays?.();
              if (!overlays) throw new Error("Overlays unavailable");
              const output = JSON.stringify({ v: 1, ...overlays.page() });
              if (Buffer.byteLength(output) > RESPONSE_LIMIT) throw new Error("Overlays are too large");
              socket.end(output + "\n");
            } else if (parsed.op === "overlay-key") {
              socket.end(JSON.stringify({ v: 1, ok: current.overlays?.()?.key(parsed.revision, parsed.id, parsed.frame, parsed.data) === true }) + "\n");
            } else if (parsed.op === "overlay-mouse") {
              socket.end(JSON.stringify({ v: 1, ok: current.overlays?.()?.mouse(parsed.revision, parsed.id, parsed.frame, parsed.event) === true }) + "\n");
            }
            else if (parsed.op === "surface") {
              const surface = current.surface?.(parsed.target);
              if (!surface) throw new Error("Surface unavailable");
              const output = JSON.stringify({ v: 1, ...surface.page(parsed.width) });
              if (Buffer.byteLength(output) > RESPONSE_LIMIT) throw new Error("Surface is too large");
              socket.end(output + "\n");
            } else if (parsed.op === "surface-key") {
              const surface = current.surface?.(parsed.target);
              socket.end(JSON.stringify({ v: 1, ok: surface?.key(parsed.frame, parsed.data) === true }) + "\n");
            } else if (parsed.op === "surface-mouse") {
              const surface = current.surface?.(parsed.target);
              socket.end(JSON.stringify({ v: 1, ok: surface?.mouse(parsed.frame, parsed.event) === true }) + "\n");
            }
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
              const benchStart = BENCH ? performance.now() : 0;
              const rendered = renderer.page(pane, { top, height, width, following });
              const benchRendered = BENCH ? performance.now() : 0;
              const output = JSON.stringify({ v: 1, ...rendered,
                ...(search && pane !== "combined" ? { search: search.state(pane) } : {}),
                ...(BENCH ? { bench: { pageMs: benchRendered - benchStart, encodeMs: performance.now() - benchRendered } } : {}) });
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
          if (pasteTransaction) pastes.delete(pasteTransaction);
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
    clearInterval(pasteTimer);
    pastes.clear();
    if (server?.listening) server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(pasteTimer);
    pastes.clear();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
}
