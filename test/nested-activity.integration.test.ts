import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

interface Capture { panes: Record<string, string[]>; search: Record<string, { text: string; label: string }[]>; screen: string[]; toolIds: string[]; originalSources: boolean; originalRenderers: boolean; copies: string[]; folded: string[]; group?: { closed: string[]; opened: string[]; reclosed: string[]; reopened: string[]; panelCounts: number[][] } }
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test.each([[false, "parent"], [true, "parent"], [false, "codemode"], [true, "codemode"]] as const)("expands the nested call tree while retaining the parent's renderer live and after resume (compact: %s, caller: %s)", async (compactTools, caller) => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/nested-activity-"));
  const agent = await mkdtemp(path.resolve("tmp/nested-activity-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      layout: "columns", side: "left", chatWidth: 45, showTimestamps: false, compactTools,
    }));
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "SAVED-USER-82", timestamp: Date.now() });
    for (const phase of ["live", "resume"] as const) {
      const captureFile = path.join(cwd, phase + ".json");
      const result = await new PiIntegrationTest({
        testName: `nested-activity-${caller}-${compactTools}-${phase}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!, NESTED_ACTIVITY_CAPTURE: captureFile, NESTED_ACTIVITY_CALLER: caller },
        rawMode: false, tuiSize: { cols: 180, rows: 60 }, timeoutMs: 60_000,
        extensions: ["builtin:codemode", path.resolve("src/index.ts"), path.resolve("test/fixtures/nested-activity-probe.ts")],
        tools: ["codemode", "nested_activity_parent", "nested_activity_leaf"],
        conversation: phase === "live" ? [
          assistantMessage([toolCall({ id: "parent-82", name: caller === "parent" ? "nested_activity_parent" : "codemode", arguments: caller === "parent" ? {} : { code: `const calls = [tools.nested_activity_leaf({marker: "ARG-P82", fail: false}), tools.nested_activity_leaf({marker: "ARG-Q82", fail: true})]; for (const result of await Promise.allSettled(calls)) text(result.status === "fulfilled" ? result.value : result.reason.message);` } })], { stopReason: "toolUse" }),
          assistantMessage([text("ANSWER-82")]),
        ] : [assistantMessage([text("RESUMED-82")])],
      }).run(phase === "live" ? "Run nested calls" : "Inspect saved activity");
      expect(result.exitCode).toBe(0);
      if (phase === "live") {
        expect(getToolExecution(result, "parent-82").isError).toBe(false);
        expect(getToolResultText(result, "parent-82")).toContain("SUCCESS-RESULT-P82");
        expect(getToolResultText(result, "parent-82")).toContain("FAILURE-RESULT-Q82");
      }
      const captures: Record<string, Capture> = JSON.parse(await readFile(captureFile, "utf8"));
      const settled = captures.settled;
      // Results persist through the original parent's result, not synthesized nested history.
      for (const value of ["SUCCESS-RESULT-P82", "FAILURE-RESULT-Q82"]) {
        expect(plain(settled.panes.activity)).toContain(value);
        expect(settled.search.activity.some(entry => entry.text.includes(value))).toBe(true);
        expect(settled.copies.some(copy => copy.includes(value))).toBe(true);
      }
      expect(plain(settled.panes.activity)).not.toContain("NATIVE-RESULT-P82");
      if (caller === "codemode") {
        const activity = plain(settled.panes.activity);
        expect(activity).toMatch(/✓ nested_activity_leaf[^\n]*ARG-P82/u);
        expect(activity).toMatch(/✗ nested_activity_leaf[^\n]*ARG-Q82/u);
      } else {
        expect(plain(settled.panes.activity)).toContain("ARG-P82: ok");
        expect(plain(settled.panes.activity)).toContain("ARG-Q82: error");
      }
      for (const snapshot of phase === "live" ? [captures.running, settled] : [settled]) {
        expect(snapshot.originalSources).toBe(true);
        expect(snapshot.originalRenderers).toBe(true);
        const leaves = plain(snapshot.panes.activity).split("\n").filter(line => /●\s+(?:[▸▾]\s+)?nested_activity_leaf\b/u.test(line) && /ARG-[PQ]82/u.test(line));
        expect(leaves).toHaveLength(2);
        for (const marker of ["ARG-P82", "ARG-Q82"]) expect(leaves.some(line => line.includes(marker))).toBe(true);
        if (compactTools) {
          const parentName = caller === "parent" ? "nested_activity_parent" : caller;
          const root = snapshot.folded.find(line => /●\s+▾/u.test(line) && line.includes(parentName));
          expect(root).toBeDefined();
          for (const leaf of leaves) expect(leaf.indexOf("●")).toBeGreaterThan(root!.indexOf("●"));
          if (snapshot === captures.running) {
            const group = snapshot.folded.find(line => /●\s+▸\s+nested_activity_leaf\s+×2/u.test(line));
            expect(group).toBeDefined();
            expect(snapshot.group).toBeDefined();
            expect(snapshot.group!.closed.some(line => /●\s+(?:[▸▾]\s+)?nested_activity_leaf\b/u.test(line) && line.includes("ARG-P82"))).toBe(false);
            expect(snapshot.group!.opened.filter(line => /●\s+(?:[▸▾]\s+)?nested_activity_leaf\b/u.test(line))).toHaveLength(3);
          }
        }
        expect(snapshot.toolIds).toEqual(["parent-82"]);
        const activity = plain(snapshot.panes.activity);
        const search = snapshot.search.activity.map(entry => entry.text).join("\n");
        for (const marker of ["ARG-P82", "ARG-Q82"]) {
          expect(activity).toContain(marker);
          expect(plain(snapshot.screen)).toContain(marker);
          expect(search).toContain(marker);
          expect(plain(snapshot.panes.chat)).not.toContain(marker);
        }
      }
    }
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 120_000);
