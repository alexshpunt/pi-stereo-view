import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Profiler } from "node:inspector";

/** Summarize V8 samples without discarding the raw profile used as evidence. */
async function summarize(directory: string): Promise<void> {
  const profile: Profiler.Profile = JSON.parse(await readFile(path.join(directory, process.env.PROFILE_PHASE ? process.env.PROFILE_PHASE + ".cpuprofile" : "rendering.cpuprofile"), "utf8"));
  const measurements = JSON.parse(await readFile(path.join(directory, "measurements.json"), "utf8"));
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const times = new Map<string, { name: string; url: string; line: number; selfMs: number; inclusiveMs: number }>();
  const keyFor = (node: Profiler.ProfileNode): string => {
    const frame = node.callFrame;
    const key = JSON.stringify([frame.functionName, frame.url, frame.lineNumber]);
    if (!times.has(key)) times.set(key, { name: frame.functionName || "(anonymous)", url: frame.url, line: frame.lineNumber + 1, selfMs: 0, inclusiveMs: 0 });
    return key;
  };
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const node = nodes.get(profile.samples![index]);
    if (!node) continue;
    const duration = (profile.timeDeltas?.[index] ?? 0) / 1000;
    times.get(keyFor(node))!.selfMs += duration;
    const visited = new Set<string>();
    let current: Profiler.ProfileNode | undefined = node;
    while (current) {
      const key = keyFor(current);
      if (!visited.has(key)) times.get(key)!.inclusiveMs += duration;
      visited.add(key);
      const parent = parents.get(current.id);
      current = parent === undefined ? undefined : nodes.get(parent);
    }
  }
  const functions = [...times.values()];
  const bySelf = functions.sort((a, b) => b.selfMs - a.selfMs).slice(0, 20);
  const transcript = functions.filter(frame => /\/src\/(native|timestamps|layout|search|render-cache)\.ts/.test(frame.url))
    .sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 20);
  console.log(JSON.stringify({ directory, summary: measurements.summary,
    sampledMs: (profile.timeDeltas ?? []).reduce((sum, value) => sum + value, 0) / 1000,
    topSelf: bySelf, transcriptInclusive: transcript }, null, 2));
}

if (!process.argv[2]) throw new Error("Pass one or more profiling artifact directories");
for (const directory of process.argv.slice(2)) await summarize(path.resolve(directory));
