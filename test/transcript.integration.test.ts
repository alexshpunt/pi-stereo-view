import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall,
} from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";

beforeAll(async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
});

const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");
const splitHeader = (lines: string[]): string => {
  const header = lines.map(stripTerminalSequences).find(line =>
    line.includes("Activity") && line.includes("Conversation") && line.includes("║"));
  expect(header, "both native pane headers must share the column divider").toBeDefined();
  return header!;
};

async function fallbackRun(name: string, cols: number, mode: string, incompatible = false): Promise<string> {
  const cwd = await mkdtemp(path.resolve("tmp/fallback-"));
  directories.push(cwd);
  const agent = await columnAgent();
  await new PiIntegrationTest({
    testName: name,
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_MODE: mode },
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
// These regression cases exercise an explicitly chosen column arrangement.
async function columnAgent(): Promise<string> {
  const agent = await mkdtemp(path.resolve("tmp/column-agent-"));
  directories.push(agent);
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "right", chatWidth: 40, layout: "columns", chatHeight: 12, zoom: null,
  }));
  return agent;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test("routes native text and tools into separate history panels without changing execution", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/workspace-"));
  directories.push(cwd);
  const agent = await columnAgent();
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({
    tuiMode: "fullscreen", hideThinkingBlock: false, quietStartup: true,
  }));
  const result = await new PiIntegrationTest({
    testName: "native-split",
    environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_PROBE_CONTROLS: "1" },
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
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
  const splitLines = screen.split("\n").filter(line => line.includes("║"));
  const activity = splitLines.map(line => line.split("║")[0]).join("\n");
  const chat = splitLines.map(line => line.split("║").slice(1).join("║")).join("\n");
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
  const frames: string[][] = JSON.parse(await readFile(path.join(cwd, "control-frames.json"), "utf8"));
  const initiallyExpanded = clean(frames[0]).includes("NATIVE RESULT MARKER expanded");
  expect(clean(frames[8])).toContain("NATIVE RESULT MARKER " + (initiallyExpanded ? "collapsed" : "expanded"));
  expect(clean(frames[9])).not.toContain("THINKING MARKER");
  expect(clean(frames[10])).toContain("THINKING MARKER");
  expect(result.providerRequests).toHaveLength(2);
});

test("drags, swaps, restores native combined history, and remembers settings on restart", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/controls-"));
  const agent = await columnAgent();
  directories.push(cwd);
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
  expect(splitHeader(frames[0]).indexOf("Activity")).toBeLessThan(splitHeader(frames[0]).indexOf("Conversation"));
  expect(splitHeader(frames[1]).indexOf("Conversation")).toBeLessThan(splitHeader(frames[1]).indexOf("Activity"));
  expect(splitHeader(frames[4]).indexOf("║")).toBe(32);
  expect(splitHeader(frames[5]).indexOf("║")).toBe(36);
  expect(clean(frames[6])).not.toContain("Conversation");
  expect(clean(frames[6])).toContain("ANSWER MARKER");

  const preferences = JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"));
  expect(preferences).toEqual({ side: "left", chatWidth: 36, layout: "columns", chatHeight: 12, showTimestamps: true, showCopyButtons: true, compactTools: false });
  expect(frames.map(frame => clean(frame).includes("Conversation")))
    .toEqual([true, true, true, true, true, true, false, true, true, true, true]);
  await run("layout-restart", false);
  const restored: string[] = JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8"));
  expect(splitHeader(restored).indexOf("Conversation")).toBeLessThan(splitHeader(restored).indexOf("Activity"));
  expect(splitHeader(restored).indexOf("║")).toBe(36);
  const dock = restored.slice(-5).map(line => clean([line]));
  expect(dock.filter(line => line.includes("║"))).toHaveLength(0);
  expect(dock.some(line => line.includes("─".repeat(120)))).toBe(true);
});

test("changes layout during streaming and restores the requested split after a live resize", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/dynamic-"));
  directories.push(cwd);
  const agent = await columnAgent();
  const result = await new PiIntegrationTest({
    testName: "streaming-controls-and-resize",
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_PROBE_DYNAMIC: "1" },
    rawMode: false,
    tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
    tools: [],
    conversation: [assistantMessage([text("STREAM MARKER completed.", {
      chunks: { kind: "fixed", size: 3 }, delayMs: 20,
    })])],
  }).run("USER MARKER");
  const observed: {
    streamingFrames: { idle: boolean; lines: string[] }[];
    widthFrames: string[][];
    modeFrames: { mode: string; lines: string[] }[];
  } = JSON.parse(await readFile(path.join(cwd, "dynamic-observation.json"), "utf8"));
  expect(observed.streamingFrames).toHaveLength(4);
  expect(result.providerRequests).toHaveLength(1);
  expect(observed.streamingFrames.every(frame => !frame.idle)).toBe(true);
  expect(observed.streamingFrames.map(frame => clean(frame.lines).includes("Conversation")))
    .toEqual([false, true, true, true]);
  const streamed = clean(observed.streamingFrames[3].lines);
  expect(streamed.indexOf("Conversation")).toBeLessThan(streamed.indexOf("Activity"));
  expect(splitHeader(observed.streamingFrames[3].lines).indexOf("║")).toBe(44);
  const [wide, narrow, restored] = observed.widthFrames.map(clean);
  expect(wide).toContain("Conversation");
  expect(narrow).not.toContain("Conversation");
  expect(narrow).toContain("USER MARKER");
  expect(narrow).toContain("STREAM MARKER completed.");
  expect(restored).toContain("Conversation");
  expect(restored.match(/STREAM MARKER completed\./g)).toHaveLength(1);
  expect(splitHeader(observed.widthFrames[2]).indexOf("║")).toBe(44);
  expect(splitHeader(observed.widthFrames[2]).indexOf("Conversation"))
    .toBeLessThan(splitHeader(observed.widthFrames[2]).indexOf("Activity"));
  expect(observed.modeFrames.map(frame => frame.mode)).toEqual(["regular", "fullscreen"]);
  expect(clean(observed.modeFrames[0].lines)).not.toContain("Conversation");
  const remounted = clean(observed.modeFrames[1].lines);
  expect(remounted.match(/Conversation/g)).toHaveLength(1);
  expect(remounted.match(/STREAM MARKER completed\./g)).toHaveLength(1);
  expect(splitHeader(observed.modeFrames[1].lines).indexOf("║")).toBe(44);
});

test("does not pull a reader back to the bottom when more text streams", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/reading-"));
  directories.push(cwd);
  const agent = await columnAgent();
  const result = await new PiIntegrationTest({
    testName: "reading-during-streaming",
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_PROBE_READING: "1" },
    rawMode: false,
    tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
    tools: [],
    conversation: [assistantMessage([text(Array.from({ length: 45 }, (_, index) => "Reading line " + index).join("\n\n"), {
      chunks: { kind: "fixed", size: 75 }, delayMs: 10,
    })])],
  }).run("USER MARKER");
  const observed: { paused: string[]; finished: string[] } =
    JSON.parse(await readFile(path.join(cwd, "reading-observation.json"), "utf8"));
  const readingWindow = (frame: string[]) => frame.slice(1, 12)
    .map(line => stripTerminalSequences(sliceByColumn(line, 80, 38, true)));
  expect(readingWindow(observed.finished)).toEqual(readingWindow(observed.paused));
  expect(clean(observed.finished)).not.toContain("Reading line 44");
  expect(JSON.stringify(result.messages)).toContain("Reading line 44");
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
  const agent = await columnAgent();
  const saved = path.join(cwd, "recorded-session.jsonl");
  const run = async (name: string, answer: string, resumed: boolean): Promise<string> => {
    await new PiIntegrationTest({
      testName: name,
      artifactsDir: path.resolve("tmp/test-runs"),
      cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"),
      isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: resumed ? saved : "" },
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

test.each(["columns", "rows"])("keeps selection, copy, and independent scrolling in %s", async layout => {
  const cwd = await mkdtemp(path.resolve("tmp/selection-"));
  const agent = await mkdtemp(path.resolve("tmp/selection-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "right", chatWidth: 40, layout, chatHeight: 12, zoom: null,
  }));
  await new PiIntegrationTest({
    testName: "selection-and-scrolling-" + layout,
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_PROBE_SELECTION: "1" },
    timeoutMs: 120_000,
    rawMode: false,
    tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
    tools: ["write"],
    conversation: [
      assistantMessage([toolCall({ id: "selection-write", name: "write", arguments: { path: "result.txt", content: "effect" } })], { stopReason: "toolUse" }),
      assistantMessage([text(Array.from({ length: 45 }, (_, index) => "Chat line " + index).join("\n\n") + "\n\nCHAT_COPY_MARKER",
        { chunks: { kind: "fixed", size: 5000 } })]),
    ],
  }).run("USER MARKER");
  const observation: {
    copied: string[]; beforeWheel: string[]; activityWheel: string[]; chatWheel: string[]; headerWheel: string[];
    chatPage: string[]; activityPage: string[]; cycledBack: string[];
  } =
    JSON.parse(await readFile(path.join(cwd, "selection-observation.json"), "utf8"));
  expect(observation.copied).toContain("CHAT_COPY_MARKER");
  expect(observation.copied).toContain("NATIVE CALL MARKER");
  expect(observation.copied.every(value => value === "CHAT_COPY_MARKER" || value === "NATIVE CALL MARKER")).toBe(true);
  // Pi draws its jump-to-latest indicator over the active panel's last row, scrollbar included;
  // compare panel content without the indicator and scrollbar column.
  const content = (text: string): string => text.replace(/ ↓ Jump to latest message.*$/gm, "").replace(/ *[│┃]? *$/gm, "");
  const pane = (frame: string[], column: number): string => {
    if (layout === "columns") return content(frame.slice(4, -6)
      .map(line => stripTerminalSequences(sliceByColumn(line, column === 0 ? 0 : 80, column === 0 ? 78 : 39)))
      .join("\n"));
    const chatHeader = frame.findIndex(line => stripTerminalSequences(line).includes("Conversation"));
    expect(chatHeader).toBeGreaterThan(1);
    return content(clean(column === 0 ? frame.slice(4, chatHeader - 1) : frame.slice(chatHeader + 2, -6)));
  };
  // Activity tracking changes headers, not the other panel's document or scroll position.
  expect(clean(observation.activityWheel)).toContain("● Activity");
  expect(clean(observation.chatWheel)).toContain("● Conversation");
  expect(pane(observation.activityWheel, 0)).not.toBe(pane(observation.beforeWheel, 0));
  expect(pane(observation.activityWheel, 1)).toBe(pane(observation.beforeWheel, 1));
  expect(pane(observation.chatWheel, 0)).toBe(pane(observation.activityWheel, 0));
  expect(pane(observation.chatWheel, 1)).not.toBe(pane(observation.activityWheel, 1));
  // Wheel over the Conversation header moves Conversation, never Activity.
  expect(pane(observation.headerWheel, 0)).toBe(pane(observation.chatWheel, 0));
  expect(pane(observation.headerWheel, 1)).not.toBe(pane(observation.chatWheel, 1));
  // Page keys scroll the active panel; Ctrl+Alt+Up switches it, and pressing it again switches back.
  expect(pane(observation.chatPage, 0)).toBe(pane(observation.headerWheel, 0));
  expect(pane(observation.chatPage, 1)).not.toBe(pane(observation.headerWheel, 1));
  expect(clean(observation.activityPage)).toContain("● Activity");
  expect(pane(observation.activityPage, 0)).not.toBe(pane(observation.chatPage, 0));
  expect(pane(observation.activityPage, 1)).toBe(pane(observation.chatPage, 1));
  expect(clean(observation.cycledBack)).toContain("● Conversation");
}, 150_000);
