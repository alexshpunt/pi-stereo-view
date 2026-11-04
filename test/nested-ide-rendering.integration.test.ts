import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const ide = process.env.PI_STEREO_VIEW_IDE_PATH ?? "";
interface Capture {
  folded: string[];
  originalSources: boolean;
  originalRenderers: boolean;
  panes: { activity: string[] };
  search: { activity: { text: string }[] };
  individual?: {
    grouped: string[];
    panelCounts: number[];
    calls: { id: string; name: string; expandable: boolean; closed: string[]; opened: string[]; reclosed: string[]; reopened: string[]; panelCounts: number[][] }[];
  };
}

test.skipIf(!ide)("opens each original Read, Bash and Search result independently live and after resume", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/nested-ide-"));
  const agent = await mkdtemp(path.resolve("tmp/nested-ide-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ layout: "columns", side: "left", chatWidth: 45, compactTools: true }));
    for (let i = 1; i <= 3; i++) await writeFile(path.join(cwd, `fixture-${i}.txt`), `IDE-RESULT-FIXTURE-83-${i}\n`);
    await writeFile(path.join(cwd, "search-fixture.txt"), "SEARCH-RESULT-FIXTURE-83\n");
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "Run nested tools", timestamp: Date.now() });
    const code = 'for (let i = 1; i <= 3; i++) text(await tools.read({path:"fixture-"+i+".txt"})); for (let i = 1; i <= 2; i++) text(await tools.bash({command:"printf BASH-RESULT-FIXTURE-83-"+i})); text(await tools.search({path:"search-fixture.txt",query:"SEARCH-RESULT-FIXTURE-83"}));';
    for (const phase of ["live", "resume"] as const) {
      const capture = path.join(cwd, `${phase}.json`);
      const result = await new PiIntegrationTest({
        testName: `nested-ide-${phase}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_IDE_PATH: ide,
          PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!, NESTED_ACTIVITY_CAPTURE: capture,
          NESTED_ACTIVITY_CALLER: "codemode", NESTED_ACTIVITY_INDIVIDUAL: "1" },
        rawMode: false, tuiSize: { cols: 180, rows: 60 }, timeoutMs: 60_000,
        extensions: ["builtin:codemode", path.resolve("src/index.ts"), path.resolve("test/fixtures/nested-activity-probe.ts")],
        tools: ["codemode", "read", "bash", "search"], conversation: phase === "live" ? [
          assistantMessage([toolCall({ id: "parent-83", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
          assistantMessage([text("Done")]),
        ] : [assistantMessage([text("Resumed")])],
      }).run("Run nested tools");
      expect(result.exitCode).toBe(0);
      if (phase === "live") expect(getToolExecution(result, "parent-83").isError).toBe(false);
      const data = JSON.parse(await readFile(capture, "utf8")) as Record<string, Capture>;
      const settled = data.settled;
      const folded = settled.folded.filter(line => !/●\s+[▸▾]\s+codemode\b/u.test(line)).join("\n");
      for (const [name, count] of [["read", 3], ["bash", 2]] as const)
        expect(settled.folded.some(line => line.includes(name) && line.includes(`×${count}`))).toBe(true);
      expect(folded).not.toContain("IDE-RESULT-FIXTURE-83");
      expect(folded).not.toContain("BASH-RESULT-FIXTURE-83");
      expect(settled.originalSources).toBe(true);
      expect(settled.originalRenderers).toBe(true);
      expect(settled.individual).toBeDefined();
      const individual = settled.individual!;
      expect(individual.panelCounts).toEqual([0, 0, 0, 0, 0, 0]);
      expect(individual.calls.map(call => call.name).sort()).toEqual(["bash", "bash", "read", "read", "read", "search"]);
      expect(new Set(individual.calls.map(call => call.id)).size).toBe(6);
      for (const [index, call] of individual.calls.entries()) {
        expect(call.expandable, `${phase}: ${call.name} ${call.id}`).toBe(true);
        const visible = [0, 0, 0, 0, 0, 0]; visible[index] = 1;
        expect(call.panelCounts, `${phase}: ${call.name} ${call.id}`).toEqual([
          [0, 0, 0, 0, 0, 0], visible, [0, 0, 0, 0, 0, 0], visible,
        ]);
      }
      const pane = settled.panes.activity.map(stripTerminalSequences).join("\n");
      for (const value of ["IDE-RESULT-FIXTURE-83-1", "IDE-RESULT-FIXTURE-83-2", "IDE-RESULT-FIXTURE-83-3", "BASH-RESULT-FIXTURE-83-1", "BASH-RESULT-FIXTURE-83-2", "SEARCH-RESULT-FIXTURE-83"]) {
        expect(pane).toContain(value);
        expect(settled.search.activity.some(entry => entry.text.includes(value))).toBe(true);
      }
    }
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 120_000);
