// LPT-1943: open the element-tree stream of one pane and report snapshot size/time, a body fetch and a rows fallback.
// Usage: node scripts/bench/stream-probe.mjs <labels dir> [chat|activity]
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";

const dir = process.argv[2] ?? "/tmp/lpt1943-bench";
const pane = process.argv[3] ?? "chat";
const label = readFileSync(`${dir}/labels.log`, "utf8").split("\n").find(line => line.includes("bridge="));
const socketPath = JSON.parse(label.split("bridge=")[1]).socket;
const t0 = performance.now();
const socket = createConnection(socketPath);
let buffer = "", bytes = 0, lines = 0, items = 0, total = 0, snapAt = 0;
const kinds = {};
const wait = [];
const allItems = [];
let heightsBytes = 0, heightsMessages = 0, onHeights, heightsDone;
socket.on("connect", () => socket.write(JSON.stringify({ op: "open", pane }) + "\n"));
socket.on("data", chunk => {
  bytes += chunk.length; buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); lines++;
    const message = JSON.parse(line);
    if (message.t === "heights") { heightsBytes += line.length; heightsMessages++; if (message.last) onHeights?.(true); continue; }
    if (message.t === "snap") {
      items += message.items.length; total = message.total; allItems.push(...message.items);
      for (const item of message.items) kinds[item.k] = (kinds[item.k] ?? 0) + 1;
      if (message.last) { snapAt = performance.now() - t0; wait.splice(0).forEach(fn => fn(message)); }
    } else wait.splice(0).forEach(fn => fn(message));
  }
});
const next = () => new Promise(resolve => wait.push(resolve));
await next();
console.log(JSON.stringify({ pane, snapshotMs: +snapAt.toFixed(1), bytes, lines, total, items, kinds }));
// What Pi spends on exact heights: wrapping every body at 87 cells (the cost behind the `heights` messages).
const { bodyRows } = await import("../../herdr/mods/stereo-view/wrap.js");
const tw = performance.now();
let rowsTotal = 0;
for (const item of allItems) if (item.b) rowsTotal += bodyRows(item.b, 87);
console.log(JSON.stringify({ wrapAllMs: +(performance.now() - tw).toFixed(1), rowsTotal }));
// And the real thing, when this Pi answers `cols`: time to the last chunk.
const th = performance.now();
heightsDone = new Promise(resolve => { onHeights = resolve; });
socket.write(JSON.stringify({ op: "cols", cols: 87 }) + "\n");
const answered = await Promise.race([heightsDone, new Promise(resolve => setTimeout(() => resolve(null), 4000))]);
console.log(JSON.stringify({ heightsMs: answered ? +(performance.now() - th).toFixed(1) : null, heightsBytes, heightsMessages }));
const t1 = performance.now();
socket.write(JSON.stringify({ op: "get", rq: 1, ids: [] }) + "\n");
const empty = await next();
console.log("get round trip ms", (performance.now() - t1).toFixed(1), empty.t);
socket.end();
