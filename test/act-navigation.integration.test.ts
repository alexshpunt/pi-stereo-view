import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const artifactsDir = testArtifactsDir(import.meta.filename, path.resolve("tmp/test-runs"));
const filler = (label: string): string => Array.from({ length: 30 }, (_, row) => `${label} filler line ${row}`).join("\n");
interface Observation { frames: Record<string, string[]>; raw: Record<string, string[]>; tops: Record<string, number>; divider: number; error?: string }

const saved = (content: AssistantMessage["content"], at: number): AssistantMessage => ({
  role: "assistant", content, timestamp: at, api: "openai-responses", provider: "openai", model: "synthetic-acts",
  stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

/** Two saved acts, each long enough that both panels scroll. */
function seed(cwd: string): string {
  const manager = SessionManager.create(cwd, cwd);
  const at = Date.parse("2026-01-01T10:00:00Z");
  for (const [index, name] of ["FIRST", "SECOND"].entries()) {
    const time = at + index * 60_000;
    manager.appendMessage({ role: "user", content: `${name} REQUEST\nCheck the ${name.toLowerCase()} file.`, timestamp: time });
    manager.appendMessage(saved([
      ...(index === 0 ? [{ type: "thinking" as const, thinking: `FIRST THINKING\n${filler("thinking")}` }] : []),
      { type: "text", text: `${name} ANSWER` },
      { type: "toolCall", id: `act-${index}`, name: "read", arguments: { path: `${name}-PATH.txt` } },
    ], time + 1000));
    manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: `act-${index}`, isError: false,
      content: [{ type: "text", text: filler(name + " tool") }], timestamp: time + 2000 });
    manager.appendMessage(saved([{ type: "text", text: `${name} DONE\n\n${filler(name + " done")}` }], time + 3000));
  }
  return manager.getSessionFile()!;
}

/** Every act mark off, so only the behavior under test colors a row. */
const NO_MARKS = { actClock: false, actStripe: "off", actBackground: false, actSeparator: false };

async function run(name: string, scenario: "navigation" | "settings", preferences: object, environment: Record<string, string> = {}): Promise<Observation> {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/act-navigation-"));
  const agent = await mkdtemp(path.resolve("tmp/act-navigation-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false, compaction: { enabled: false } }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", chatWidth: 60, layout: "columns", chatHeight: null, zoom: null, showTimestamps: true, ...preferences,
    }));
    const result = await new PiIntegrationTest({
      testName: name, artifactsDir, cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: seed(cwd), ACT_SCENARIO: scenario, TZ: "UTC", ...environment },
      rawMode: false, tuiSize: { cols: 160, rows: 40 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/act-navigation-probe.ts")],
      tools: [], conversation: [assistantMessage([text("THIRD DONE")])],
    }).run("THIRD REQUEST");
    expect(result.exitCode).toBe(0);
    const observation: Observation = JSON.parse(await readFile(path.join(cwd, "act-navigation-observation.json"), "utf8"));
    await writeFile(path.join(artifactsDir, name, "observation.json"), JSON.stringify(observation, null, 2));
    expect(observation.error, observation.frames.failure?.join("\n")).toBeUndefined();
    return observation;
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}

const pane = (observation: Observation, frame: string, which: "chat" | "activity", raw = false): string[] =>
  (raw ? observation.raw : observation.frames)[frame].map(line => which === "chat" ? sliceByColumn(line, 0, observation.divider) :
    sliceByColumn(line, observation.divider + 1, 160 - observation.divider - 1));
/** Rows of a pane's body, below its two header lines. */
const body = (observation: Observation, frame: string, which: "chat" | "activity"): string[] => {
  const rows = pane(observation, frame, which);
  const header = rows.findIndex(line => line.includes(which === "chat" ? "Conversation" : "Activity"));
  return rows.slice(header + 2);
};
const row = (observation: Observation, frame: string, which: "chat" | "activity", marker: string): string => {
  const rows = pane(observation, frame, which, true);
  const found = rows.find(line => stripTerminalSequences(line).includes(marker));
  if (found === undefined) throw new Error(`Missing ${marker} in ${frame}`);
  return found;
};

test("hover highlights an act in both panels and Go to opens the same point in the other panel", async () => {
  const observation = await run("act-navigation", "navigation", { ...NO_MARKS, actHover: true, goTo: "both" });
  // Hover tints the act's default cells in the other panel; moving within the act changes nothing.
  expect(row(observation, "beforeHover", "chat", "FIRST ANSWER")).not.toContain("\x1b[48;");
  expect(row(observation, "hovered", "chat", "FIRST ANSWER")).toContain("\x1b[48;");
  expect(observation.raw.hoveredSameAct).toEqual(observation.raw.hovered);
  expect(row(observation, "left", "chat", "FIRST ANSWER")).not.toContain("\x1b[48;");
  // A tool's clock opens the reply that called it.
  expect(body(observation, "clockJump", "chat").slice(0, 4).join("\n")).toContain("SECOND ANSWER");
  expect(pane(observation, "clockJump", "chat").join("\n")).toContain("● Conversation");
  // A request's Go to button opens the first work after it.
  expect(body(observation, "buttonJump", "activity").slice(0, 6).join("\n")).toContain("SECOND-PATH");
  // Go to from a zoomed panel restores the split first.
  expect(observation.frames.zoomed.join("\n")).not.toContain("Conversation");
  expect(observation.frames.restored.join("\n")).toContain("Conversation");
  expect(body(observation, "restored", "chat").slice(0, 4).join("\n")).toContain("FIRST ANSWER");
}, 90_000);

test("act clock colors come from settings and hover is unavailable inside a terminal multiplexer", async () => {
  const observation = await run("act-settings", "settings", { ...NO_MARKS, actHover: true, goTo: "clock" }, { TMUX: "/tmp/act-test,1,0" });
  const settings = observation.frames.settings.join("\n");
  expect(settings).toMatch(/Highlight on hover\s+unavailable/);
  expect(settings).toMatch(/Act clock color\s+off/);
  expect(settings).toMatch(/Act stripe\s+off/);
  expect(settings).toMatch(/Act separator\s+off/);
  expect(settings).toMatch(/Go to\s+clock/);
  // The same act has the same clock color in both panels.
  const clockColor = (line: string): string | undefined =>
    /\d{2}:\d{2}:\d{2}/.test(stripTerminalSequences(line)) ? /48;(?:2;\d+;\d+;\d+|5;\d+)/.exec(line)?.[0] : undefined;
  const activity = pane(observation, "colored", "activity", true);
  const toolRow = activity.findIndex(line => stripTerminalSequences(line).includes("FIRST-PATH"));
  const activityClock = activity.slice(0, toolRow).reverse().map(clockColor).find(Boolean);
  const chat = pane(observation, "colored", "chat", true);
  const requestRow = chat.findIndex(line => stripTerminalSequences(line).includes("FIRST REQUEST"));
  const chatClock = chat.slice(0, requestRow).reverse().map(clockColor).find(Boolean);
  expect(activityClock).toBeDefined();
  expect(chatClock).toBe(activityClock);
  expect(observation.raw.unavailableHover).toEqual(observation.raw.colored);
}, 90_000);
