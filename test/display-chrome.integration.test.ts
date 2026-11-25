import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const artifactsDir = path.resolve("tmp/test-runs");
const transcript = (pane: string): string => [
  "```",
  ...Array.from({ length: 60 }, (_, index) => `${pane} ${String(index).padStart(2, "0")}`),
  "```",
].join("\n");

function seedHistory(cwd: string): string {
  const session = SessionManager.create(cwd, cwd);
  const at = Date.parse("2026-01-01T10:00:00Z");
  session.appendMessage({ role: "user", content: "Prepare a report.", timestamp: at });
  session.appendMessage({
    role: "assistant", content: [
      { type: "thinking", thinking: transcript("WORK ROW") },
      { type: "text", text: transcript("REPORT ROW") },
    ], timestamp: at + 1000, api: "openai-responses", provider: "openai", model: "chrome-fixture",
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  return session.getSessionFile()!;
}

test("hiding toolbar and pane headers frees history rows and keeps keyboard controls available", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/display-chrome-"));
  try {
    const agent = path.join(cwd, "agent");
    await mkdir(agent);
    const file = path.join(agent, "transcript.json");
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false }));
    // Saved arrangement overrides. The launcher supplies the visible, icon-button baseline.
    await writeFile(file, JSON.stringify({ side: "left", chatWidth: 44, showTimestamps: false, showCopyButtons: false }));
    const session = seedHistory(cwd);
    const run = async (phase: "toggle" | "restart"): Promise<Record<string, string[]>> => {
      const name = `display-chrome-${phase}`;
      const result = await new PiIntegrationTest({
        testName: name, artifactsDir, cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session, CHROME_PHASE: phase },
        rawMode: false, tuiSize: { cols: 120, rows: 30 },
        extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/display-chrome-probe.ts")],
        tools: [], conversation: [assistantMessage([text("Report saved.", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } })])],
      }).run("Record the report.");
      expect(result.exitCode).toBe(0);
      const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, name + ".json"), "utf8"));
      await writeFile(path.join(artifactsDir, name, "frames.json"), JSON.stringify(frames, null, 2));
      return Object.fromEntries(Object.entries(frames).map(([key, lines]) => [key, lines.map(stripTerminalSequences)]));
    };
    const toolbar = (lines: string[]): boolean => lines.some(line => line.includes("[ ≡ ]"));
    const headers = (lines: string[]): number => lines.join("\n").match(/\[ ↗ \]/gu)?.length ?? 0;
    const rows = (lines: string[], marker: string): number => lines.filter(line => line.includes(marker)).length;
    const frames = await run("toggle");
    for (const [name, showToolbar, headerCount] of [
      ["initial", true, 2], ["toolbarHidden", false, 2], ["columnsHidden", false, 0],
      ["settingsToolbar", true, 0], ["restored", true, 2], ["settingsHeaders", true, 0],
      ["rows", true, 2], ["rowsHidden", false, 0], ["combined", false, 0], ["split", false, 0],
    ] as const) {
      expect(toolbar(frames[name]), name).toBe(showToolbar);
      expect(headers(frames[name]), name).toBe(headerCount);
    }
    for (const marker of ["REPORT ROW", "WORK ROW"]) {
      expect(rows(frames.initial, marker)).toBeGreaterThan(0);
      expect(rows(frames.toolbarHidden, marker) - rows(frames.initial, marker)).toBe(1);
      expect(rows(frames.columnsHidden, marker) - rows(frames.initial, marker)).toBe(4);
    }
    const stackRows = (frame: string[]): number => rows(frame, "REPORT ROW") + rows(frame, "WORK ROW");
    expect(stackRows(frames.rowsHidden) - stackRows(frames.rows)).toBe(6);
    const rowDivider = (frame: string[]): number => frame.findIndex(line => line.startsWith("═".repeat(120)));
    expect(rowDivider(frames.rowsHidden)).toBeGreaterThan(2);
    expect(rowDivider(frames.rowsDragged)).toBe(2);
    expect(rows(frames.columnsHidden, "REPORT ROW 03")).toBe(0);
    expect(frames.search.some(line => line.includes("[ ↓ ]") && line.includes("1/1"))).toBe(true);
    expect(frames.search.some(line => line.includes("REPORT ROW 03") && !line.includes("[ ↓ ]"))).toBe(true);
    expect(headers(frames.search)).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      layout: "rows", chatHeight: 2, showToolbar: false, showPaneHeaders: false,
    });

    const restarted = await run("restart");
    expect(toolbar(restarted.initial)).toBe(false);
    expect(headers(restarted.initial)).toBe(0);
    expect(rowDivider(restarted.initial)).toBe(2);
    expect(toolbar(restarted.restored)).toBe(true);
    expect(headers(restarted.restored)).toBe(2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);
