import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

interface Capture { screen: string[]; panes: { activity: string[] }; search: { activity: { text: string }[] }; children: { type: string; text: string }[]; toolIds: string[]; originalSources: boolean; originalRenderers: boolean; copies: string[]; folded: string[] }

test.each([false, true])("shows an independent call tree with its original opaque final panel live and after resume (compact: %s)", async compactTools => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/nested-foreign-"));
  const agent = await mkdtemp(path.resolve("tmp/nested-foreign-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ layout: "columns", side: "left", chatWidth: 45, compactTools }));
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "Run fixture", timestamp: Date.now() });
    for (const phase of ["live", "resume"] as const) {
      const capture = path.join(cwd, `${phase}.json`);
      const run = await new PiIntegrationTest({
        testName: `nested-foreign-${compactTools}-${phase}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!, NESTED_ACTIVITY_CAPTURE: capture, NESTED_ACTIVITY_CALLER: "foreign_parent" },
        rawMode: false, tuiSize: { cols: 180, rows: 60 }, timeoutMs: 60_000,
        extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/foreign-nested-panel.ts"), path.resolve("test/fixtures/nested-activity-probe.ts")],
        tools: ["foreign_parent", "foreign_leaf"], conversation: phase === "live" ? [
          assistantMessage([toolCall({ id: "foreign-parent-1", name: "foreign_parent", arguments: {} })], { stopReason: "toolUse" }),
          assistantMessage([text("Done")]),
        ] : [assistantMessage([text("Resumed")])],
      }).run("Run fixture");
      expect(run.exitCode).toBe(0);
      if (phase === "live") {
        expect(getToolExecution(run, "foreign-parent-1").isError).toBe(false);
        expect(getToolResultText(run, "foreign-parent-1")).toContain("PARENT-FOREIGN-FIXTURE");
      }
      const captureData = JSON.parse(await readFile(capture, "utf8")) as { settled: Capture };
      const settled = captureData.settled;
      const pane = settled.panes.activity.map(stripTerminalSequences).join("\n");
      expect(settled.originalSources).toBe(true);
      expect(settled.originalRenderers).toBe(true);
      const leaves = pane.split("\n").filter(line => /●\s+(?:[▸▾]\s+)?foreign_leaf\b/u.test(line));
      expect(leaves).toHaveLength(1);
      if (compactTools) {
        const root = settled.folded.find(line => /●\s+▾\s+foreign_parent\b/u.test(line));
        expect(root).toBeDefined();
        expect(leaves[0].indexOf("●")).toBeGreaterThan(root!.indexOf("●"));
      }
      expect(settled.toolIds).toEqual(["foreign-parent-1"]);
      expect(settled.children).toHaveLength(1);
      expect(settled.children[0].type).toBe("CustomEntryComponent");
      for (const value of ["FINAL-FOREIGN-FIXTURE", "EXTRA-FOREIGN-FIXTURE"]) {
        expect(pane).toContain(value);
        expect(settled.screen.map(stripTerminalSequences).join("\n")).toContain(value);
        expect(settled.search.activity.some(entry => entry.text.includes(value))).toBe(true);
        expect(settled.copies.some(copy => copy.includes(value))).toBe(true);
      }
      expect(pane).not.toContain("PROVISIONAL-FOREIGN-FIXTURE");
    }
  } finally { await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true }))); }
}, 120_000);
