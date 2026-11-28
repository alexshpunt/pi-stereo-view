// LPT-1943: record a pane's whole element-tree stream (snapshot + every body) as JSON lines, for the mod's replay
// adapter. The live app test uses it until herdr-app's streaming process API exists.
// Usage: node scripts/bench/record-stream.mjs <labels dir> <chat|activity> <out.jsonl>
import { createConnection } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";

const [dir, pane, out] = [process.argv[2], process.argv[3] ?? "chat", process.argv[4] ?? `/tmp/stream-${process.argv[3] ?? "chat"}.jsonl`];
const label = readFileSync(`${dir}/labels.log`, "utf8").split("\n").find(line => line.includes("bridge="));
const socket = createConnection(JSON.parse(label.split("bridge=")[1]).socket);
const lines = [];
const items = [];
let buffer = "", rq = 0, waiting, pendingAsk;
socket.on("connect", () => socket.write(JSON.stringify({ op: "open", pane }) + "\n"));
socket.on("data", chunk => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    if (message.t === "snap") { lines.push(line); items.push(...message.items); if (message.last) waiting?.(); }
    else if (message.t === "cp") { if (message.id) lines.push(`C\t${pendingAsk}\t${message.pane}\t${message.id}`); waiting?.(); }
    else if (message.t === "bodies") {
      // `B<TAB>ids<TAB>json`: the replay adapter indexes the ids without parsing the body (the mod's heap is small).
      delete message.rq; lines.push(`B\t${Object.keys(message.bodies).join(",")}\t${JSON.stringify(message)}`); waiting?.();
    }
  }
});
const next = () => new Promise(resolve => { waiting = resolve; });
await next();
// Folded items: their full bodies are what an expand asks for. The rest already came with the snapshot.
const ids = items.filter(item => item.x).map(item => item.id);
for (let i = 0; i < ids.length; i += 48) { const done = next(); socket.write(JSON.stringify({ op: "get", rq: ++rq, ids: ids.slice(i, i + 48) }) + "\n"); await done; }
// Go to answers for a sample (every 10th item and the last 40), enough for a live check without 12,000 round trips.
const sample = items.filter((item, i) => item.k !== "rows" && (i % 10 === 0 || i >= items.length - 40)).map(item => item.id);
for (const id of sample) {
  const done = next();
  socket.write(JSON.stringify({ op: "counterpart", rq: ++rq, id }) + "\n");
  // the reply carries rq only: remember which id it answers
  pendingAsk = id;
  await done;
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(JSON.stringify({ pane, out, items: items.length, lines: lines.length, bytes: lines.reduce((n, l) => n + l.length, 0) }));
socket.end();
