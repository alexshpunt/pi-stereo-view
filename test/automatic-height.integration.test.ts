import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";

type Sample = { lines: string[]; height: number; available: number; contentRows: number };
const directories: string[] = [];
beforeAll(async () => { await mkdir(path.resolve("tmp"), { recursive: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test.each(["left", "right"])("grows to half the history, then scrolls, and keeps a manual drag on restart with chat %s", async side => {
  const cwd = await mkdtemp(path.resolve("tmp/automatic-height-"));
  const agent = await mkdtemp(path.resolve("tmp/automatic-height-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  const file = path.join(agent, "transcript.json");
  await writeFile(file, JSON.stringify({
    mode: "split", layout: "rows", side, chatWidth: 40,
    chatHeight: side === "right" ? null : undefined, zoom: null, showTimestamps: true,
  }));
  const answer = Array.from({ length: 60 }, (_, index) => "Height line " + index).join("\n");
  const run = (phase: string, rows: number) => new PiIntegrationTest({
    testName: "automatic-height-" + side + "-" + phase, artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, AUTO_HEIGHT_PHASE: phase, PI_INTEGRATION_TEST_LIVE: "1" },
    // Cold extension loading shares this deadline with the scripted stream.
    timeoutMs: 60_000, rawMode: false, tuiSize: { cols: 120, rows },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/automatic-height-probe.ts")],
    tools: [], conversation: [assistantMessage([text(answer, { chunks: { kind: "fixed", size: 12 }, delayMs: 15 })])],
  }).run("HEIGHT USER");
  const first = await run("drag", 35);
  expect(first.providerRequests).toHaveLength(1);
  const samples: Record<string, Sample> = JSON.parse(await readFile(path.join(cwd, "automatic-height-drag.json"), "utf8"));
  await writeFile(path.resolve("tmp/test-runs", "automatic-height-" + side + "-drag", "height-samples.json"), JSON.stringify(samples));
  // The initial user-only frame is captured before assistant streaming can coalesce updates.
  expect(samples.initial.height).toBeLessThan(samples.final.height);
  // Streaming updates may share a native frame. Check the content actually
  // painted, rather than assuming each threshold produces its own frame.
  for (const name of ["initial", "growth1", "growth3", "growth10", "growth25"]) {
    const sample = samples[name];
    const header = side === "left" ? 3 : 2;
    expect(sample.height, name + " must fit its native content up to half history")
      .toBe(Math.max(4, Math.min(header + sample.contentRows, Math.floor(sample.available / 2))));
  }
  for (const name of ["growth25", "final"]) {
    expect(samples[name].height).toBe(Math.floor(samples[name].available / 2));
    expect(samples[name].height).toBeLessThanOrEqual(samples[name].available / 2);
  }
  expect(samples.final.lines.map(stripTerminalSequences).join("\n")).toContain("Height line 59");
  const manual = samples.final.height + 4;
  expect(samples.manual.height).toBe(manual);
  expect(JSON.parse(await readFile(file, "utf8")).chatHeight).toBe(manual);
  const second = await run("reset", 45);
  expect(second.providerRequests).toHaveLength(1);
  const reset: Record<string, Sample> = JSON.parse(await readFile(path.join(cwd, "automatic-height-reset.json"), "utf8"));
  expect(reset.final.height).toBe(manual);
  expect(reset.autoCommand.height).toBe(Math.floor(reset.autoCommand.available / 2));
  expect(reset.settings.lines.map(stripTerminalSequences).join("\n")).toMatch(/Conversation height\s+auto/);
  expect(reset.manualSetting.lines.map(stripTerminalSequences).join("\n")).toMatch(/Conversation height\s+manual/);
  expect(reset.autoSetting.lines.map(stripTerminalSequences).join("\n")).toMatch(/Conversation height\s+auto/);
  expect(JSON.parse(await readFile(file, "utf8")).chatHeight).toBeNull();
}, 150_000);
