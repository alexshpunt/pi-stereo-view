import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("keeps all toolbar buttons whole and clickable in a narrow terminal", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/wrapped-controls-"));
  const agent = await mkdtemp(path.resolve("tmp/wrapped-controls-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ side: "left", chatWidth: null, buttonStyle: "text" }));
    const result = await new PiIntegrationTest({
      testName: "wrapped-controls", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false, tuiSize: { cols: 120, rows: 40 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/wrapped-controls-probe.ts")],
      tools: [], conversation: [assistantMessage([text("Answer")])],
    }).run("Question");
    expect(result.exitCode).toBe(0);
    const resultData = JSON.parse(await readFile(path.join(cwd, "wrapped-controls.json"), "utf8"));
    expect(resultData.buttons, JSON.stringify(resultData.narrow.slice(0, 6))).toHaveLength(4);
    expect(resultData.menuOpened).toBe(true);
  } finally { await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true }))); }
});
