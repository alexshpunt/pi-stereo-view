import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const ide = process.env.PI_STEREO_VIEW_IDE_PATH ?? "";

test.skipIf(!ide)("uses the IDE native renderer for live and saved nested reads", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/nested-ide-"));
  const agent = await mkdtemp(path.resolve("tmp/nested-ide-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ layout: "columns", side: "left", chatWidth: 45, compactTools: true }));
    await writeFile(path.join(cwd, "fixture.txt"), "IDE-RESULT-FIXTURE-83\n");
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "Nested read", timestamp: Date.now() });
    for (const phase of ["live", "resume"] as const) {
      const capture = path.join(cwd, `${phase}.json`);
      const result = await new PiIntegrationTest({
        testName: `nested-ide-${phase}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_IDE_PATH: ide,
          PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!, NESTED_ACTIVITY_CAPTURE: capture },
        rawMode: false, tuiSize: { cols: 180, rows: 60 }, timeoutMs: 60_000,
        extensions: ["builtin:codemode", path.resolve("src/index.ts"), path.resolve("test/fixtures/nested-activity-probe.ts")],
        tools: ["codemode", "read"], conversation: phase === "live" ? [
          assistantMessage([toolCall({ id: "parent-83", name: "codemode", arguments: { code: 'text(await tools.read({path:"fixture.txt"}));' } })], { stopReason: "toolUse" }),
          assistantMessage([text("Done")]),
        ] : [assistantMessage([text("Resumed")])],
      }).run("Read fixture");
      expect(result.exitCode).toBe(0);
      const data: Record<string, { children: { type: string; text: string }[] }> = JSON.parse(await readFile(capture, "utf8"));
      const child = data.settled.children[0];
      expect(child.type).toBe(phase === "live" ? "ToolExecutionComponent" : "SavedNativePanel");
      expect(stripTerminalSequences(child.text)).toContain("IDE-RESULT-FIXTURE-83");
    }
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 120_000);
