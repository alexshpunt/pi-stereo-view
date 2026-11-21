import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test.each([
  { layout: "columns", rows: 35 }, { layout: "rows", rows: 35 }, { layout: "rows", rows: 12 },
])("opens the external editor and resumes $layout at $rows rows", async ({ layout, rows }) => {
  const tuiSize = { cols: 120, rows };
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/external-editor-"));
  const agent = path.join(cwd, "agent");
  try {
    await mkdir(agent);
    const editor = path.join(cwd, "editor.mjs");
    await writeFile(editor, `import fs from "node:fs";
const file = process.argv[2];
fs.writeFileSync("editor-input.txt", fs.readFileSync(file));
fs.writeFileSync(file, "EDITED PROMPT\\n");
`);
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({
      quietStartup: true, externalEditor: "node editor.mjs",
    }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ layout, side: "left", chatWidth: 45 }));
    const result = await new PiIntegrationTest({
      testName: `external-editor-${layout}-${rows}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_IDE_PATH: "", PI_TRANSCRIPT_TEST_SESSION: "",
        PI_TRANSCRIPT_TEST_MODE: "fullscreen", PI_TRANSCRIPT_TEST_DEFAULTS: "1" },
      rawMode: false, tuiSize, timeoutMs: 45_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/external-editor-probe.ts")],
      tools: [], conversation: [assistantMessage([text(
        Array.from({ length: 80 }, (_, i) => `History line ${i}`).join("\n") + "\nHistory before external editor",
        { chunks: { kind: "fixed", size: 10000 } },
      )])],
    }).run("Open the external editor");
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(cwd, "editor-input.txt"), "utf8")).toBe("UNSENT EDITOR DRAFT\nsecond line");
    const stopped = await readFile(path.join(cwd, "external-editor-stop.txt"), "utf8");
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.split("\n").length).toBeLessThanOrEqual(tuiSize.rows);
    const frame = await readFile(path.join(cwd, "external-editor-frame.txt"), "utf8");
    if (rows === 12) {
      expect(frame).not.toContain("Conversation");
      expect(frame).not.toContain("Activity");
    } else {
      const lines = frame.split("\n");
      const chat = lines.findIndex(line => line.includes("Conversation"));
      const activity = lines.findIndex(line => line.includes("Activity"));
      expect(chat).toBeGreaterThanOrEqual(0);
      if (layout === "columns") expect(activity).toBe(chat);
      else expect(activity).toBeGreaterThan(chat);
      expect(frame).toContain(layout === "columns" ? "║" : "═");
    }
    expect(frame).toContain("History before external editor");
    expect(frame).toContain("EDITED PROMPT");
    expect(result.terminalOutput).not.toContain("RangeError");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
