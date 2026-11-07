import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test.each([true, false])("reloads twice with stable clocks, a full-width dock and copy icons %s", async showCopyButtons => {
  const testName = showCopyButtons ? "two-reloads" : "two-reloads-hidden-copy";
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/reload-"));
  const agent = await mkdtemp(path.resolve("tmp/reload-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    const manager = SessionManager.create(cwd, cwd);
    manager.appendMessage({ role: "user", content: "SAVED USER", timestamp: Date.parse("2001-10-09T01:02:03Z") });
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "right", chatWidth: 40, layout: "rows", chatHeight: 24, zoom: null, showCopyButtons,
    }));
    const run = await new PiIntegrationTest({
      testName, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      // Keep native collapsed tools so the harness adds no startup expansion notice.
      environment: { PI_CODING_AGENT_DIR: agent, PI_INTEGRATION_TEST_LIVE: "1", TZ: "UTC", PI_TRANSCRIPT_TEST_SESSION: manager.getSessionFile()!,
        RELOAD_FRAMES_FILE: path.resolve("tmp/test-runs", testName, "reload-frames.json") },
      // Three startups and two reloads share one trace deadline, not a latency assertion.
      timeoutMs: 60_000, rawMode: false, tuiSize: { cols: 120, rows: 45 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/reload-controls.ts")],
      tools: [], conversation: [assistantMessage([text("FRESH ANSWER")])],
    }).run("/transcript-reload-check");
    expect(run.providerRequests).toHaveLength(1);
    const state: { reloads: number; frames: string[][] } = JSON.parse(await readFile(path.resolve("tmp/test-runs", testName, "reload-frames.json"), "utf8"));
    expect(state.reloads).toBe(2);
    expect(state.frames).toHaveLength(4);
    for (const frame of state.frames) {
      const lines = frame.map(stripTerminalSequences);
      expect(lines.filter(line => line.includes("[ ≡ ]"))).toHaveLength(1);
      expect(lines.filter(line => line.includes("Activity") && line.includes("[ ↗ ]"))).toHaveLength(1);
      expect(lines.filter(line => line.includes("Conversation") && line.includes("[ ↗ ]"))).toHaveLength(1);
      const savedRow = lines.findIndex(line => line.includes("SAVED USER"));
      expect(savedRow, lines.join("\n")).toBeGreaterThan(0);
      expect(lines[savedRow]).not.toContain("⧉");
      expect(lines[savedRow]).not.toContain("\u034f");
      expect(lines.slice(Math.max(0, savedRow - 3), savedRow).join("\n")).toContain("01:02:03");
      if (showCopyButtons) expect(lines.slice(savedRow + 1, savedRow + 4).join("\n")).toContain("⧉\u034f");
      else expect(lines.join("\n")).not.toContain("⧉");
      expect(lines.join("\n")).toContain("SAVED USER");
      expect(lines.join("\n")).not.toContain("pi-stereo-view split is unavailable");
      expect(lines.join("\n")).not.toContain("pi-stereo-view split disabled");
      const footer = lines.findIndex(line => line.includes(path.basename(cwd)));
      expect(footer).toBeGreaterThan(2);
      expect(lines[footer - 1]).toBe("─".repeat(120));
      expect(lines[footer - 3]).toBe("─".repeat(120));
    }
    expect(state.frames.at(-1)!.map(stripTerminalSequences).join("\n")).toContain("FRESH ANSWER");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 90_000);
