import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("closes settings on an outside click while inside clicks and reopening still work", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/settings-dismiss-"));
  const agent = await mkdtemp(path.resolve("tmp/settings-dismiss-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    const result = await new PiIntegrationTest({
      testName: "settings-dismiss", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false, tuiSize: { cols: 120, rows: 40 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/settings-dismiss-probe.ts")],
      tools: [], conversation: [assistantMessage([text("Answer")])],
    }).run("Question");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(path.join(cwd, "settings-dismiss.json"), "utf8"))).toEqual([true, true, false, true, false, true, false]);
  } finally { await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true }))); }
});
