import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const ide = process.env.PI_STEREO_VIEW_IDE_PATH ?? "";
const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");

test("shows a nested caller's late update only when its output is open", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/nested-report-"));
  const agent = await mkdtemp(path.resolve("tmp/nested-report-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ side: "left", chatWidth: 60, layout: "columns", chatHeight: 20, showTimestamps: false, compactTools: true }));
    const capture = path.join(cwd, "activity.json");
    const result = await new PiIntegrationTest({
      testName: "nested-linked-report", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, ACTIVITY_SNAPSHOT: capture, SYNTHETIC_NESTED_REPORT: "1" },
      rawMode: false, tuiSize: { cols: 180, rows: 60 }, timeoutMs: 60_000,
      extensions: ["builtin:codemode", path.resolve("src/index.ts"), path.resolve("test/fixtures/activity-snapshot.ts")], tools: ["codemode", "write"],
      conversation: [assistantMessage([toolCall({ id: "nested-edit", name: "codemode", arguments: { code: 'await tools.write({path:"nested.txt",content:"value"});' } })], { stopReason: "toolUse" }), assistantMessage([text("Done")])],
    }).run("Write a file");
    expect(result.exitCode).toBe(0);
    expect(getToolExecution(result, "nested-edit").isError).toBe(false);
    const snapshot = JSON.parse(await readFile(capture, "utf8")) as { panes: Record<string, string[]>; opened: string[]; outputOpened: string[] };
    for (const lines of [snapshot.panes.activity, snapshot.opened]) expect(clean(lines)).not.toContain("NESTED REPORT DATA");
    expect(clean(snapshot.outputOpened).split("NESTED REPORT DATA")).toHaveLength(2);
    expect(clean(snapshot.panes.chat)).not.toContain("NESTED REPORT DATA");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 60_000);

test.skipIf(!ide)("hides delayed IDE diagnostics until their tools are opened", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/ide-diagnostic-"));
  const agent = await mkdtemp(path.resolve("tmp/ide-diagnostic-agent-"));
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(path.join(cwd, ".pi/pi-agent-ide/extensions.json"), JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }));
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ side: "left", chatWidth: 60, layout: "columns", chatHeight: 20, showTimestamps: false, compactTools: true }));
    const capture = path.join(cwd, "activity.json");
    const call = (id: string, name: string, args: Record<string, unknown>) => assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const result = await new PiIntegrationTest({
      testName: "diagnostic-activity", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_IDE_PATH: ide, ACTIVITY_SNAPSHOT: capture },
      rawMode: false, tuiSize: { cols: 180, rows: 60 }, timeoutMs: 60_000,
      extensions: ["builtin:codemode", path.resolve("src/index.ts"), path.resolve(ide, "tests/integration/fixtures/linked-diagnostics.ts"), path.resolve("test/fixtures/activity-snapshot.ts")],
      tools: ["codemode", "write", "replace", "release_linked_diagnostics"],
      conversation: [
        call("first-edit", "write", { path: "direct.note", content: "old-direct" }),
        call("nested-edit", "codemode", { code: 'await tools.write({path:"nested.note",content:"before"}); await tools.replace({path:"nested.note",start:"before",text:"after"});' }),
        call("latest-edit", "write", { path: "direct.note", content: "latest-direct" }),
        call("release", "release_linked_diagnostics", {}),
        assistantMessage([text("Reports arrived")]),
      ],
    }).run("Edit files and release reports");
    expect(result.exitCode).toBe(0);
    for (const id of ["first-edit", "nested-edit", "latest-edit", "release"]) expect(getToolExecution(result, id).isError).toBe(false);
    const snapshot = JSON.parse(await readFile(capture, "utf8")) as { panes: Record<string, string[]>; opened: string[]; outputOpened: string[] };
    const activity = clean(snapshot.panes.activity);
    for (const file of ["direct.note", "nested.note"]) {
      expect(activity).toContain(file);
      expect(clean(snapshot.panes.chat)).not.toContain(file);
    }
    expect(activity).not.toContain("owned-checker");
    expect(clean(snapshot.opened)).not.toContain("owned-checker");
    expect(clean(snapshot.outputOpened)).toContain("owned-checker");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 90_000);
