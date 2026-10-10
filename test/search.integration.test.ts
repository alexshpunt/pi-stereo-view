import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const savedAssistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, timestamp: Date.now(), api: "openai-responses", provider: "openai", model: "saved-test-model",
  stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const directories: string[] = [];
const clean = (frame: string[]): string[] => frame.map(stripTerminalSequences);
beforeAll(async () => { await mkdir(path.resolve("tmp"), { recursive: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test.each(["columns", "rows"] as const)("searches Conversation with keyboard and header in %s without altering the draft", async layout => {
  const cwd = await mkdtemp(path.resolve("tmp/search-"));
  const agent = await mkdtemp(path.resolve("tmp/search-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "left", chatWidth: 45, layout, chatHeight: null, zoom: null, showTimestamps: true,
  }));
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: "user", content: "deployment runtime ready", timestamp: Date.now() - 10_000 });
  manager.appendMessage(savedAssistant([{ type: "text", text: "OLDER OCCURRENCE CONTEXT" }]));
  // Explicitly enable the native shortcut too, so an accidental double search is exercised on every host.
  await writeFile(path.join(agent, "keybindings.json"), JSON.stringify({ "tui.altScreen.search": "ctrl+f" }));
  const result = await new PiIntegrationTest({
    testName: "search-" + layout, artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: manager.getSessionFile()! },
    rawMode: false, tuiSize: { cols: 140, rows: 40 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/search-controls.ts")],
    tools: [], conversation: [assistantMessage([text(Array.from({ length: 60 }, (_, row) => "History line " + row).join("\n"))])],
  }).run("deployment runtime ready");
  expect(result.providerRequests).toHaveLength(1);
  const observation: { frames: Record<string, string[]>; draft: string } = JSON.parse(await readFile(path.join(cwd, "search-frames.json"), "utf8"));
  const { frames } = observation;
  await writeFile(path.resolve("tmp/test-runs", "search-" + layout, "search-frames.json"), JSON.stringify(observation));
  expect(clean(frames.keyboard).join("\n")).toContain("Search Conversation");
  expect(clean(frames.query).join("\n")).toContain("deployment runtime ready");
  expect(clean(frames.canceled).join("\n")).not.toContain("Search Conversation");
  expect(clean(frames.header).join("\n")).toContain("Search Conversation");
  expect(clean(frames.jumped).join("\n")).toContain("deployment runtime ready");
  expect(clean(frames.jumped).join("\n")).not.toContain("Search Conversation");
  expect(clean(frames.older).join("\n")).toContain("OLDER OCCURRENCE CONTEXT");
  expect(observation.draft).toBe("UNSENT SEARCH DRAFT");
  expect(clean(frames.keyboard).join("\n")).not.toContain("Find in transcript");
  expect(clean(frames.canceled)).toEqual(clean(frames.initial));
  for (const frame of Object.values(frames)) {
    for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(140);
  }
});

test.each(["columns", "rows"] as const)("reveals saved Activity matches and keeps search branch-local in %s", async layout => {
  const cwd = await mkdtemp(path.resolve("tmp/search-activity-"));
  const agent = await mkdtemp(path.resolve("tmp/search-activity-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "left", chatWidth: 45, layout, chatHeight: null, zoom: null, showTimestamps: true,
  }));
  await writeFile(path.join(agent, "keybindings.json"), JSON.stringify({ "tui.altScreen.search": "ctrl+f" }));
  const manager = SessionManager.create(cwd, cwd);
  const branch = manager.appendMessage({ role: "user", content: "deployment runtime ready\nЗапуск рабочего завершён", timestamp: Date.now() });
  manager.appendMessage(savedAssistant([{ type: "text", text: "ABANDONED BRANCH UNIQUE" }]));
  manager.branch(branch);
  manager.appendMessage(savedAssistant([
    { type: "thinking", thinking: "Скрытый русский план" },
    { type: "toolCall", id: "saved-result", name: "saved_probe", arguments: {} },
  ]));
  manager.appendMessage({ role: "toolResult", toolName: "saved_probe", toolCallId: "saved-result", isError: false,
    content: [{ type: "text", text: Array.from({ length: 35 }, (_, row) => "Native output line " + row).join("\n") + "\nrestart worker successful" }], timestamp: Date.now() });
  manager.appendMessage(savedAssistant([{ type: "toolCall", id: "custom-result", name: "saved_hidden", arguments: {} }]));
  manager.appendMessage({ role: "toolResult", toolName: "saved_hidden", toolCallId: "custom-result", isError: false,
    content: [{ type: "text", text: "CUSTOM HIDDEN RESULT" }], timestamp: Date.now() });
  const result = await new PiIntegrationTest({
    testName: "search-activity-" + layout, artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: manager.getSessionFile()! },
    rawMode: false, tuiSize: { cols: 140, rows: 45 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/search-activity-controls.ts")],
    tools: ["saved_probe", "saved_hidden"],
    conversation: [assistantMessage([text(Array.from({ length: 60 }, (_, row) => "History line " + row).join("\n"))])],
  }).run("FRESH SEARCH USER");
  expect(result.providerRequests).toHaveLength(1);
  const observation: { frames: Record<string, string[]>; states: Record<string, { chatTop: number; activityTop: number; follow: boolean }>; draft: string } =
    JSON.parse(await readFile(path.join(cwd, "search-activity-frames.json"), "utf8"));
  await writeFile(path.resolve("tmp/test-runs", "search-activity-" + layout, "search-activity-frames.json"), JSON.stringify(observation));
  const { frames, states } = observation;
  const screen = (name: string): string => clean(frames[name]).join("\n");
  expect(screen("active")).toContain("● Activity");
  for (const name of ["tool", "thinking", "custom", "missing", "scope"]) {
    expect(screen(name + "Picker")).toContain("Search Activity");
    expect(screen(name + "Picker")).not.toContain("Find in transcript");
    expect(screen(name)).not.toContain("Search Activity");
    expect(states[name].chatTop).toBe(states.initial.chatTop);
  }
  expect(screen("initial")).not.toContain("restart worker successful");
  expect(screen("toolQuery")).toContain("restart worker successful");
  expect(screen("tool")).toContain("restart worker successful");
  expect(screen("tool")).not.toContain("Search match:");
  expect(states.tool.follow).toBe(false);
  expect(screen("thinking")).toContain("Скрытый русский план");
  expect(screen("custom")).toContain("CUSTOM HIDDEN RESULT");
  expect(screen("custom")).toContain("Search match:");
  expect(screen("custom")).toContain("CUSTOM NATIVE RESULT");
  expect(screen("missingQuery")).toContain("No matches");
  expect(screen("scopeQuery")).toContain("No matches");
  expect(screen("ownHeader")).toContain("Search Conversation");
  expect(screen("russianQuery")).toContain("Запуск рабочего завершён");
  expect(screen("russian")).toContain("Запуск рабочего завершён");
  expect(screen("wheelPicker")).toContain("Search Activity");
  expect(screen("expandedPicker")).toContain("Search Activity");
  for (const name of ["combinedPicker", "fallbackPicker"]) {
    expect(screen(name)).not.toContain("Search Activity");
    expect(screen(name)).not.toContain("Search Conversation");
    expect(screen(name)).toContain("Find in transcript");
  }
  expect(screen("restored")).toContain("Conversation");
  expect(screen("restored")).toContain("Activity");
  expect(observation.draft).toBe("ACTIVITY UNSENT DRAFT");
});

test("drops old search state on reload and branch changes, then keeps an older result visible while streaming", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/search-lifecycle-"));
  const agent = await mkdtemp(path.resolve("tmp/search-lifecycle-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "left", chatWidth: 45, layout: "columns", chatHeight: null, zoom: null, showTimestamps: true,
  }));
  await writeFile(path.join(agent, "keybindings.json"), JSON.stringify({ "tui.altScreen.search": "ctrl+f" }));
  const manager = SessionManager.create(cwd, cwd);
  const common = manager.appendMessage({ role: "user", content: "COMMON MESSAGE", timestamp: Date.now() });
  const target = manager.appendMessage(savedAssistant([{ type: "text", text: "BRANCH NEW ANCHOR" }]));
  manager.branch(common);
  manager.appendMessage(savedAssistant([{ type: "text", text: "OLD BRANCH ONLY" }]));
  const result = await new PiIntegrationTest({
    testName: "search-lifecycle", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: manager.getSessionFile()!, SEARCH_BRANCH_TARGET: target },
    rawMode: false, tuiSize: { cols: 140, rows: 40 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/search-lifecycle-controls.ts")],
    tools: [], timeoutMs: 60_000,
    conversation: [assistantMessage([text(Array.from({ length: 80 }, (_, row) => "Streaming line " + row).join("\n") + "\nSTREAM COMPLETE MARKER",
      { chunks: { kind: "fixed", size: 35 }, delayMs: 25 })])],
  }).run("/search-lifecycle-check");
  expect(result.providerRequests).toHaveLength(1);
  const observation: { frames: Record<string, string[]>; draft: string; following: boolean; streamingIdle: boolean } =
    JSON.parse(await readFile(path.join(cwd, "search-lifecycle-frames.json"), "utf8"));
  await writeFile(path.resolve("tmp/test-runs", "search-lifecycle", "search-lifecycle-frames.json"), JSON.stringify(observation));
  const screen = (name: string): string => clean(observation.frames[name]).join("\n");
  for (const name of ["beforeReload", "beforeBranch"]) {
    expect(screen(name)).toContain("Search Conversation");
    expect(screen(name)).toContain("OLD BRANCH ONLY");
  }
  for (const name of ["reloaded", "branched"]) {
    expect(screen(name)).not.toContain("Search Conversation");
    expect((screen(name).match(/\[ ⌕ \]/g) ?? [])).toHaveLength(2);
  }
  expect(screen("branched")).toContain("BRANCH NEW ANCHOR");
  expect(screen("branched")).not.toContain("OLD BRANCH ONLY");
  expect(screen("oldQuery")).toContain("No matches");
  expect(screen("streamingPicker")).toContain("Search Conversation");
  expect(screen("streamingPicker")).toContain("BRANCH NEW ANCHOR");
  expect(screen("finished")).toContain("BRANCH NEW ANCHOR");
  expect(screen("completeQuery")).toContain("STREAM COMPLETE MARKER");
  expect(observation.streamingIdle).toBe(false);
  expect(observation.following).toBe(false);
  expect(observation.draft).toBe("LIFECYCLE UNSENT DRAFT");
});
