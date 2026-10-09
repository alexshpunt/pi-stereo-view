import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");

async function fallbackRun(name: string, cols: number, mode: string, incompatible = false): Promise<string> {
  const cwd = await mkdtemp(path.resolve("tmp/fallback-"));
  directories.push(cwd);
  await new PiIntegrationTest({
    testName: name,
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: true,
    environment: { PI_TRANSCRIPT_TEST_MODE: mode },
    rawMode: false,
    tuiSize: { cols, rows: 35 },
    extensions: [
      ...(incompatible ? [path.resolve("test/fixtures/incompatible-layout.ts")] : []),
      path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts"),
    ],
    tools: [],
    conversation: [assistantMessage([text("ANSWER MARKER")])],
  }).run("USER MARKER");
  return clean(JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8")));
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test("routes native text and tools into separate history panels without changing execution", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/workspace-"));
  directories.push(cwd);
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({
    tuiMode: "fullscreen", hideThinkingBlock: false, quietStartup: true,
  }));
  const result = await new PiIntegrationTest({
    testName: "native-split",
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: true,
    rawMode: false,
    tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
    tools: ["write"],
    conversation: [
      assistantMessage([
        text("COMMENT MARKER", { chunks: { kind: "fixed", size: 3 } }),
        toolCall({ id: "native-write", name: "write", arguments: { path: "result.txt", content: "actual effect" } }),
      ], { stopReason: "toolUse" }),
      assistantMessage([text("ANSWER MARKER")]),
    ],
  }).run("USER MARKER");

  expect(await readFile(path.join(cwd, "result.txt"), "utf8")).toBe("actual effect");
  expect(getToolExecution(result, "native-write").isError).toBe(false);
  const lines: string[] = JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8"));
  const screen = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  expect(screen).toContain("Activity");
  expect(screen).toContain("Conversation");
  const splitLines = screen.split("\n").filter(line => line.includes("│"));
  const activity = splitLines.map(line => line.split("│")[0]).join("\n");
  const chat = splitLines.map(line => line.split("│").slice(1).join("│")).join("\n");
  expect(activity).toContain("NATIVE CALL MARKER");
  expect(activity).toContain("NATIVE RESULT MARKER");
  expect(activity).toContain("THINKING MARKER");
  expect(activity).not.toContain("COMMENT MARKER");
  expect(activity).not.toContain("ANSWER MARKER");
  expect(chat).toContain("USER MARKER");
  expect(chat).toContain("COMMENT MARKER");
  expect(chat).toContain("ANSWER MARKER");
  expect(chat).not.toContain("NATIVE CALL MARKER");
  expect(chat).not.toContain("THINKING MARKER");
});

test("drags, swaps, restores native combined history, and remembers settings on restart", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/controls-"));
  const agent = await mkdtemp(path.resolve("tmp/agent-"));
  directories.push(cwd, agent);
  const run = (name: string, controls: boolean) => new PiIntegrationTest({
    testName: name,
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_PROBE_CONTROLS: controls ? "1" : "0" },
    rawMode: false,
    tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
    tools: [],
    conversation: [assistantMessage([text("ANSWER MARKER")])],
  }).run("USER MARKER");
  await run("layout-controls", true);
  const frames: string[][] = JSON.parse(await readFile(path.join(cwd, "control-frames.json"), "utf8"));
  expect(clean(frames[0])).toContain("Activity");
  expect(frames[0][0].indexOf("Activity")).toBeLessThan(frames[0][0].indexOf("Conversation"));
  expect(frames[1][0].indexOf("Conversation")).toBeLessThan(frames[1][0].indexOf("Activity"));
  expect(clean([frames[4][0]]).indexOf("│")).toBe(32);
  expect(clean([frames[5][0]]).indexOf("│")).toBe(36);
  expect(clean(frames[6])).not.toContain("Conversation");
  expect(clean(frames[6])).toContain("ANSWER MARKER");

  const preferences = JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"));
  expect(preferences).toEqual({ mode: "split", side: "left", chatWidth: 36 });
  expect(frames.map(frame => clean(frame).includes("Conversation")))
    .toEqual([true, true, true, true, true, true, false, true, true, true, true]);
  await run("layout-restart", false);
  const restored: string[] = JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8"));
  expect(restored[0].indexOf("Conversation")).toBeLessThan(restored[0].indexOf("Activity"));
  expect(clean([restored[0]]).indexOf("│")).toBe(36);
  const dock = restored.slice(-5).map(line => clean([line]));
  expect(dock.filter(line => line.includes("│"))).toHaveLength(0);
  expect(dock.some(line => line.includes("─".repeat(120)))).toBe(true);
});

test.each([[40, "fullscreen"], [120, "regular"]])("keeps native combined history at %i columns in %s mode", async (cols, mode) => {
  const screen = await fallbackRun("fallback-" + mode, Number(cols), String(mode));
  expect(screen).toContain("USER MARKER");
  expect(screen).toContain("ANSWER MARKER");
  expect(screen).not.toContain("Conversation");
  expect(screen).not.toContain("Activity");
});

test("refuses an unknown fullscreen layout once and leaves its native history usable", async () => {
  const screen = await fallbackRun("incompatible-layout", 120, "fullscreen", true);
  expect(screen).toContain("USER MARKER");
  expect(screen).toContain("ANSWER MARKER");
  expect(screen).not.toContain("Conversation");
  expect(screen.split("Pi's fullscreen layout is not supported.")).toHaveLength(2);
});

test("resumes native history and shows only the selected session branch", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/session-"));
  directories.push(cwd);
  const saved = path.join(cwd, "recorded-session.jsonl");
  const run = async (name: string, answer: string, resumed: boolean): Promise<string> => {
    await new PiIntegrationTest({
      testName: name,
      artifactsDir: path.resolve("tmp/test-runs"),
      cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"),
      isolateUserResources: true,
      environment: { PI_TRANSCRIPT_TEST_SESSION: resumed ? saved : "" },
      rawMode: false,
      tuiSize: { cols: 120, rows: 35 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
      tools: [],
      conversation: [assistantMessage([text(answer)])],
    }).run("USER MARKER");
    return clean(JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8")));
  };
  await run("session-original", "ORIGINAL ANSWER", false);
  const resumed = await run("session-resumed", "ABANDONED ANSWER", true);
  expect(resumed).toContain("ORIGINAL ANSWER");
  expect(resumed).toContain("ABANDONED ANSWER");
  const manager = SessionManager.open(saved);
  const user = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
  expect(user).toBeDefined();
  manager.branchWithSummary(user!.id, "SELECTED BRANCH SUMMARY");
  const selected = await run("session-selected-branch", "SELECTED ANSWER", true);
  expect(selected).toContain("SELECTED ANSWER");
  expect(selected).toContain("SELECTED BRANCH SUMMARY");
  expect(selected).not.toContain("ABANDONED ANSWER");
  expect(selected).not.toContain("ORIGINAL ANSWER");
});

test("keeps selection, copy, and mouse scrolling inside the chosen native pane", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/selection-"));
  directories.push(cwd);
  await new PiIntegrationTest({
    testName: "selection-and-scrolling",
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: true,
    environment: { TRANSCRIPT_PROBE_SELECTION: "1" },
    rawMode: false,
    tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
    tools: ["write"],
    conversation: [
      assistantMessage([toolCall({ id: "selection-write", name: "write", arguments: { path: "result.txt", content: "effect" } })], { stopReason: "toolUse" }),
      assistantMessage([text(Array.from({ length: 45 }, (_, index) => "Chat line " + index).join("\n\n") + "\n\nCHAT_COPY_MARKER")]),
    ],
  }).run("USER MARKER");
  const observation: { copied: string[]; beforeWheel: string[]; activityWheel: string[]; chatWheel: string[] } =
    JSON.parse(await readFile(path.join(cwd, "selection-observation.json"), "utf8"));
  expect(observation.copied).toContain("CHAT_COPY_MARKER");
  expect(observation.copied).toContain("NATIVE CALL MARKER");
  expect(observation.copied.every(value => value === "CHAT_COPY_MARKER" || value === "NATIVE CALL MARKER")).toBe(true);
  const pane = (frame: string[], column: number) => frame.slice(1, -6)
    .map(line => stripTerminalSequences(sliceByColumn(line, column === 0 ? 0 : 80, column === 0 ? 78 : 39)))
    .join("\n");
  expect(pane(observation.activityWheel, 0)).not.toBe(pane(observation.beforeWheel, 0));
  expect(pane(observation.activityWheel, 1)).toBe(pane(observation.beforeWheel, 1));
  expect(pane(observation.chatWheel, 0)).toBe(pane(observation.activityWheel, 0));
  expect(pane(observation.chatWheel, 1)).not.toBe(pane(observation.activityWheel, 1));
});
