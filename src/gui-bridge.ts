import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { GuiContent } from "./gui-content.ts";
import type { NativeContentIndex } from "./content.ts";
import { parseGuiRequest } from "./gui-protocol.ts";

const LABEL = "herdr.stereo.bridge";
const REQUEST_LIMIT = 4096;
const RESPONSE_LIMIT = 3 * 1024 * 1024;
function publishLabel(terminal: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.env.HC_BIN || "hc", ["label", terminal, `${LABEL}=${label}`], { timeout: 4000, windowsHide: true }, error => {
      if (error) reject(error); else resolve();
    });
  });
}

/** Expose bounded pages from the live Pi process through a private Unix socket. */
export async function startGuiBridge(terminal: string, index: () => NativeContentIndex | undefined,
  publish: (terminal: string, label: string) => Promise<void> = publishLabel): Promise<() => Promise<void>> {
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
          const nextIndex = index();
          if (!nextIndex) throw new Error("History is unavailable");
          if (nextIndex !== currentIndex) { currentIndex = nextIndex; content = new GuiContent(nextIndex); }
          const page = content!.page(parsed.pane, parsed.start, parsed.count, parsed.width);
          const output = JSON.stringify(page);
          if (Buffer.byteLength(output) > RESPONSE_LIMIT) throw new Error("Page is too large");
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
