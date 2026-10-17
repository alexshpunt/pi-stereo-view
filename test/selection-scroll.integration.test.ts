import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// This cross-extension check is opt-in; the package suite needs only the published Pi host.
const ide = process.env.PI_STEREO_VIEW_IDE_PATH ?? "";
const git = (...args: string[]) => execFileSync("git", ["-C", ide, ...args], { encoding: "utf8" }).trim();
type Observation = {
  direction: number; before: number; first: number; held: number; inside: number; insideHeld: number;
  released: number; afterRelease: number; otherBefore: number; otherAfter: number; copied: string; frame: string[];
  firstCopy: string; heldCopy: string;
};

test.skipIf(!ide).each(["columns", "rows"])("scrolls a held selection at both edges without dispatching to off-screen content in %s", async layout => {
  const sourceCommit = git("rev-parse", "HEAD");
  const version = JSON.parse(await readFile(path.join(ide, "package.json"), "utf8")).version;
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/selection-scroll-"));
  const agent = await mkdtemp(path.resolve("tmp/selection-scroll-agent-"));
  const testName = "selection-scroll-" + layout;
  const artifact = path.resolve("tmp/test-runs", testName);
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, fullscreenCopyOnSelect: false }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ mode: "split", side: "left", chatWidth: 45,
      layout, chatHeight: 12, zoom: null, showTimestamps: true }));
    const result = await new PiIntegrationTest({
      testName, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_IDE_PATH: ide },
      rawMode: false, tuiSize: { cols: 120, rows: 35 }, timeoutMs: 120_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/selection-scroll-probe.ts")],
      tools: ["write"], conversation: [
        assistantMessage([toolCall({ id: "selection-tool", name: "write", arguments: { path: "result.txt", content: "effect" } })], { stopReason: "toolUse" }),
        assistantMessage([text(Array.from({ length: 100 }, (_, i) => "Conversation line " + i).join("\n"), { chunks: { kind: "fixed", size: 5000 } })]),
      ],
    }).run("Select history beyond the visible panel");
    expect(result.exitCode).toBe(0);
    await writeFile(path.join(artifact, "runtime.json"), JSON.stringify({ ide: { path: ide, version, sourceCommit } }, null, 2));
    const observations: Observation[] = JSON.parse(await readFile(path.join(cwd, "selection-scroll.json"), "utf8"));
    await writeFile(path.join(artifact, "observations.json"), JSON.stringify(observations, null, 2));
    expect(observations).toHaveLength(4);
    for (const observation of observations) {
      expect((observation.first - observation.before) * observation.direction, JSON.stringify(observation)).toBeGreaterThan(0);
      expect((observation.held - observation.first) * observation.direction).toBeGreaterThan(0);
      expect(observation.insideHeld).toBe(observation.inside);
      expect(observation.afterRelease).toBe(observation.released);
      expect(observation.otherAfter).toBe(observation.otherBefore);
      expect(observation.copied).toMatch(/(?:Conversation|Activity) line/);
      expect(observation.heldCopy.length).toBeGreaterThan(observation.firstCopy.length);
      expect(observation.copied.includes("Conversation line") && observation.copied.includes("Activity line")).toBe(false);
    }
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 150_000);
