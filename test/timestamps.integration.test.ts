import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";

const directories: string[] = [];
const utcTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map(value => String(value).padStart(2, "0")).join(":");
};
const timeAbove = (lines: string[], marker: string, row = lines.findIndex(line => line.includes(marker))): string => {
  expect(row, "Native content must be visible: " + marker).toBeGreaterThanOrEqual(0);
  const previous = lines.slice(Math.max(0, row - 6), row).reverse()
    .map(line => line.replace(/[┃│]$/, ""))
    .find(line => /^\s+(?:~?\d{2}:\d{2}:\d{2}|--:--:--)\s*$/.test(line));
  expect(previous, "A separate left-aligned timestamp must precede " + marker + "\n" +
    lines.slice(Math.max(0, row - 6), row + 1).join("\n")).toBeDefined();
  // The clock header has a one-cell inset; the rest of its row remains available.
  expect(previous!.length - previous!.trimStart().length).toBe(1);
  return previous!.trim();
};

beforeAll(async () => { await mkdir(path.resolve("tmp"), { recursive: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test("shows original message times and a persisted tool-start row above native content", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/timestamps-"));
  const agent = await mkdtemp(path.resolve("tmp/timestamp-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "right", chatWidth: 40, layout: "columns", chatHeight: 12, zoom: null,
  }));
  const result = await new PiIntegrationTest({
    testName: "native-timestamps", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC" },
    rawMode: false, tuiSize: { cols: 120, rows: 45 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
    tools: ["write"],
    conversation: [
      assistantMessage([toolCall({ id: "timestamp-write", name: "write", arguments: {
        path: "effect.txt", content: "real effect",
      } })], { stopReason: "toolUse" }),
      assistantMessage([text("ANSWER MARKER")]),
    ],
  }).run("USER MARKER");
  expect(getToolExecution(result, "timestamp-write").isError).toBe(false);
  expect(await readFile(path.join(cwd, "effect.txt"), "utf8")).toBe("real effect");
  expect(result.providerRequests).toHaveLength(2);
  const frame: string[] = JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8"));
  const activity = frame.slice(2, -6).map(line => stripTerminalSequences(sliceByColumn(line, 0, 79)));
  const chat = frame.slice(2, -6).map(line => stripTerminalSequences(sliceByColumn(line, 80, 40)));
  const messages = result.messages.filter((message): message is { role: string; timestamp: number } =>
    typeof message === "object" && message !== null &&
    "role" in message && typeof message.role === "string" &&
    "timestamp" in message && typeof message.timestamp === "number");
  const user = messages.find(message => message.role === "user");
  const answers = messages.filter(message => message.role === "assistant");
  expect(user).toBeDefined();
  expect(timeAbove(chat, "USER MARKER")).toBe(utcTime(user!.timestamp));
  expect(timeAbove(chat, "ANSWER MARKER")).toBe(utcTime(answers.at(-1)!.timestamp));
  expect(timeAbove(activity, "THINKING MARKER")).toBe(utcTime(answers[0].timestamp));
  const session = SessionManager.open(path.join(cwd, "recorded-session.jsonl"));
  const starts = session.getBranch().filter(entry =>
    entry.type === "custom" && entry.customType === "pi-agent-transcript/tool-start");
  expect(starts).toHaveLength(1);
  const start = starts[0];
  if (start.type !== "custom") throw new Error("Expected display-only session metadata");
  const data = start.data as { toolCallId: string; time: number };
  expect(data.toolCallId).toBe("timestamp-write");
  expect(Number.isFinite(data.time)).toBe(true);
  expect(timeAbove(activity, "NATIVE CALL MARKER")).toBe(utcTime(data.time));
  expect(JSON.stringify(result.providerRequests)).not.toContain("pi-agent-transcript/tool-start");
  expect(JSON.stringify(result.messages)).not.toContain("pi-agent-transcript/tool-start");
});

const workspace = async (): Promise<{ cwd: string; agent: string }> => {
  const cwd = await mkdtemp(path.resolve("tmp/timestamp-case-"));
  const agent = await mkdtemp(path.resolve("tmp/timestamp-agent-"));
  directories.push(cwd, agent);
  return { cwd, agent };
};
const clean = (lines: string[]): string[] => lines.map(stripTerminalSequences);
const panes = (lines: string[]): { chat: string[]; activity: string[] } => ({
  activity: lines.slice(2, -6).map(line => stripTerminalSequences(sliceByColumn(line, 0, 79))),
  chat: lines.slice(2, -6).map(line => stripTerminalSequences(sliceByColumn(line, 80, 40))),
});

test("keeps native compaction in Conversation and classic Combined while retaining split clocks", async () => {
  const { cwd, agent } = await workspace();
  const manager = SessionManager.create(cwd, cwd);
  const kept = manager.appendMessage({ role: "user", content: "KEPT USER", timestamp: Date.parse("2001-10-09T10:02:03Z") });
  manager.appendCompaction("SAVED COMPACTION CONTEXT", kept, 12345);
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "combined", side: "right", chatWidth: 40, layout: "columns",
    chatHeight: 32, zoom: null, showTimestamps: true,
  }));
  const run = await new PiIntegrationTest({
    testName: "compaction-routing", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: manager.getSessionFile()!,
      TIMESTAMP_LAYOUTS: "1", TIMESTAMP_COMPACTION: "1", TZ: "UTC" },
    rawMode: false, tuiSize: { cols: 120, rows: 85 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: [], conversation: [assistantMessage([text("CURRENT ANSWER")])],
  }).run("CURRENT USER");
  expect(run.providerRequests).toHaveLength(1);
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  const { chat, activity } = panes(frames.columns);
  await writeFile(path.resolve("tmp/test-runs/compaction-routing/frames.json"), JSON.stringify(frames, null, 2));
  await writeFile(path.resolve("tmp/test-runs/compaction-routing/session.jsonl"),
    await readFile(path.join(cwd, "timestamp-session.jsonl"), "utf8"));
  expect(chat.join("\n")).toContain("[compaction]");
  expect(chat.join("\n")).toContain("Session compacted");
  expect(activity.join("\n")).not.toContain("Session compacted");
  expect(activity.join("\n")).not.toContain("[compaction]");
  expect(clean(frames.chat).join("\n")).toContain("[compaction]");
  expect(clean(frames.chatExpanded).join("\n")).toContain("SAVED COMPACTION CONTEXT");
  expect(frames.compactionExpanded).toEqual(["true"]);
  expect(clean(frames.chatCollapsed).join("\n")).not.toContain("SAVED COMPACTION CONTEXT");
  expect(clean(frames.chatCollapsed).join("\n")).toContain("[compaction]");
  expect(clean(frames.activity).join("\n")).not.toContain("[compaction]");
  const rows = clean(frames.rows);
  const activityHeader = rows.findIndex(line => line.includes("Activity") && line.includes("[ ↗ ]"));
  const chatHeader = rows.findIndex(line => line.includes("Conversation") && line.includes("[ ↗ ]"));
  expect(rows.slice(activityHeader, chatHeader).join("\n")).not.toContain("[compaction]");
  expect(rows.slice(chatHeader).join("\n")).toContain("[compaction]");
  expect(timeAbove(chat, "CURRENT USER")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  expect(timeAbove(clean(frames.rowsRestored), "CURRENT USER")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  for (const name of ["combined", "classicAgain"]) {
    expect(clean(frames[name]).join("\n")).toContain("[compaction]");
    expect(clean(frames[name]).join("\n")).not.toMatch(/\d{2}:\d{2}:\d{2}|--:--:--/);
    expect(frames[name + "NativeChild"]).toEqual(["Container"]);
  }
  expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8")).showTimestamps).toBe(true);
});
test("keeps observed tool-start time stable through partial output and streamed answers", async () => {
  const { cwd, agent } = await workspace();
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "right", chatWidth: 40, layout: "columns", chatHeight: 12, zoom: null,
  }));
  const result = await new PiIntegrationTest({
    testName: "streamed-timestamps", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC", TIMESTAMP_STREAM: "1" },
    rawMode: false, tuiSize: { cols: 120, rows: 45 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: ["clock_probe"],
    conversation: [
      assistantMessage([toolCall({ id: "clock-start", name: "clock_probe", arguments: {} })], { stopReason: "toolUse" }),
      assistantMessage([text("STREAMED ANSWER MARKER", { chunks: { kind: "fixed", size: 4 }, delayMs: 20 })]),
    ],
  }).run("USER MARKER");
  expect(getToolExecution(result, "clock-start").isError).toBe(false);
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  const time = timeAbove(panes(frames.started).activity, "CLOCK CALL MARKER");
  expect(time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  for (const stage of ["partial", "later", "finished"]) {
    expect(timeAbove(panes(frames[stage]).activity, "CLOCK CALL MARKER")).toBe(time);
  }
  expect(clean(frames.partial).join("\n")).toContain("CLOCK PARTIAL MARKER");
  expect(clean(frames.finished).join("\n")).toContain("CLOCK DONE MARKER");
  expect(frames.streamingIdle).toEqual(["false"]);
  expect(timeAbove(panes(frames.unpersistedUser).chat, "USER MARKER"))
    .toBe(timeAbove(panes(frames.finished).chat, "USER MARKER"));
  const live = timeAbove(panes(frames.streaming).chat, "STRE");
  expect(timeAbove(panes(frames.finished).chat, "STREAMED ANSWER MARKER")).toBe(live);
  const sessionFile = path.join(cwd, "timestamp-session.jsonl");
  expect(SessionManager.open(sessionFile).getBranch().filter(entry =>
    entry.type === "custom" && entry.customType === "pi-agent-transcript/tool-start")).toHaveLength(1);
  const restored = await new PiIntegrationTest({
    testName: "streamed-timestamps-restarted", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: sessionFile, TZ: "UTC" },
    rawMode: false, tuiSize: { cols: 120, rows: 60 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: ["clock_probe"], conversation: [assistantMessage([text("RESTARTED ANSWER")])],
  }).run("RESTARTED USER");
  expect(restored.providerRequests).toHaveLength(1);
  const restarted: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  expect(timeAbove(panes(restarted.finished).activity, "CLOCK CALL MARKER")).toBe(time);
  expect(SessionManager.open(sessionFile).getBranch().filter(entry =>
    entry.type === "custom" && entry.customType === "pi-agent-transcript/tool-start")).toHaveLength(1);
});

test("keeps the last clock digit visible when the native auto scrollbar overlays history", async () => {
  const { cwd, agent } = await workspace();
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "left", chatWidth: 40, layout: "columns", chatHeight: null, zoom: "chat", showTimestamps: true,
  }));
  await new PiIntegrationTest({
    testName: "timestamp-scrollbar", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC", TIMESTAMP_SCROLLBAR: "1" },
    rawMode: false, tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: [], conversation: [assistantMessage([text(Array.from({ length: 60 }, (_, index) => "Long answer " + index).join("\n\n"))])],
  }).run("USER MARKER");
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  expect(frames.scrollbarVisible).toContain("true");
  const lines = clean(frames.scrollbar).map(line => line.slice(0, 119));
  expect(timeAbove(lines, "USER MARKER")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
});

const savedAssistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
  role: "assistant", content, timestamp, api: "openai-responses", provider: "openai", model: "saved-test-model",
  stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const timesAbove = (lines: string[], marker: string): string[] => lines.flatMap((line, row) =>
  line.includes(marker) ? [timeAbove(lines, marker, row)] : []);

test("restores repeated messages, branch-local starts, legacy approximations and unknowns in every layout", async () => {
  const { cwd, agent } = await workspace();
  const saved = path.join(cwd, "seed.jsonl");
  const manager = SessionManager.create(cwd, cwd);
  const at = (clock: string): number => Date.parse("2001-10-09T" + clock + "Z");
  manager.appendMessage({ role: "user", content: "REPEATED USER", timestamp: at("01:02:03") });
  manager.appendMessage(savedAssistant([
    { type: "thinking", thinking: "LEGACY THINKING" }, { type: "text", text: "FIRST ANSWER" },
    { type: "toolCall", id: "legacy-clock", name: "clock_probe", arguments: { tag: "LEGACY" } },
  ], at("02:03:04")));
  manager.appendMessage({ role: "toolResult", toolCallId: "legacy-clock", toolName: "clock_probe",
    content: [{ type: "text", text: "LEGACY RESULT" }], isError: false, timestamp: at("02:04:00") });
  const branchPoint = manager.appendMessage({ role: "user", content: "REPEATED USER", timestamp: at("03:04:05") });
  manager.appendCustomEntry("pi-agent-transcript/tool-start", { toolCallId: "legacy-clock", time: at("22:22:22") });
  manager.appendMessage(savedAssistant([{ type: "text", text: "ABANDONED ANSWER" }], at("22:22:23")));
  manager.branch(branchPoint);
  manager.appendMessage(savedAssistant([
    { type: "text", text: "SECOND ANSWER" },
    { type: "toolCall", id: "exact-clock", name: "clock_probe", arguments: { tag: "EXACT" } },
  ], at("04:05:06")));
  manager.appendCustomEntry("pi-agent-transcript/tool-start", { toolCallId: "exact-clock", time: at("05:06:07") });
  manager.appendMessage({ role: "toolResult", toolCallId: "exact-clock", toolName: "clock_probe",
    content: [{ type: "text", text: "EXACT RESULT" }], isError: false, timestamp: at("05:07:00") });
  manager.appendMessage({ role: "custom", customType: "timestamp-note", content: "CUSTOM MARKER", display: true, timestamp: at("06:07:08") });
  manager.appendMessage({ role: "bashExecution", command: "echo BASH_MARKER", output: "bash output",
    exitCode: 0, cancelled: false, truncated: false, timestamp: at("07:08:09") });
  manager.appendMessage({ role: "user", content: "UNKNOWN USER", timestamp: NaN });
  // Old/edited records may have neither a message time nor a valid entry time.
  const records = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  records.find(entry => entry.message?.content === "UNKNOWN USER").timestamp = "invalid";
  await writeFile(saved, records.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "combined", side: "right", chatWidth: 40, layout: "columns", chatHeight: 32, zoom: null,
  }));
  await new PiIntegrationTest({
    testName: "restored-timestamps", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: saved, TZ: "Asia/Tokyo", TIMESTAMP_LAYOUTS: "1" },
    rawMode: false, tuiSize: { cols: 120, rows: 85 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: ["clock_probe"], conversation: [assistantMessage([text("NEW ANSWER")])],
  }).run("FRESH USER");
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  const combined = clean(frames.combined);
  expect(combined.join("\n")).toContain("REPEATED USER");
  expect(combined.join("\n")).toContain("LEGACY THINKING");
  expect(combined.join("\n")).toContain("SECOND ANSWER");
  expect(clean(frames.combinedEnd).join("\n")).toContain("UNKNOWN USER");
  for (const frame of [frames.combined, frames.combinedEnd]) {
    expect(clean(frame).join("\n"), "Combined must use classic native rendering without added clocks")
      .not.toMatch(/~?\d{2}:\d{2}:\d{2}|--:--:--/);
  }
  for (const frame of Object.values(frames)) expect(clean(frame).join("\n")).not.toContain("ABANDONED ANSWER");
  const { chat, activity } = panes(frames.columns);
  expect(timesAbove(chat, "REPEATED USER")).toEqual(["10:02:03", "12:04:05"]);
  expect(timeAbove(chat, "FIRST ANSWER")).toBe("11:03:04");
  expect(timeAbove(activity, "LEGACY THINKING")).toBe("11:03:04");
  expect(timeAbove(activity, "EXACT CALL MARKER")).toBe("14:06:07");
  expect(timeAbove(clean(frames.chat), "FIRST ANSWER")).toBe("11:03:04");
  expect(timeAbove(clean(frames.activity), "LEGACY CALL MARKER")).toBe("~11:03:04");
  expect(timeAbove(clean(frames.rowsEnd), "[timestamp-note]")).toBe("15:07:08");
  for (const frame of Object.values(frames)) expect(clean(frame).join("\n")).not.toContain("--:--:--");
  const end = clean(frames.rowsEnd);
  const unknownRow = end.findIndex(line => line.includes("UNKNOWN USER"));
  const freshRow = end.findIndex(line => line.includes("FRESH USER"));
  expect(unknownRow).toBeGreaterThanOrEqual(0);
  expect(freshRow).toBeGreaterThan(unknownRow);
  expect(end[unknownRow - 1].trim()).toBe("");
  expect(end.slice(unknownRow, freshRow).join("\n")).not.toContain("⧉");
  const resumed = SessionManager.open(path.join(cwd, "timestamp-session.jsonl"));
  expect(resumed.getBranch().filter(entry => entry.type === "custom" && entry.customType === "pi-agent-transcript/tool-start")).toHaveLength(1);
});

test("collects tool starts while hidden and restores the original time when enabled after restart", async () => {
  const { cwd, agent } = await workspace();
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "right", chatWidth: 40, layout: "columns", chatHeight: 12,
    zoom: null, showTimestamps: false,
  }));
  await new PiIntegrationTest({
    testName: "hidden-tool-start", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC" },
    rawMode: false, tuiSize: { cols: 120, rows: 45 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: ["clock_probe"], conversation: [
      assistantMessage([toolCall({ id: "hidden-start", name: "clock_probe", arguments: {} })], { stopReason: "toolUse" }),
      assistantMessage([text("ANSWER MARKER")]),
    ],
  }).run("USER MARKER");
  const first: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  expect(clean(first.finished).join("\n")).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  expect(clean(first.finished).join("\n")).toContain("CLOCK CALL MARKER");
  const saved = path.join(cwd, "timestamp-session.jsonl");
  const entry = SessionManager.open(saved).getBranch().find(item =>
    item.type === "custom" && item.customType === "pi-agent-transcript/tool-start");
  expect(entry?.type).toBe("custom");
  if (entry?.type !== "custom") throw new Error("Missing hidden tool-start metadata");
  const data = entry.data as { toolCallId: string; time: number };
  expect(data.toolCallId).toBe("hidden-start");
  await new PiIntegrationTest({
    testName: "enable-restored-tool-start", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC", PI_TRANSCRIPT_TEST_SESSION: saved, TIMESTAMP_ENABLE_TIMES: "1" },
    rawMode: false, tuiSize: { cols: 120, rows: 45 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: ["clock_probe"], conversation: [assistantMessage([text("RESTORED ANSWER")])],
  }).run("FRESH USER");
  const restored: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  expect(clean(restored.hidden).join("\n")).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  expect(timeAbove(panes(restored.enabled).activity, "CLOCK CALL MARKER")).toBe(utcTime(data.time));
  expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8")).showTimestamps).toBe(true);
});

test("restores undecorated native history once when timestamp metadata changes shape", async () => {
  const { cwd, agent } = await workspace();
  await new PiIntegrationTest({
    testName: "timestamp-compatibility", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TIMESTAMP_BAD_METADATA: "1" },
    rawMode: false, tuiSize: { cols: 120, rows: 45 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: [], conversation: [assistantMessage([text("ANSWER MARKER")])],
  }).run("USER MARKER");
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  for (const key of ["unsupported", "finished"]) {
    const screen = clean(frames[key]).join("\n");
    expect(screen).toContain("USER MARKER");
    expect(screen).toContain("ANSWER MARKER");
    expect(screen).not.toContain("Conversation");
    expect(screen).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  }
  expect(clean(frames.finished).join("\n").split("Pi's message timestamp metadata is not supported")).toHaveLength(2);
});

test("does not leave orphan clocks for a native tool renderer that draws no content", async () => {
  const { cwd, agent } = await workspace();
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "right", chatWidth: 40, layout: "columns", chatHeight: 12, zoom: null,
  }));
  const result = await new PiIntegrationTest({
    testName: "timestamp-hidden-renderer", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TIMESTAMP_HIDE_TOOL: "1" },
    rawMode: false, tuiSize: { cols: 120, rows: 60 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: ["clock_probe"], conversation: [
      assistantMessage([toolCall({ id: "hidden-clock", name: "clock_probe", arguments: {} })], { stopReason: "toolUse" }),
      assistantMessage([text("ANSWER MARKER")]),
    ],
  }).run("USER MARKER");
  expect(getToolExecution(result, "hidden-clock").isError).toBe(false);
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  const { activity, chat } = panes(frames.finished);
  expect(activity.join("\n")).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  expect(chat.join("\n")).toContain("ANSWER MARKER");
});
