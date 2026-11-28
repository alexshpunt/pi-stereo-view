// LPT-1943 automated benchmark of the mod's element-tree pipeline against a real Pi (Stereo View bridge) on the
// big-session fixture. It measures the UI-thread cost of every operation the GUI does per frame: it fails (exit 1)
// when an operation's p95 > 16 ms or max > 33 ms, or when a frame after loading shows a pending item.
// Usage: node scripts/bench/tree-bench.mjs <labels dir> [chat|activity] [out.json]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { TreeClient } from "../../herdr/mods/stereo-view/tree-client.js";
import { TreeView } from "../../herdr/mods/stereo-view/tree-view.js";
import { TreeSearch } from "../../herdr/mods/stereo-view/tree-search.js";

const dir = process.argv[2] ?? "/tmp/lpt1943-bench";
const pane = process.argv[3] ?? "chat";
const out = process.argv[4];
const P95 = 16, MAX = 33;
const label = readFileSync(`${dir}/labels.log`, "utf8").split("\n").find(line => line.includes("bridge="));
const socket = JSON.parse(label.split("bridge=")[1]).socket;

/** The streaming process API as a plain child process (the app provides the same on the pane's machine). */
function spawnStream(command, args) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const lineCallbacks = [], exitCallbacks = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      for (const callback of lineCallbacks) callback(line);
    }
  });
  child.on("exit", code => exitCallbacks.forEach(callback => callback(code)));
  return { onLine: cb => lineCallbacks.push(cb), onExit: cb => exitCallbacks.push(cb), write: line => child.stdin.write(line.endsWith("\n") ? line : line + "\n"), kill: () => child.kill() };
}

const samples = {};
const record = (name, ms) => (samples[name] ??= []).push(ms);
const time = (name, fn) => { const t = performance.now(); const result = fn(); record(name, performance.now() - t); return result; };
const pct = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const t0 = performance.now();
let view;
const client = new TreeClient(spawnStream, { socket, pane }, {
  message: (message, parseMs) => { record(`parse ${message.t}`, parseMs); },
  change: change => { const t = performance.now(); view.changed(change); record(`apply ${change.kind}${change.last ? " (last)" : ""}`, performance.now() - t); },
});
view = new TreeView(client, { viewport: 150, cols: 120 });
const apply = client.line.bind(client);
client.line = line => { const t = performance.now(); apply(line); record("line (parse+apply)", performance.now() - t); };
client.start();
while (!client.model.ready) await sleep(5);
const snapshotWall = performance.now() - t0;

// First frame after the snapshot: the tail must be drawable at once (bodies of the tail come with the snapshot).
const first = time("first frame", () => view.frame());
const firstPending = first.pending.length;

// Let the background prefetch load every body, frames running as they would.
const loadStart = performance.now();
while (!view.settled && performance.now() - loadStart < 120000) { time("frame while loading", () => view.frame()); await sleep(1); }
const loadWall = performance.now() - loadStart;
const exactStart = performance.now();
while (!view.exact && performance.now() - exactStart < 60000) { time("frame while measuring", () => view.frame()); await sleep(0); }
const exactWall = performance.now() - exactStart;
time("frame", () => view.frame());

let pendingAfterLoad = 0;
// Items drawn by Pi's own rows (no native component yet) are answered over the network; the loops below do not
// yield, so they are counted apart: a native item without its body on a frame after loading is a failure.
let fallbackPending = 0;
const frameAfter = fn => {
  fn();
  const frame = time("frame", () => view.frame());
  for (const index of frame.pending) { if (client.model.items[index].k === "rows") fallbackPending++; else pendingAfterLoad++; }
};

// Scroll: wheel steps, page keys, scrollbar drags, jumps.
for (let i = 0; i < 1500; i++) frameAfter(() => time("scroll by 3 rows", () => view.scrollBy(i % 2 ? -3 : 3)));
view.toBottom();
for (let i = 0; i < 400; i++) frameAfter(() => time("page up/down", () => view.scrollBy(i % 2 ? 150 : -150)));
for (let i = 0; i < 300; i++) frameAfter(() => time("scrollbar drag", () => view.scrollTo(Math.random() * view.layout.totalRows)));
for (let i = 0; i < 90; i++) frameAfter(() => time("jump top/bottom/middle", () => i % 3 === 0 ? view.toTop() : i % 3 === 1 ? view.toBottom() : view.scrollTo(view.layout.totalRows / 2)));

// Resize: every width change, the visible window must be exact on the next frame.
for (let i = 0; i < 60; i++) frameAfter(() => time("resize (setCols)", () => view.setCols(60 + ((i * 37) % 160))));
for (let i = 0; i < 60; i++) frameAfter(() => time("viewport resize", () => view.setViewport(40 + ((i * 29) % 140))));

// Search in slices of 4 ms; every slice is one frame's work.
const search = new TreeSearch(client.model);
search.start("zzzxqnotfound");
const searchStart = performance.now();
while (!search.done) { time("search slice", () => search.step(4)); await sleep(0); }
const searchWall = performance.now() - searchStart;
frameAfter(() => time("go to hit", () => search.hits.length && view.toItem(search.hits[Math.floor(search.hits.length / 2)].index)));

// A synthetic streaming splice at the tail of the real model (what the Pi stream delivers while a turn runs).
view.toBottom();
for (let i = 0; i < 100; i++) {
  const model = client.model;
  const tail = model.items.length - 1;
  const old = model.items[tail];
  const message = { t: "delta", pane, epoch: model.epoch, rev: model.rev + 1, at: tail, remove: 1, items: [{ ...old, id: `s${i}`, k: "md", n: 1, c: 400 + i, b: { t: "x".repeat(400 + i) } }] };
  const change = time("delta apply", () => model.apply(message));
  time("delta layout", () => view.changed(change));
  frameAfter(() => {});
}
client.close();

const rows = [];
let failed = false;
for (const [name, values] of Object.entries(samples)) {
  const row = { name, n: values.length, p50: +pct(values, .5).toFixed(2), p95: +pct(values, .95).toFixed(2), max: +Math.max(...values).toFixed(2) };
  row.ok = row.p95 <= P95 && row.max <= MAX;
  // Parse/apply of single lines happens in the background; every one still must fit a frame.
  if (!row.ok) failed = true;
  rows.push(row);
}
const summary = { pane, items: client.model.items.length, totalRows: view.layout.totalRows, snapshotWallMs: +snapshotWall.toFixed(0), loadAllBodiesWallMs: +loadWall.toFixed(0), allHeightsExactWallMs: +exactWall.toFixed(0), firstFramePending: firstPending, bodyCharsHeld: client.model.bodyChars, bodyCharsCap: view.maxChars, itemsWithBody: client.model.bodies.size, pendingAfterLoad, fallbackPending, fallbackItems: client.model.items.filter(item => item.k === "rows").length, kinds: client.model.items.reduce((k, item) => (k[item.k] = (k[item.k] ?? 0) + 1, k), {}), searchHits: search.hits.length, searchWallMs: +searchWall.toFixed(0), thresholds: { p95: P95, max: MAX } };
if (pendingAfterLoad) failed = true;
if (client.model.bodyChars > view.maxChars) failed = true; // memory stays bounded
console.log(JSON.stringify(summary));
console.table(rows.map(({ name, n, p50, p95, max, ok }) => ({ name, n, p50, p95, max, ok })));
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
process.exit(failed ? 1 : 0);
