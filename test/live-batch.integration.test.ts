import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const ide = process.env.PI_STEREO_TEST_IDE_ROOT;
interface Capture {
  panes: { activity: string[] };
  search: { activity: { text: string }[] };
  toolIds: string[];
  originalSources: boolean;
  children: { type: string; text: string }[];
  copies: string[];
  originalRenderers: boolean;
  folded: string[];
  group?: { closed: string[]; opened: string[]; reclosed: string[]; reopened: string[]; panelCounts: number[][] };
  individual?: { panelCounts: number[]; calls: { id: string; expandable: boolean; panelCounts: number[][] }[] };
}

test.skipIf(!ide).each(["success", "rejected"])("expands a nested replace group with its original %s panel live and after resume", async outcome => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/live-batch-"));
  try {
    const agent = path.join(cwd, ".pi");
    await mkdir(path.join(agent, "pi-agent-ide"), { recursive: true });
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, codemode: { mode: "on" } }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ mode: "split", side: "left", chatWidth: 45, layout: "columns", showTimestamps: false, compactTools: true }));
    await writeFile(path.join(agent, "pi-agent-ide/extensions.json"), JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }));
    await writeFile(path.join(cwd, "a.txt"), "before-a\n");
    await writeFile(path.join(cwd, "b.txt"), "before-b\n");
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "Apply both edits", timestamp: Date.now() });
    const code = `const results = await Promise.allSettled([tools.replace({path:"a.txt",start:"before-a",text:"${outcome === "rejected" ? "GUARDED" : "AFTER-A"}"}),tools.replace({path:"b.txt",start:"before-b",text:"AFTER-B"})]); for (const result of results) text(result);`;
    for (const phase of ["live", "resume"] as const) {
      const captureFile = path.join(cwd, `${phase}-capture.json`);
      const run = await new PiIntegrationTest({
        testName: `live-parallel-batch-${outcome}-${phase}`, artifactsDir: testArtifactsDir(import.meta.filename, path.resolve("tmp/test-runs")), cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false, rawMode: false, tuiSize: { cols: 180, rows: 70 },
        extensions: ["builtin:codemode", path.join(ide!, "src/pi-agent-ide.ts"), path.join(ide!, "tests/integration/support/native-text-edit-probe.ts"), path.resolve("src/index.ts"), path.resolve("test/fixtures/nested-activity-probe.ts")],
        tools: ["codemode", "replace"],
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!, NESTED_ACTIVITY_CAPTURE: captureFile, NESTED_ACTIVITY_CALLER: "codemode", NESTED_ACTIVITY_INDIVIDUAL: outcome === "rejected" ? "1" : "" },
        conversation: phase === "live" ? [assistantMessage([toolCall({ id: "parent", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }), assistantMessage([text("Done")])] : [assistantMessage([text("Resumed")])],
      }).run(phase === "live" ? "Apply both edits" : "Inspect saved edits");
      expect(run.exitCode).toBe(0);
      const { settled: capture } = JSON.parse(await readFile(captureFile, "utf8")) as { settled: Capture };
      const activity = capture.panes.activity.map(stripTerminalSequences).join("\n");
      expect(capture.originalSources).toBe(true);
      expect(capture.originalRenderers).toBe(true);
      const root = capture.folded.find(line => /●\s+▾\s+codemode\b/u.test(line));
      const collapsedGroup = capture.folded.find(line => /●\s+▸\s+replace\s+×2/u.test(line));
      expect(root).toBeDefined();
      expect(collapsedGroup).toBeDefined();
      expect(collapsedGroup!.indexOf("●")).toBeGreaterThan(root!.indexOf("●"));
      expect(capture.group).toBeDefined();
      if (outcome === "success") expect(capture.group!.panelCounts).toEqual([[0], [1], [0], [1]]);
      else {
        expect(capture.group!.panelCounts).toEqual([[], [], [], []]);
        expect(capture.individual?.panelCounts).toEqual([0, 0]);
        expect(capture.individual?.calls).toHaveLength(2);
        for (const [index, call] of capture.individual!.calls.entries()) {
          expect(call.expandable, call.id).toBe(true);
          const visible = [0, 0]; visible[index] = 1;
          expect(call.panelCounts).toEqual([[0, 0], visible, [0, 0], visible]);
        }
      }
      const groupLines = capture.group!.opened.filter(line => /●\s+(?:[▸▾]\s+)?replace\b/u.test(line));
      expect(groupLines).toHaveLength(3);
      for (const file of ["a.txt", "b.txt"]) {
        const leaf = groupLines.find(line => line.includes(file));
        expect(leaf).toBeDefined();
        expect(leaf!.indexOf("●")).toBeGreaterThan(collapsedGroup!.indexOf("●"));
        expect(capture.group!.reclosed.some(line => /●\s+(?:[▸▾]\s+)?replace\b/u.test(line) && line.includes(file))).toBe(false);
      }
      expect(capture.toolIds).toEqual(["parent"]);
      expect(capture.children).toHaveLength(1);
      expect(capture.children[0].type).toBe("CustomEntryComponent");
      const panel = stripTerminalSequences(capture.children[0].text);
      if (outcome === "success") {
        if (phase === "live") {
          expect(getToolExecution(run, "parent").isError).toBe(false);
          expect(getToolResultText(run, "parent")).toContain("AFTER-A");
        }
        expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("AFTER-A\n");
        expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("AFTER-B\n");
        for (const value of ["AFTER-A", "AFTER-B"]) {
          expect(panel).toContain(value);
          expect(capture.copies.some(copy => copy.includes(value))).toBe(true);
        }
        const openedGroup = capture.group!.opened.join("\n");
        expect(openedGroup.match(/│\s+1 ~ AFTER-A/gu)).toHaveLength(1);
        expect(openedGroup.match(/│\s+1 ~ AFTER-B/gu)).toHaveLength(1);
        expect(capture.group!.closed.join("\n")).not.toMatch(/│\s+1 ~ AFTER-[AB]/u);
        expect(activity.match(/│\s+1 ~ AFTER-A/gu)).toHaveLength(1);
        expect(activity.match(/│\s+1 ~ AFTER-B/gu)).toHaveLength(1);
        expect(activity).toMatch(/╭─ .*a\.txt/gu);
        expect(activity).toMatch(/╭─ .*b\.txt/gu);
      } else {
        if (phase === "live") {
          expect(getToolExecution(run, "parent").isError).toBe(true);
          expect(getToolResultText(run, "parent")).toContain("fixture rejected the combined write");
        }
        expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("before-a\n");
        expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("before-b\n");
        expect(capture.search.activity.some(entry => entry.text.includes("fixture rejected the combined write"))).toBe(true);
        expect(activity).toContain("fixture rejected the combined write");
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
