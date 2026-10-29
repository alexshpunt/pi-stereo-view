import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

interface Capture { panes: Record<string, string[]>; search: Record<string, { text: string; label: string }[]>; screen: string[] }
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test.each([[false, "parent"], [true, "parent"], [false, "codemode"], [true, "codemode"]] as const)("shows real concurrent nested calls while running and after reopening their session (compact: %s, caller: %s)", async (compactTools, caller) => {
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
        testName: "nested-activity-" + phase, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!, NESTED_ACTIVITY_CAPTURE: captureFile, NESTED_ACTIVITY_CALLER: caller },
        rawMode: false, tuiSize: { cols: 180, rows: 60 }, timeoutMs: 60_000,
        extensions: ["builtin:codemode", path.resolve("src/index.ts"), path.resolve("test/fixtures/nested-activity-probe.ts")],
        tools: ["codemode", "nested_activity_parent", "nested_activity_leaf"],
        conversation: phase === "live" ? [
          assistantMessage([toolCall({ id: "parent-82", name: caller === "parent" ? "nested_activity_parent" : "codemode", arguments: caller === "parent" ? {} : { code: `const calls = [tools.nested_activity_leaf({marker: "ARG-P82", fail: false}), tools.nested_activity_leaf({marker: "ARG-Q82", fail: true})]; await Promise.allSettled(calls);` } })], { stopReason: "toolUse" }),
          assistantMessage([text("ANSWER-82")]),
        ] : [assistantMessage([text("RESUMED-82")])],
      }).run(phase === "live" ? "Run nested calls" : "Inspect saved activity");
      expect(result.exitCode).toBe(0);
      if (phase === "live") expect(getToolExecution(result, "parent-82").isError).toBe(false);
      const captures: Record<string, Capture> = JSON.parse(await readFile(captureFile, "utf8"));
      if (phase === "live" && caller === "codemode") {
        expect(plain(captures.settled.panes.activity)).toContain("NATIVE-RESULT-P82");
      }
      if (phase === "live") {
        const search = captures.settled.search.activity.map(entry => entry.text).join("\n");
        expect(search).toContain("SUCCESS-RESULT-P82");
        expect(search).toContain("FAILURE-RESULT-Q82");
      } else {
        const search = captures.settled.search.activity.map(entry => entry.text).join("\n");
        expect(search).not.toContain("SUCCESS-RESULT-P82");
        expect(search).toContain("FAILURE-RESULT-Q82");
      }
      for (const snapshot of phase === "live" ? [captures.running, captures.settled] : [captures.settled]) {
        const activity = plain(snapshot.panes.activity);
        const search = snapshot.search.activity.map(entry => entry.text).join("\n");
        for (const marker of ["ARG-P82", "ARG-Q82"]) {
          expect(activity).toContain(marker);
          expect(search).toContain(marker);
          expect(plain(snapshot.panes.chat)).not.toContain(marker);
        }
      }
    }
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 120_000);
