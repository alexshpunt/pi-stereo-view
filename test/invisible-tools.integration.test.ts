import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, getToolExecutionResult, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const artifactsDir = testArtifactsDir(import.meta.filename, path.resolve("tmp/test-runs"));
const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");
const imageRows = (lines: string[]): string[] => lines.filter(line => line.includes("\x1b_G") || line.includes("\x1b]1337;File="));
interface Snapshot {
  blocks: Record<string, string[]>;
  nativeBlocks: Record<string, string[]>;
  lines: string[];
  chat: string[];
  screen: string[];
  sourceChildrenUnchanged: boolean;
}
interface Capture {
  stages: Record<string, Snapshot>;
  revealed: boolean;
  searchRow?: number;
  searched: string[];
  clickedVisibleResult: boolean;
}

// Package discovery and session reconstruction are part of the native-rendering contract.
test.each(["columns", "rows"] as const)("omits invisible image tools without losing visible output in %s", async layout => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/invisible-tools-"));
  const agent = await mkdtemp(path.resolve("tmp/invisible-tools-agent-"));
  try {
    const probe = path.join(cwd, "visibility-probe");
    await mkdir(probe);
    await writeFile(path.join(probe, "package.json"), JSON.stringify({ name: "unrelated-visibility-probe", pi: { extensions: ["probe.ts"] } }));
    await writeFile(path.join(probe, "probe.ts"), `export { default } from ${JSON.stringify(path.resolve("test/fixtures/invisible-tool-probe.ts"))};\n`);
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, packages: [path.resolve("."), probe] }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", chatWidth: 60, layout, chatHeight: 20, zoom: null, showTimestamps: true,
    }));
    const session = SessionManager.create(cwd, cwd);
    for (const phase of ["live", "resume"] as const) {
      const name = `invisible-tools-${layout}-${phase}`;
      const file = path.join(artifactsDir, name, "invisible-tools.json");
      const result = await new PiIntegrationTest({
        testName: name, artifactsDir, cwd, rawMode: false, tuiSize: { cols: 160, rows: 60 },
        piCommand: path.resolve("test/fixtures/startup-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!,
          PI_IMAGE_PROTOCOL: "kitty", INVISIBLE_TOOLS_FILE: file },
        extensions: [], tools: ["silent_picture", "changing_picture", "plain_picture", "painted_picture"],
        conversation: phase === "live" ? [
          ...["silent_picture", "changing_picture", "plain_picture", "painted_picture"].map(tool => assistantMessage([
            toolCall({ id: tool.replace("_", "-"), name: tool, arguments: {} }),
          ], { stopReason: "toolUse" })),
          assistantMessage([text("VISIBLE FINAL DIALOGUE")]),
        ] : [assistantMessage([text("VISIBLE RESUMED DIALOGUE")])],
      }).run(phase === "live" ? "Exercise the invisible and visible image tools" : "Inspect restored visibility");
      expect(result.exitCode).toBe(0);
      expect(result.providerRequests).toHaveLength(phase === "live" ? 5 : 1);
      if (phase === "live") {
        for (const id of ["silent-picture", "changing-picture", "plain-picture", "painted-picture"]) {
          expect(getToolExecution(result, id).isError).toBe(false);
          const toolResult = getToolExecutionResult(result, id) as { content: { type: string }[] };
          expect(toolResult.content.some(block => block.type === "image")).toBe(true);
        }
        expect(getToolResultText(result, "silent-picture")).toContain("HIDDEN AGENT RESULT");
      }
      const capture: Capture = JSON.parse(await readFile(file, "utf8"));
      const final = capture.stages.final;
      expect(final.sourceChildrenUnchanged).toBe(true);
      for (const id of ["silent-picture", "changing-picture"]) {
        expect(imageRows(final.nativeBlocks[id]), "The fixture must reproduce native automatic image placement").not.toHaveLength(0);
        expect(final.blocks[id] ?? [], `${id} must occupy no projected rows, separator or clock`).toEqual([]);
      }
      for (const id of ["plain-picture", "painted-picture"]) {
        expect(imageRows(final.blocks[id] ?? []), `${id} must retain its native image placement`).not.toHaveLength(0);
        expect(clean(final.blocks[id]).match(/\b\d\d:\d\d:\d\d\b/g)).toHaveLength(1);
      }
      expect(clean(final.lines)).toContain("VISIBLE CUSTOM CALL");
      expect(clean(final.lines)).toContain("VISIBLE CUSTOM RESULT");
      expect(clean(final.lines)).toContain("VISIBLE LINKED DIAGNOSTIC");
      expect(clean(final.chat)).not.toContain("VISIBLE LINKED DIAGNOSTIC");
      expect(clean(final.lines)).not.toContain("HIDDEN AGENT RESULT");
      expect(clean(final.screen)).toContain("Activity");
      expect(capture.revealed).toBe(true);
      expect(capture.searchRow).toBeTypeOf("number");
      expect(stripTerminalSequences(capture.searched[capture.searchRow!])).toContain("VISIBLE LINKED DIAGNOSTIC");
      expect(capture.clickedVisibleResult, "Hidden rows must not shift the visible tool's mouse target").toBe(true);
      if (phase === "live") {
        for (const stage of ["start", "hiddenPartial", "hiddenAgain"]) {
          expect(capture.stages[stage].blocks["changing-picture"] ?? [], stage).toEqual([]);
          expect(capture.stages[stage].sourceChildrenUnchanged).toBe(true);
        }
        expect(clean(capture.stages.visiblePartial.blocks["changing-picture"])).toContain("VISIBLE PARTIAL RESULT");
        expect(imageRows(capture.stages.visiblePartial.blocks["changing-picture"])).not.toHaveLength(0);
      }
    }
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 60_000);
