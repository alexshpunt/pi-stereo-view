import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";

const directories: string[] = [];

test("keeps one blank row between tool calls and fits short Activity to its content", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/compact-activity-"));
  const agent = await mkdtemp(path.resolve("tmp/compact-activity-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ side: "left", chatWidth: 40, layout: "rows" }));
  const result = await new PiIntegrationTest({
    testName: "compact-activity", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC", TIMESTAMP_ZOOM_ACTIVITY: "1" },
    rawMode: false, tuiSize: { cols: 120, rows: 50 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/timestamp-probe.ts")],
    tools: ["clock_probe"], conversation: [
      assistantMessage([toolCall({ id: "first", name: "clock_probe", arguments: { tag: "FIRST" } })], { stopReason: "toolUse" }),
      assistantMessage([toolCall({ id: "second", name: "clock_probe", arguments: { tag: "SECOND" } })], { stopReason: "toolUse" }),
      assistantMessage([text("DONE")]),
    ],
  }).run("USER");
  expect(result.providerRequests).toHaveLength(3);
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "timestamp-frames.json"), "utf8"));
  const lines = frames.finished.map(stripTerminalSequences);
  const first = lines.findIndex(line => line.includes("FIRST CALL MARKER"));
  const second = lines.findIndex(line => line.includes("SECOND CALL MARKER"));
  for (const row of [first, second]) {
    expect(row).toBeGreaterThan(0);
    expect(lines[row - 1]).toMatch(/^ \d{2}:\d{2}:\d{2}\s*[┃│]?$/);
    expect(lines[row]).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  }
  expect(lines[second - 2].trim()).toBe("");
  expect(lines[second - 3].trim()).toBe("⧉\u034f");
  expect(lines[second - 4]).toContain("CLOCK DONE MARKER");
  const last = lines.reduce((found, line, row) => line.includes("CLOCK DONE MARKER") ? row : found, -1);
  const borders = lines.flatMap((line, row) => line.includes("─".repeat(120)) ? [row] : []).slice(-2);
  expect(borders[0] - last).toBeLessThanOrEqual(3);
  expect(borders[1] - borders[0]).toBe(2);
});
beforeAll(async () => { await mkdir(path.resolve("tmp"), { recursive: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test("fits Conversation to clock headers and copy footers without losing paragraphs", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/compact-"));
  const agent = await mkdtemp(path.resolve("tmp/compact-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "left", chatWidth: 40, layout: "rows", chatHeight: 100,
  }));
  const result = await new PiIntegrationTest({
    testName: "compact-conversation", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    // Keep native collapsed tools so the harness adds no startup expansion notice.
    environment: { PI_CODING_AGENT_DIR: agent, PI_INTEGRATION_TEST_LIVE: "1", TZ: "UTC" },
    rawMode: false, tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
    tools: [], conversation: [assistantMessage([text("FIRST PARAGRAPH\n\nSECOND PARAGRAPH")])],
  }).run("USER MARKER");
  expect(result.providerRequests).toHaveLength(1);
  const frame: string[] = JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8"));
  const lines = frame.map(stripTerminalSequences);
  const header = lines.findIndex(line => line.includes("Conversation"));
  const activity = lines.findIndex(line => line.includes("Activity"));
  expect(header).toBe(2);
  const user = lines.findIndex(line => line.includes("USER MARKER"));
  const first = lines.findIndex(line => line.includes("FIRST PARAGRAPH"));
  const second = lines.findIndex(line => line.includes("SECOND PARAGRAPH"));
  expect(user).toBe(header + 3);
  expect(first).toBe(user + 4);
  expect(lines[user + 1].trim()).toBe("⧉\u034f");
  expect(lines[user + 2].trim()).toBe("");
  expect(second).toBe(first + 2);
  expect(lines[first + 1].trim()).toBe("");
  expect(lines[second + 1].trim()).toBe("⧉\u034f");
  expect(activity).toBe(second + 3);
  for (const row of [user, first]) {
    expect(lines[row - 1]).toMatch(/^ \d{2}:\d{2}:\d{2}\s*[┃│]?$/);
    expect(lines[row]).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  }
  expect(lines[second]).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  expect(lines.slice(user - 1, second + 1).filter(line => /\d{2}:\d{2}:\d{2}/.test(line))).toHaveLength(2);
  for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
  const footer = lines.findIndex(line => line.includes(path.basename(cwd)));
  expect(footer).toBeGreaterThan(2);
  expect(lines[footer - 1]).toBe("─".repeat(120));
  expect(lines[footer - 3]).toBe("─".repeat(120));
});

test.each([false, true])("keeps the full input visible when expanded Conversation is %s long", async long => {
  const cwd = await mkdtemp(path.resolve("tmp/compact-resize-"));
  const agent = await mkdtemp(path.resolve("tmp/compact-resize-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "left", chatWidth: 40, layout: "rows", chatHeight: 100,
  }));
  const answer = long ? Array.from({ length: 60 }, (_, index) => "Line " + index).join("\n") : "SHORT ANSWER";
  await new PiIntegrationTest({
    testName: long ? "compact-long-resize" : "compact-short-resize", artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    // Keep native collapsed tools so the harness adds no startup expansion notice.
    environment: { PI_CODING_AGENT_DIR: agent, PI_INTEGRATION_TEST_LIVE: "1", TZ: "UTC" },
    rawMode: false, tuiSize: { cols: 120, rows: 35 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/compact-probe.ts")],
    tools: [], conversation: [assistantMessage([text(answer)])],
  }).run("USER MARKER");
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "compact-frames.json"), "utf8"));
  for (const [name, frame] of Object.entries(frames)) {
    const width = name === "small" ? 40 : 120;
    const lines = frame.map(stripTerminalSequences);
    const borders = lines.flatMap((line, row) => line.includes("─".repeat(width)) ? [row] : []);
    expect(borders).toHaveLength(name === "rows" ? 5 : 4);
    expect(lines.some(line => line.includes(long ? "Line 59" : "SHORT ANSWER"))).toBe(true);
    for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    if (name !== "rows") expect(lines.join("\n")).not.toContain("Activity");
    // Two short blocks each have one clock row and one copy row; the dock still hugs their content.
    if (!long && name === "zoom") expect(borders.at(-1)).toBe(14);
    if (long) expect(borders.at(-1)).toBeLessThan(frame.length - 1);
  }
});