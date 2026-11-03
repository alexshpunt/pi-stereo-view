import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const ide = process.env.PI_STEREO_TEST_IDE_ROOT;

test.skipIf(!ide).each(["success", "rejected"])("shows the %s result of parallel IDE edits in the live activity pane", async outcome => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/live-batch-"));
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({ codemode: { mode: "on" } }));
    await writeFile(path.join(cwd, ".pi/transcript.json"), JSON.stringify({ mode: "split", side: "left", chatWidth: 45, layout: "columns", chatHeight: 20, zoom: null, showTimestamps: false }));
    await writeFile(path.join(cwd, ".pi/pi-agent-ide/extensions.json"), JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }));
    await writeFile(path.join(cwd, "a.txt"), "before-a\n");
    await writeFile(path.join(cwd, "b.txt"), "before-b\n");
    const code = `const results = await Promise.allSettled([tools.replace({path:"a.txt",start:"before-a",text:"${outcome === "rejected" ? "GUARDED" : "AFTER-A"}"}),tools.replace({path:"b.txt",start:"before-b",text:"AFTER-B"})]); for (const result of results) text(result);`;
    const run = await new PiIntegrationTest({
      testName: "live-parallel-batch", artifactsDir: testArtifactsDir(import.meta.filename, path.resolve("tmp/test-runs")), cwd,
      isolateUserResources: true, rawMode: false, tuiSize: { cols: 180, rows: 70 },
      extensions: ["builtin:codemode", path.join(ide!, "src/pi-agent-ide.ts"), path.join(ide!, "tests/integration/support/native-text-edit-probe.ts"), path.resolve("src/index.ts"), path.join(ide!, "tests/integration/code-review/capture.ts")],
      tools: ["codemode", "replace"],
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi") },
      conversation: [assistantMessage([toolCall({ id: "parent", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }), assistantMessage([text("Done")])],
    }).run("Apply both edits");
    const capture = JSON.parse(await readFile(path.join(cwd, "review-capture.json"), "utf8")) as { panes: { activity: string[] }; search: { activity: string[] } };
    const activity = capture.panes.activity.map(stripTerminalSequences).join("\n");
    const children = capture.search.activity.filter(entry => entry.startsWith("replace\n"));
    if (outcome === "success") {
      expect(getToolExecution(run, "parent").isError).toBe(false);
      expect(getToolResultText(run, "parent")).toContain("AFTER-A");
      expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("AFTER-A\n");
      expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("AFTER-B\n");
      expect(children.some(child => child.includes("AFTER-A") && child.includes("AFTER-B"))).toBe(true);
      expect(activity.match(/│\s+1 ~ AFTER-A/gu)).toHaveLength(1);
      expect(activity.match(/│\s+1 ~ AFTER-B/gu)).toHaveLength(1);
      expect(activity).toMatch(/╭─ .*a\.txt/gu);
      expect(activity).toMatch(/╭─ .*b\.txt/gu);
    } else {
      expect(getToolExecution(run, "parent").isError).toBe(true);
      expect(getToolResultText(run, "parent")).toContain("fixture rejected the combined write");
      expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("before-a\n");
      expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("before-b\n");
      expect(children.some(child => child.includes("fixture rejected the combined write"))).toBe(true);
      expect(activity).toContain("fixture rejected the combined write");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
