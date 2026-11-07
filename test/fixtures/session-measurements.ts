import { writeFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Session profile: process CPU and event-loop delay while the scripted agent streams. */
export default function measure(pi: ExtensionAPI): void {
  let start: { cpu: NodeJS.CpuUsage; at: number } | undefined;
  const delay = monitorEventLoopDelay({ resolution: 5 });
  let writes = 0;
  let bytes = 0;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (start) { writes++; bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length; }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  // Restored histories exceed the scripted model's context. Compaction would send the
  // scripted answers to its summarizer and replace the history being measured.
  pi.on("session_before_compact", () => ({ cancel: true }));
  pi.on("agent_start", () => {
    delay.reset(); delay.enable();
    start = { cpu: process.cpuUsage(), at: performance.now() };
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (!start) return;
    delay.disable();
    const cpu = process.cpuUsage(start.cpu);
    const elapsed = performance.now() - start.at;
    const ms = (value: number): number => Math.round(value / 1e4) / 100;
    await writeFile(path.join(ctx.cwd, "session-measurements.json"), JSON.stringify({
      elapsedMs: Math.round(elapsed), cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      cpuPercent: Math.round((cpu.user + cpu.system) / 10 / elapsed), writes, bytes,
      loopDelayMs: { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max) },
      historyEntries: ctx.sessionManager.getEntries().length,
    }));
    start = undefined;
  });
}
