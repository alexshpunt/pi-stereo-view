// LPT-1943: the mod's end of the element-tree stream. One relay process per pane runs on Pi's machine
// (node, stdin/stdout piped to Pi's unix socket); the herdr-app streaming API `spawnStream` carries its lines.
// `spawnStream(command, args, { on, cwd }) -> { onLine(cb), onExit(cb), write(line), kill() }` is injected, so
// tests and the benchmark use a fake or a plain child process.
import { TreeModel } from "./tree-model.js";

/** Relay source for `node -e`: argv[1] = Pi's socket, argv[2] = pane. Lines in, lines out. */
export const RELAY = `
const net = require("net");
const socket = net.createConnection(process.argv[1]);
let input = "";
socket.on("connect", () => socket.write(JSON.stringify({ op: "open", pane: process.argv[2] }) + "\\n"));
socket.on("data", chunk => process.stdout.write(chunk));
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));
process.stdin.on("data", chunk => { input += chunk; for (let at = input.indexOf("\\n"); at >= 0; at = input.indexOf("\\n")) { socket.write(input.slice(0, at + 1)); input = input.slice(at + 1); } });
process.stdin.on("end", () => socket.end());
`;

export class TreeClient {
  /**
   * @param spawnStream the streaming process API
   * @param target `{ socket, pane, on?, cwd? }`
   * @param hooks `{ change(change), message(message, parseMs), exit(), error(text) }`
   */
  constructor(spawnStream, target, hooks = {}) {
    this.spawnStream = spawnStream;
    this.target = target;
    this.hooks = hooks;
    this.model = new TreeModel();
    this.pending = new Map();
    this.nextRq = 1;
    this.process = undefined;
    this.closed = false;
  }

  start() {
    const { socket, pane, on, cwd } = this.target;
    this.startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.process = this.spawnStream("node", ["-e", RELAY, socket, pane], { on, cwd });
    this.process.onLine(line => this.line(line));
    // herdr-app passes `{ code, signal, stderr, killed, error }`; the replay and test fakes pass a plain code.
    this.process.onExit((info, text) => {
      const code = info !== null && typeof info === "object" ? info.code : info;
      const why = info !== null && typeof info === "object" ? (info.error ?? (info.stderr ? String(info.stderr).slice(-300) : undefined)) : text;
      this.closed = true; for (const [, p] of this.pending) p.resolve(undefined); this.pending.clear(); this.hooks.exit?.(code, why);
    });
    return this;
  }

  line(line) {
    if (!line) return;
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.marks ??= { start: this.startedAt }; // TEMPORARY LPT-1943: where cold-start time goes
    this.marks.first ??= Math.round(started - this.startedAt);
    this.marks.bytes = (this.marks.bytes ?? 0) + line.length;
    let message;
    try { message = JSON.parse(line); } catch { this.hooks.error?.("Bad line from the relay"); return; }
    const parseMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
    if (message.error) { this.hooks.error?.(message.error); return; }
    this.hooks.message?.(message, parseMs);
    if (message.t === "bodies") {
      const loaded = this.model.storeBodies(message.bodies);
      const waiter = this.pending.get(message.rq);
      this.pending.delete(message.rq);
      this.hooks.bodies?.(loaded, message.truncated ?? []);
      waiter?.resolve(loaded);
      return;
    }
    if (message.t === "heights") { if (message.last) this.marks.heights = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - this.startedAt); this.hooks.heights?.(message); return; }
    if (message.t === "cp") {
      const waiter = this.pending.get(message.rq);
      this.pending.delete(message.rq);
      waiter?.resolve(message.id ? { pane: message.pane, id: message.id } : undefined);
      return;
    }
    if (message.t === "rows") {
      const waiter = this.pending.get(message.rq);
      this.pending.delete(message.rq);
      waiter?.resolve(message.lines);
      return;
    }
    const change = this.model.apply(message);
    if (message.t === "snap" && message.last) this.marks.snapshot = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - this.startedAt);
    if (change?.resync) { this.send({ op: "resync" }); return; }
    if (change) this.hooks.change?.(change);
  }

  /** The trailing newline is explicit: if the API appends one too, Pi ignores the empty line. */
  send(request) { if (!this.closed) this.process.write(JSON.stringify(request) + "\n"); }

  request(request) {
    const rq = this.nextRq++;
    return new Promise(resolve => { this.pending.set(rq, { resolve }); this.send({ ...request, rq }); });
  }

  /** The GUI's text width: Pi answers with the exact row count of every item at it (`heights` messages). */
  setCols(cols) {
    if (this.sentCols === cols) return;
    this.sentCols = cols;
    this.send({ op: "cols", cols });
  }
  /** Ask for bodies; resolves with the ids that arrived. */
  get(ids) { return this.request({ op: "get", ids, full: true }); }
  /** The element of the other pane at the same point of history (Pi decides): { pane, id } or undefined. */
  counterpart(id) { return this.request({ op: "counterpart", id }); }
  /** Pi's own rendered rows of one item at a width: the fallback for items without a native component. */
  rows(id, width) { return this.request({ op: "rows", id, width }); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.process?.kill();
  }
}
