// LPT-1943 benchmark client: talks to a running Pi's Stereo View bridge exactly as the Herdr mod does.
// usage: node scripts/bench/client.mjs BENCH_DIR [OUT.json]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { performance } from "node:perf_hooks";

const [dir, out] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = performance.now();

async function waitForSocket() {
  for (;;) {
    try {
      const line = readFileSync(`${dir}/labels.log`, "utf8").split("\n").find(l => l.includes("herdr.stereo.bridge="));
      if (line) return JSON.parse(line.slice(line.indexOf("herdr.stereo.bridge=") + 20)).socket;
    } catch {}
    await sleep(50);
  }
}

/** One request over a fresh connection (what a long-lived relay would do per message, without the process spawn). */
function direct(socket, payload) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const c = net.createConnection(socket);
    let reply = "";
    c.setEncoding("utf8");
    c.on("error", reject);
    c.on("connect", () => c.write(JSON.stringify(payload) + "\n"));
    c.on("data", d => { reply += d; });
    c.on("end", () => { const ms = performance.now() - start; resolve({ ms, bytes: reply.length, json: JSON.parse(reply) }); });
  });
}

/** One request the way the mod does it: a new `node -e CLIENT` process per request. */
const source = readFileSync(new URL("../../herdr/mods/stereo-view/main.js", import.meta.url), "utf8");
const CLIENT = new Function("return `" + source.match(/const CLIENT = `([\s\S]*?)`;/)[1] + "`")();
function spawned(socket, payload) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn("node", ["-e", CLIENT, socket, JSON.stringify(payload)], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", d => { stdout += d; });
    child.on("error", reject);
    child.on("close", code => { const ms = performance.now() - start; code === 0 ? resolve({ ms, bytes: stdout.length, json: JSON.parse(stdout) }) : reject(new Error("client exit " + code)); });
  });
}

const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: sorted.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) };
};
const results = {};
const record = (name, samples) => {
  results[name] = { client: stats(samples.map(s => s.ms)), page: stats(samples.map(s => s.json?.bench?.pageMs ?? 0)),
    encode: stats(samples.map(s => s.json?.bench?.encodeMs ?? 0)), bytes: stats(samples.map(s => s.bytes)) };
  const r = results[name];
  console.log(`${name.padEnd(34)} n=${String(r.client.n).padStart(3)}  total p50/p95/max ${r.client.p50}/${r.client.p95}/${r.client.max} ms   Pi page ${r.page.p50}/${r.page.p95}/${r.page.max}  encode ${r.encode.p50}/${r.encode.p95}/${r.encode.max}  KB ${(r.bytes.p50 / 1024).toFixed(0)}`);
};

const socket = await waitForSocket();
console.log("bridge up after", Math.round(performance.now() - T0), "ms");
let ready = 0;
const view = (pane, top, height, width, following = false) => ({ v: 1, op: "view", pane, top, height, width, following });
for (;;) {
  try { const r = await direct(socket, view("chat", 0, 50, 100)); if (r.json.total > 0 && !r.json.settling) { ready = performance.now() - T0; break; } } catch {}
  await sleep(100);
}
console.log("history ready after", Math.round(ready), "ms");
results.startup = { bridgeUpMs: Math.round(ready) };

const H = 150; // a page as the mod asks for it: three viewports of ~50 rows
const W = 100;
for (const pane of ["chat", "activity"]) {
  const first = await direct(socket, view(pane, 0, H, W));
  const total = first.json.total;
  console.log(`\n== ${pane}: ${total} rows at width ${W} ==`);
  results[pane + "Rows"] = total;
  // 0. what the transport itself costs: a trivial request, spawned vs direct.
  record(`${pane} state (spawned process)`, await seq(8, () => spawned(socket, { v: 1, op: "state" })));
  record(`${pane} state (direct socket)`, await seq(20, () => direct(socket, { v: 1, op: "state" })));
  // 1. one steady page, repeated.
  record(`${pane} same page (direct)`, await seq(20, () => direct(socket, view(pane, 100, H, W))));
  record(`${pane} same page (spawned)`, await seq(8, () => spawned(socket, view(pane, 100, H, W))));
  // 2. wheel scroll: 3 rows at a time, page re-requested each step, like the 700 ms poll after a scroll.
  let top = 1000;
  record(`${pane} wheel scroll 3 rows (direct)`, await seq(60, () => direct(socket, view(pane, top += 3, H, W))));
  record(`${pane} page jump 100 rows (direct)`, await seq(30, () => direct(socket, view(pane, top += 100, H, W))));
  // 3. jumps to unrelated places (scrollbar drag, Go to, search jump).
  const far = Array.from({ length: 25 }, (_, i) => Math.floor(((i * 7919) % 1000) / 1000 * Math.max(1, total - H)));
  record(`${pane} jump far (direct)`, await seq(far.length, () => direct(socket, view(pane, far.shift(), H, W))));
  record(`${pane} jump far (spawned)`, await seq(8, () => spawned(socket, view(pane, Math.floor(Math.random() * (total - H)), H, W))));
  // 4. tail / following.
  record(`${pane} tail following (direct)`, await seq(15, () => direct(socket, view(pane, 0, H, W, true))));
  record(`${pane} top (direct)`, await seq(10, () => direct(socket, view(pane, 0, H, W))));
  // 5. resize: new width, then ask again until Pi stops settling (what the mod's settle loop does).
  for (const widths of [[90, 100], [80, 100], [120, 100], [60, 100]]) {
    const times = [];
    for (const width of widths) {
      const start = performance.now();
      let requests = 0, last;
      do { last = await direct(socket, view(pane, 2000, H, width)); requests++; if (last.json.settling) await sleep(30); } while (last.json.settling && requests < 60);
      times.push({ width, ms: performance.now() - start, requests, firstMs: 0, total: last.json.total });
    }
    results[`${pane} resize ${widths.join("->")}`] = times;
    console.log(`${pane} resize to ${widths[0]} cols: ${times[0].ms.toFixed(0)} ms in ${times[0].requests} request(s), total rows ${times[0].total}; back to ${widths[1]}: ${times[1].ms.toFixed(0)} ms in ${times[1].requests}`);
  }
}
if (out) writeFileSync(out, JSON.stringify(results, null, 2));

async function seq(n, fn) { const samples = []; for (let i = 0; i < n; i++) samples.push(await fn()); return samples; }
