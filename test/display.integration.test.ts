import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { colorToRgb, indexedColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";

const directories: string[] = [];
const clean = (frame: string[]): string[] => frame.map(stripTerminalSequences);
const header = (frame: string[], title: string): number => clean(frame).findIndex(line =>
  line.includes(title) && /\[ (↗|↙) \]/.test(line));
const headerBackground = (frame: string[], title: string, marker = title): { r: number; g: number; b: number } => {
  const line = frame[header(frame, title)];
  const prefix = line.slice(0, line.indexOf(marker, line.indexOf(title)));
  // A reset after the fill would erase it before the actual title/button pixels.
  const before = prefix.slice(prefix.lastIndexOf("\x1b[0m") + 4);
  const colors = [...before.matchAll(/\x1b\[48;(?:2;(\d+);(\d+);(\d+)|5;(\d+))m/g)];
  const color = colors.at(-1);
  expect(color, "Header needs a native background color: " + title).toBeDefined();
  return color![4] ? colorToRgb(indexedColor(Number(color![4]))) : { r: Number(color![1]), g: Number(color![2]), b: Number(color![3]) };
};
const expectFrame = (frame: string[], title: string, top: "─" | "═"): void => {
  const row = header(frame, title);
  expect(row).toBeGreaterThan(0);
  expect(clean(frame)[row - 1].trim()).toMatch(new RegExp("^" + top + "{20,}$"));
  expect(clean(frame)[row + 1].trim()).toMatch(/^─{20,}$/);
};

beforeAll(async () => { await mkdir(path.resolve("tmp"), { recursive: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test("toggles saved timestamps from mouse and command settings and adapts tinted header frames", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/display-"));
  const agent = await mkdtemp(path.resolve("tmp/display-agent-"));
  directories.push(cwd, agent);
  const run = (name: string, controls: boolean) => new PiIntegrationTest({
    testName: name, artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, DISPLAY_SETTINGS_CONTROLS: controls ? "1" : "0", COLORTERM: "truecolor", DISPLAY_FRAMES_FILE: path.resolve("tmp/test-runs", name, "display-frames.json") },
    rawMode: false, tuiSize: { cols: 120, rows: 45 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/display-controls.ts")],
    tools: [], conversation: [assistantMessage([text("ANSWER MARKER")])],
  }).run("USER MARKER");
  const result = await run("display-settings", true);
  expect(result.providerRequests).toHaveLength(1);
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.resolve("tmp/test-runs/display-settings/display-frames.json"), "utf8"));
  expectFrame(frames.initial, "Conversation", "─");
  expectFrame(frames.initial, "Activity", "═");
  const initial = clean(frames.initial);
  const clock = initial.findIndex(line => /^\s+\d{2}:\d{2}:\d{2}\s*[┃│]?$/.test(line));
  expect(clock).toBe(header(frames.initial, "Conversation") + 3);
  expect(initial[clock - 1].trim()).toBe("");
  expect(clean(frames.settings).join("\n")).toContain("Show timestamps");
  expect(clean(frames.commandMenu).join("\n")).toContain("Show timestamps");
  for (const frame of [frames.off, frames.offCombined, frames.savedOff]) {
    const screen = clean(frame).join("\n");
    expect(screen).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(screen).toContain("USER MARKER");
    expect(screen).toContain("ANSWER MARKER");
  }
  expect(clean(frames.on).filter(line => /\d{2}:\d{2}:\d{2}/.test(line))).toEqual(initial.filter(line => /\d{2}:\d{2}:\d{2}/.test(line)));
  expectFrame(frames.swappedRows, "Activity", "─");
  expectFrame(frames.swappedRows, "Conversation", "═");
  expectFrame(frames.expanded, "Activity", "─");
  for (const frame of [frames.columns, frames.swapped]) {
    const row = header(frame, "Conversation");
    for (const edge of [row - 1, row + 1]) {
      const segments = clean(frame)[edge].split("║");
      expect(segments).toHaveLength(2);
      for (const segment of segments) expect(segment.trim()).toMatch(/^─{20,}$/);
    }
  }
  for (const frame of [frames.initial, frames.columns, frames.swappedRows, frames.expanded, frames.light]) {
    for (const title of ["Conversation", "Activity"]) {
      if (header(frame, title) < 0) continue;
      const icon = clean(frame)[header(frame, title)].includes("[ ↙ ]") ? "[ ↙ ]" : "[ ↗ ]";
      expect(headerBackground(frame, title, icon)).toEqual(headerBackground(frame, title));
    }
  }
  const green = headerBackground(frames.initial, "Conversation");
  const blue = headerBackground(frames.initial, "Activity");
  expect(green.g).toBeGreaterThan(green.r);
  expect(green.g).toBeGreaterThan(green.b);
  expect(blue.b).toBeGreaterThan(blue.r);
  expect(blue.b).toBeGreaterThan(blue.g);
  expect(headerBackground(frames.light, "Activity")).not.toEqual(headerBackground(frames.expanded, "Activity"));
  const saved = JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"));
  expect(saved.showTimestamps).toBe(false);
  expect(saved.layout).toBe("rows");
  expect(saved.side).toBe("right");
  await run("display-settings-restarted", false);
  const restarted: Record<string, string[]> = JSON.parse(await readFile(path.resolve("tmp/test-runs/display-settings-restarted/display-frames.json"), "utf8"));
  expect(clean(restarted.initial).join("\n")).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  for (const frame of Object.values(frames)) {
    expect(clean(frame.slice(-5)).some(line => line.includes("─".repeat(120)))).toBe(true);
  }
});
