import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const directories: string[] = [];
const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");
const headerRow = (lines: string[], title: string): number => lines.findIndex(line =>
  stripTerminalSequences(line).includes(title) && /\[ (↗|↙) \]/.test(stripTerminalSequences(line)));

beforeAll(async () => { await mkdir(path.resolve("tmp"), { recursive: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test("starts new settings side by side at 20/80 and retains that ratio on resize", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/default-columns-"));
  const agent = await mkdtemp(path.resolve("tmp/default-agent-"));
  directories.push(cwd, agent);
  await new PiIntegrationTest({
    testName: "default-columns", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_BUTTON_DEFAULTS: "1" },
    rawMode: false, tuiSize: { cols: 200, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/panel-controls.ts")],
    tools: [], conversation: [assistantMessage([text("ANSWER MARKER")])],
  }).run("USER MARKER");
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "default-layouts.json"), "utf8"));
  await writeFile(path.resolve("tmp/test-runs/default-columns/default-layouts.json"), JSON.stringify(frames));
  for (const [name, width] of [["columns", 200], ["wider", 400]] as const) {
    const header = stripTerminalSequences(frames[name][headerRow(frames[name], "Conversation")]);
    expect(header.indexOf("Conversation")).toBeLessThan(header.indexOf("Activity"));
    expect(header.indexOf("║")).toBe(Math.floor((width - 1) * 0.2));
    expect(clean(frames[name])).toContain("ANSWER MARKER");
  }
  expect(headerRow(frames.rows, "Conversation")).toBe(2);
  expect(headerRow(frames.rows, "Activity")).toBeGreaterThan(2);
  expect(clean(frames.rows)).toContain("═".repeat(400));
  for (const name of ["manual", "resized"]) {
    const header = stripTerminalSequences(frames[name][headerRow(frames[name], "Conversation")]);
    expect(header.indexOf("║"), name).toBe(83);
  }
  expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"))).toMatchObject({
    chatWidth: 83, layout: "columns", chatHeight: null,
  });
});

test.each(["chat", "activity"])("uses mouse buttons and both dividers without restoring %s zoom on restart", async zoom => {
  const cwd = await mkdtemp(path.resolve("tmp/buttons-"));
  const agent = await mkdtemp(path.resolve("tmp/button-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ mode: "split", side: "left", chatWidth: 36 }));
  const run = (name: string, controls: boolean) => new PiIntegrationTest({
    testName: name,
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    // Keep native collapsed tools so the harness adds no startup expansion notice.
    environment: { PI_CODING_AGENT_DIR: agent, PI_INTEGRATION_TEST_LIVE: "1", TRANSCRIPT_BUTTON_CONTROLS: controls ? "1" : "0",
      TRANSCRIPT_BUTTON_FINAL_ZOOM: zoom },
    rawMode: false,
    tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts"), path.resolve("test/fixtures/panel-controls.ts")],
    tools: ["write"],
    conversation: [
      assistantMessage([toolCall({ id: "button-write", name: "write", arguments: { path: "effect.txt", content: "real effect" } })], { stopReason: "toolUse" }),
      assistantMessage([text("ANSWER MARKER")]),
    ],
  }).run("USER MARKER");
  const result = await run("panel-buttons-" + zoom, true);
  expect(result.providerRequests).toHaveLength(2);
  expect(getToolExecution(result, "button-write").isError).toBe(false);
  expect(await readFile(path.join(cwd, "effect.txt"), "utf8")).toBe("real effect");
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "panel-controls.json"), "utf8"));
  const first = stripTerminalSequences(frames.initial[headerRow(frames.initial, "Conversation")]);
  expect(clean(frames.initial.slice(0, 2))).toContain("[ ↔ ]");
  expect(first).toContain("[ ↗ ]");
  expect(stripTerminalSequences(frames.rows[0])).toContain("[ ↕ ]");
  expect(first.indexOf("Conversation")).toBeLessThan(first.indexOf("Activity"));
  expect(first.indexOf("║")).toBe(36);
  expect(headerRow(frames.canceledClick, "Conversation")).toBe(2);
  expect(headerRow(frames.canceledClick, "Activity")).toBe(2);
  expect(headerRow(frames.rows, "Conversation")).toBe(2);
  // Both one-line messages now occupy a clock, body and icon row.
  expect(headerRow(frames.rows, "Activity")).toBe(12);
  expect(headerRow(frames.rowDrag, "Activity")).toBe(6);
  expect(headerRow(frames.rowSwap, "Activity")).toBeLessThan(headerRow(frames.rowSwap, "Conversation"));
  expect(stripTerminalSequences(frames.columnDrag[1]).indexOf("║")).toBe(75);
  expect(headerRow(frames.activity, "Activity")).toBe(2);
  expect(headerRow(frames.activity, "Conversation")).toBe(-1);
  expect(clean(frames.activity)).toContain("NATIVE RESULT MARKER");
  expect(clean(frames.activity)).not.toContain("ANSWER MARKER");
  expect(headerRow(frames.chat, "Conversation")).toBe(2);
  expect(headerRow(frames.chat, "Activity")).toBe(-1);
  expect(clean(frames.chat)).toContain("USER MARKER");
  expect(clean(frames.chat)).toContain("ANSWER MARKER");
  expect(clean(frames.chat)).not.toContain("NATIVE CALL MARKER");
  expect(clean(frames.combined)).toContain("[ ◫ ]");
  expect(headerRow(frames.combined, "Conversation")).toBe(-1);
  expect(clean(frames.combined)).toContain("NATIVE RESULT MARKER");
  expect(clean(frames.combined)).toContain("ANSWER MARKER");
  for (const key of ["activityRestored", "chatRestored", "splitRestored"]) {
    expect(stripTerminalSequences(frames[key][1]).indexOf("║")).toBe(75);
  }
  expect(headerRow(frames.shortRows, "Activity")).toBe(-1);
  expect(clean(frames.shortRows)).toContain("[ ◫ ]");
  expect(headerRow(frames.tallRows, "Activity")).toBe(2);
  expect(headerRow(frames.tallRows, "Conversation")).toBeGreaterThan(2);
  for (const frame of Object.values(frames)) {
    const headerRows = new Set([0, headerRow(frame, "Activity"), headerRow(frame, "Conversation")]);
    for (const row of headerRows) {
      if (row < 0) continue;
      const buttons = stripTerminalSequences(frame[row]).match(/\[[^\]]*\]/gu) ?? [];
      for (const button of buttons) {
        expect(button).toMatch(/^\[ . \]$/u);
        expect(visibleWidth(button)).toBe(5);
      }
    }
    const lines = frame.map(stripTerminalSequences);
    const dockBorders = lines.flatMap((line, row) => line.includes("─".repeat(120)) ? [row] : []).slice(-2);
    expect(dockBorders).toHaveLength(2);
    expect(dockBorders[1] - dockBorders[0]).toBe(2);
    expect(lines.slice(dockBorders[0]).some(line => line.includes("║"))).toBe(false);
  }
  expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"))).toEqual({
    side: "right", chatWidth: 44, layout: "rows", chatHeight: 4, showTimestamps: true, showCopyButtons: true, compactTools: false,
  });
  await run("expanded-panel-restart-" + zoom, false);
  const restored: string[] = JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8"));
  expect(headerRow(restored, "Activity")).toBe(2);
  expect(headerRow(restored, "Conversation")).toBeGreaterThan(2);
  expect(clean(restored)).not.toContain("[ ↙ ]");
  expect(clean(restored)).toContain("[ ▥ ]");
});

test("starts both panels in the saved arrangement after disabling split in another session", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/combined-buttons-"));
  const agent = await mkdtemp(path.resolve("tmp/combined-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  const saved = { side: "left", chatWidth: 36, layout: "rows", chatHeight: 9, showTimestamps: true, showCopyButtons: true };
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify(saved));
  const run = (name: string) => new PiIntegrationTest({
    testName: name, artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    // Keep native collapsed tools so the harness adds no startup expansion notice.
    environment: { PI_CODING_AGENT_DIR: agent, PI_INTEGRATION_TEST_LIVE: "1", TRANSCRIPT_BUTTON_TOGGLE: "1" },
    rawMode: false, tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/panel-controls.ts")],
    tools: [], conversation: [assistantMessage([text("ANSWER MARKER")])],
  }).run("USER MARKER");
  await run("save-combined-buttons");
  expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"))).toEqual({ ...saved, compactTools: false });
  await run("restore-combined-buttons");
  const frames: { before: string[]; after: string[] } = JSON.parse(await readFile(path.join(cwd, "button-toggle.json"), "utf8"));
  expect(clean(frames.before)).toContain("[ ▣ ]");
  expect(headerRow(frames.before, "Conversation")).toBe(2);
  expect(headerRow(frames.before, "Activity")).toBe(saved.chatHeight + 2);
  expect(clean(frames.before)).toContain("USER MARKER");
  expect(clean(frames.before)).toContain("ANSWER MARKER");
  expect(headerRow(frames.after, "Conversation")).toBe(-1);
  expect(headerRow(frames.after, "Activity")).toBe(-1);
  expect(clean(frames.after)).toContain("[ ◫ ]");
  expect(clean(frames.after)).toContain("USER MARKER");
  expect(clean(frames.after)).toContain("ANSWER MARKER");
  expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"))).toEqual({ ...saved, compactTools: false });
});

test("keeps mouse controls active while text and a real tool call stream", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/button-stream-"));
  const agent = await mkdtemp(path.resolve("tmp/stream-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "right", chatWidth: 40, layout: "columns", chatHeight: 12, zoom: null,
  }));
  const result = await new PiIntegrationTest({
    testName: "buttons-during-streaming",
    artifactsDir: path.resolve("tmp/test-runs"),
    cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"),
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_BUTTON_STREAM: "1" },
    rawMode: false,
    tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts"), path.resolve("test/fixtures/panel-controls.ts")],
    tools: ["write"],
    conversation: [
      assistantMessage([
        text("STREAM MARKER completed.", { chunks: { kind: "fixed", size: 3 }, delayMs: 20 }),
        toolCall({ id: "stream-write", name: "write", arguments: { path: "effect.txt", content: "stream effect" } }),
      ], { stopReason: "toolUse" }),
      assistantMessage([text("ANSWER MARKER")]),
    ],
  }).run("USER MARKER");
  const frames: { idle: boolean; lines: string[] }[] = JSON.parse(await readFile(path.join(cwd, "button-stream.json"), "utf8"));
  expect(frames).toHaveLength(5);
  expect(frames.every(frame => !frame.idle)).toBe(true);
  expect(headerRow(frames[1].lines, "Conversation")).toBe(-1);
  expect(headerRow(frames[2].lines, "Conversation")).toBeGreaterThan(1);
  expect(headerRow(frames[3].lines, "Activity")).toBe(-1);
  expect(headerRow(frames[4].lines, "Conversation")).toBeGreaterThan(1);
  expect(result.providerRequests).toHaveLength(2);
  expect(getToolExecution(result, "stream-write").isError).toBe(false);
  expect(await readFile(path.join(cwd, "effect.txt"), "utf8")).toBe("stream effect");
});
