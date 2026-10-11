import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("reloads twice with one clean split, stable history clocks and a full-width dock", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/reload-"));
  const agent = await mkdtemp(path.resolve("tmp/reload-agent-"));
  try {
    const manager = SessionManager.create(cwd, cwd);
    manager.appendMessage({ role: "user", content: "SAVED USER", timestamp: Date.parse("2001-10-09T01:02:03Z") });
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "right", chatWidth: 40, layout: "rows", chatHeight: 24, zoom: null,
    }));
    const run = await new PiIntegrationTest({
      testName: "two-reloads", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC", PI_TRANSCRIPT_TEST_SESSION: manager.getSessionFile()!,
        RELOAD_FRAMES_FILE: path.resolve("tmp/test-runs/two-reloads/reload-frames.json") },
      // Three startups and two reloads share one trace deadline, not a latency assertion.
      timeoutMs: 60_000, rawMode: false, tuiSize: { cols: 120, rows: 45 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/reload-controls.ts")],
      tools: [], conversation: [assistantMessage([text("FRESH ANSWER")])],
    }).run("/transcript-reload-check");
    expect(run.providerRequests).toHaveLength(1);
    const state: { reloads: number; frames: string[][] } = JSON.parse(await readFile(path.resolve("tmp/test-runs/two-reloads/reload-frames.json"), "utf8"));
    expect(state.reloads).toBe(2);
    expect(state.frames).toHaveLength(4);
    for (const frame of state.frames) {
      const lines = frame.map(stripTerminalSequences);
      expect(lines.filter(line => line.includes("[ ≡ ]"))).toHaveLength(1);
      expect(lines.filter(line => line.includes("Activity") && line.includes("[ ↗ ]"))).toHaveLength(1);
      expect(lines.filter(line => line.includes("Conversation") && line.includes("[ ↗ ]"))).toHaveLength(1);
      expect(lines.filter(line => /SAVED USER\s+01:02:03\s*[┃│]?$/.test(line.trim())), lines.join("\n")).toHaveLength(1);
      expect(lines.join("\n")).toContain("SAVED USER");
      expect(lines.join("\n")).not.toContain("pi-stereo-view split is unavailable");
      expect(lines.join("\n")).not.toContain("pi-stereo-view split disabled");
      expect(lines.slice(-5).some(line => line.includes("─".repeat(120)))).toBe(true);
    }
    expect(state.frames.at(-1)!.map(stripTerminalSequences).join("\n")).toContain("FRESH ANSWER");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 90_000);
