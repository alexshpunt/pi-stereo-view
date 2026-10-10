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
  const header = clean(frames.keyboard).findIndex(line => line.includes("Conversation") && line.includes("[ ⌕ ]"));
  const search = clean(frames.keyboard).findIndex(line => line.includes("Search:") && line.includes("[↓]"));
  expect(search, "Search must be under its own panel header, not a popup").toBe(header + 3);
  expect(clean(frames.keyboard)[search - 1]).toMatch(/┌─+┐/);
  expect(clean(frames.keyboard)[search]).toMatch(/│.*Search:.*\[↓\].*\[×\].*│/);
  expect(clean(frames.keyboard)[search + 1]).toMatch(/└─+┘/);
  expect(clean(frames.exact).join("\n")).toContain("1/2");
  expect(clean(frames.keyboard).join("\n")).not.toContain("Search Conversation");
  expect(clean(frames.query).join("\n")).toContain("deployment runtime ready");
  expect(clean(frames.query).join("\n")).toContain("1/2");
  expect(clean(frames.older).join("\n")).toContain("OLDER OCCURRENCE CONTEXT");
  expect(clean(frames.older).join("\n")).toContain("2/2");
  expect(clean(frames.next).join("\n")).toContain("1/2");
  expect(clean(frames.refocused).filter(line => line.includes("Search:") && line.includes("[↓]"))).toHaveLength(1);
  expect(clean(frames.header).join("\n")).toContain("Search:");
  expect(clean(frames.closed).join("\n")).not.toContain("Search:");
  expect(observation.draft).toBe("UNSENT SEARCH DRAFT");
  const extra = observation as typeof observation & { editedDraft: string; highlighted: boolean; copied: string[];
    overlayKeptFocus: boolean; overlayValue: string; focusAfterOverlayDraft: string;
    openedOverOverlay: boolean; focusAfterBlockedOverlayDraft: string };
  expect(extra.editedDraft).toBe("UNSENT SEARCH DRAFTx");
  expect(extra.highlighted, "The selected native text must contain the theme's search highlight").toBe(true);
  expect(extra.copied).toEqual(["deployment runtime ready"]);
  expect(extra.openedOverOverlay, "Transcript search must not take input away from another active overlay").toBe(false);
  expect(extra.focusAfterBlockedOverlayDraft).toBe("UNSENT SEARCH DRAFTx");
  expect(extra.overlayKeptFocus, "Closing search must not steal focus from another overlay").toBe(true);
  expect(extra.overlayValue).toBe("z");
  expect(extra.focusAfterOverlayDraft, "Dismissing the other overlay must not restore a detached search input").toBe("UNSENT SEARCH DRAFTx");
  expect(clean(frames.keyboard).join("\n")).not.toContain("Find in transcript");
  const restored = (frame: string[]): string[] => clean(frame).map(line => line.replace(/[│┃](?=║|$)/g, " ").trimEnd());
  // Native auto scrollbars may remain visible briefly after navigation.
  expect(restored(frames.canceled)).toEqual(restored(frames.initial));
  expect(restored(frames.closed)).toEqual(restored(frames.initial));
  const states = (observation as typeof observation & { states: Record<string, unknown> }).states;
  expect(states.canceled).toEqual(states.initial);
  expect(states.closed).toEqual(states.initial);
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
    expect(screen(name + "Picker")).toContain("Search:");
    expect(screen(name + "Picker")).not.toContain("Find in transcript");
    if (name === "missing" || name === "scope") expect(screen(name)).not.toContain("Search:");
    else expect(screen(name)).toContain("Search:");
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
  expect(screen("missingQuery")).toContain("0/0");
  expect(screen("scopeQuery")).toContain("0/0");
  expect(screen("ownHeader")).toContain("Search:");
  expect(screen("russianQuery")).toContain("Запуск рабочего завершён");
  expect(screen("russian")).toContain("Запуск рабочего завершён");
  expect(screen("wheelPicker")).toContain("Search:");
  expect(screen("expandedPicker")).toContain("Search:");
  for (const name of ["combinedPicker", "fallbackPicker"]) {
    expect(screen(name)).not.toContain("Search Activity");
    expect(screen(name)).not.toContain("Search Conversation");
    expect(screen(name)).toContain("Find in transcript");
  }
  expect(screen("restored")).toContain("Conversation");
  expect(screen("restored")).toContain("Activity");
  expect(observation.draft).toBe("ACTIVITY UNSENT DRAFT");
});

test.each(["columns", "rows"] as const)("keeps an inline result visible at minimum sizes and closes safely on fallback in %s", async layout => {
  const cwd = await mkdtemp(path.resolve("tmp/search-resize-"));
  const agent = await mkdtemp(path.resolve("tmp/search-resize-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "left", chatWidth: 24, layout, chatHeight: 4, zoom: null, showTimestamps: false,
  }));
  const result = await new PiIntegrationTest({
    testName: "search-resize-" + layout, artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false, tuiSize: { cols: 100, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/search-resize-controls.ts")],
    tools: [], conversation: [assistantMessage([text("RESIZE TARGET\n" + "History row\n".repeat(30))])],
  }).run("RESIZE SETUP");
  expect(result.providerRequests).toHaveLength(1);
  const observation: { frames: Record<string, string[]>; draft: string } = JSON.parse(await readFile(path.join(cwd, "search-resize-frames.json"), "utf8"));
  await writeFile(path.resolve("tmp/test-runs", "search-resize-" + layout, "search-resize-frames.json"), JSON.stringify(observation));
  for (const name of ["opened", "narrow", "zoom", "shortZoom"]) {
    const screen = clean(observation.frames[name]).join("\n");
    expect(screen).toContain("Search:");
    expect(screen).toContain("[↓]");
    expect(screen).toContain("[×]");
    expect(screen, "The search header must leave at least one native content row").toContain("RESIZE TARGET");
    expect(screen).toContain("RESIZE UNSENT DRAFT");
    if (name === "opened" || name === "narrow") expect(screen).toContain("Activity");
    for (const line of observation.frames[name]) expect(visibleWidth(line)).toBeLessThanOrEqual(name === "opened" ? 100 : 70);
  }
  expect(clean(observation.frames.fallback).join("\n")).not.toContain("Search:");
  expect(clean(observation.frames.restored).join("\n")).not.toContain("Search:");
  expect(observation.draft).toBe("RESIZE UNSENT DRAFTx");
  expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"))).toMatchObject({ chatWidth: 24, chatHeight: 4 });
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
    expect(screen(name)).toContain("Search:");
    expect(screen(name)).toContain("OLD BRANCH ONLY");
  }
  for (const name of ["reloaded", "branched"]) {
    expect(screen(name)).not.toContain("Search:");
    expect((screen(name).match(/\[ ⌕ \]/g) ?? [])).toHaveLength(2);
  }
  expect(screen("branched")).toContain("BRANCH NEW ANCHOR");
  expect(screen("branched")).not.toContain("OLD BRANCH ONLY");
  expect(screen("oldQuery")).toContain("0/0");
  expect(screen("streamingPicker")).toContain("Search:");
  expect(screen("streamingPicker")).toContain("BRANCH NEW ANCHOR");
  expect(screen("finished")).toContain("BRANCH NEW ANCHOR");
  expect(screen("completeQuery")).toContain("STREAM COMPLETE MARKER");
  expect(observation.streamingIdle).toBe(false);
  expect(observation.following).toBe(false);
  expect(observation.draft).toBe("LIFECYCLE UNSENT DRAFT");
});
