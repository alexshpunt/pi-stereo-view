import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { Pane } from "./content.ts";
import type { GuiTree, ServerMessage, TreeStream } from "./gui-tree.ts";

/** Streams wake on any change of the transcript; Pi calls `notifyGuiChange` where it invalidates the GUI. */
const listeners = new Set<() => void>();
export function notifyGuiChange(): void { for (const listener of listeners) listener(); }

const COALESCE_MS = 16;
const LINE_LIMIT = 64 * 1024;

/**
 * LPT-1943: a long-lived JSON-lines connection for one pane.
 * Server sends snapshot chunks, then deltas as the transcript changes; the client sends `get` and `rows`.
 */
export function attachTreeStream(socket: Socket, tree: GuiTree, pane: Pane, pending: string): () => void {
  const stream: TreeStream = tree.open(pane);
  const decoder = new StringDecoder("utf8");
  let buffer = pending;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const send = (messages: readonly ServerMessage[] | ServerMessage): void => {
    if (closed || socket.destroyed) return;
    for (const message of Array.isArray(messages) ? messages : [messages]) socket.write(JSON.stringify(message) + "\n");
  };
  const flush = (): void => {
    timer = undefined;
    if (closed) return;
    // A slow reader gets one merged delta once it drains instead of a growing queue.
    if (socket.writableNeedDrain) { socket.once("drain", wake); return; }
    try { const out = stream.delta(); if (out) send(out); } catch { /* the index may be rebuilding; the next change retries */ }
  };
  const wake = (): void => { if (!timer && !closed) timer = setTimeout(flush, COALESCE_MS); };
  const handle = (line: string): void => {
    let request: { op?: string; rq?: number; ids?: unknown; id?: unknown; width?: unknown; full?: unknown };
    try { request = JSON.parse(line); } catch { return; }
    const rq = typeof request.rq === "number" ? request.rq : 0;
    try {
      if (request.op === "get" && Array.isArray(request.ids)) send(stream.bodies(rq, request.ids.filter((id): id is string => typeof id === "string").slice(0, 64), request.full !== false));
      else if (request.op === "counterpart" && typeof request.id === "string") send(stream.counterpart(rq, request.id));
      else if (request.op === "rows" && typeof request.id === "string") {
        send(stream.rows(rq, request.id, typeof request.width === "number" ? Math.max(8, Math.min(500, Math.floor(request.width))) : tree.defaultWidth()));
      } else if (request.op === "resync") send(stream.snapshot());
      else if (request.op === "close") socket.end();
    } catch { /* an unavailable index answers nothing; the client retries on its next change */ }
  };
  const consume = (): void => {
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) handle(line);
    }
    if (buffer.length > LINE_LIMIT) socket.destroy();
  };
  const stop = (): void => {
    if (closed) return;
    closed = true;
    listeners.delete(wake);
    if (timer) clearTimeout(timer);
  };
  socket.setTimeout(0);
  socket.setNoDelay(true);
  socket.on("data", chunk => { buffer += decoder.write(chunk as Buffer); consume(); });
  socket.once("close", stop);
  socket.on("error", () => socket.destroy());
  listeners.add(wake);
  try { send(stream.snapshot()); } catch (error) {
    socket.end(JSON.stringify({ error: error instanceof Error ? error.message : "History is unavailable" }) + "\n");
  }
  consume();
  return stop;
}
