import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const artifactsDir = testArtifactsDir(import.meta.filename, path.resolve("tmp/test-runs"));
const user = "USER COPY **привет**\n\n```ts\nconst userValue = 42;\n```";
const answer = "ASSISTANT COPY **ответ**\n\n```ts\nconst answer = 42;\n```";
const reasoning = "REASON COPY **данные**\n\n```ts\nconst reasoning = 1;\n```";
interface Observation {
  copies: Record<string, string>;
  frames: Record<string, string[]>;
  draftBefore: string;
  draftAfter: string;
  selection: boolean;
  error?: string;
}

test.each([
  { name: "copies full native blocks in Columns with clocks", layout: "columns", showTimestamps: true, clipboardFailure: false },
  { name: "copies full native blocks in Rows without clocks", layout: "rows", showTimestamps: false, clipboardFailure: false },
  { name: "reports a clipboard failure without claiming success", layout: "columns", showTimestamps: true, clipboardFailure: true },
])("$name", async ({ layout, showTimestamps, clipboardFailure }) => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/block-copy-"));
  const agent = await mkdtemp(path.resolve("tmp/block-copy-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, fullscreenCopyOnSelect: false, hideThinkingBlock: false }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", chatWidth: 70, layout, chatHeight: 19, zoom: null, showTimestamps,
    }));
    const result = await new PiIntegrationTest({
      testName: `block-copy-${clipboardFailure ? "failure" : layout}`, artifactsDir, cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: {
        PI_CODING_AGENT_DIR: agent, COPY_CLIPBOARD_FAILURE: clipboardFailure ? "1" : "0",
        // Exercise the real terminal clipboard protocol without touching a desktop clipboard.
        DISPLAY: "", WAYLAND_DISPLAY: "", TERMUX_VERSION: "", WSL_DISTRO_NAME: "", WSL_INTEROP: "",
        WT_SESSION: "block-copy-test", SSH_CONNECTION: "block-copy-test", TZ: "UTC",
      },
      rawMode: false, tuiSize: { cols: 160, rows: 52 }, timeoutMs: 45_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/block-copy-probe.ts")],
      tools: ["copy_probe"], conversation: [
        assistantMessage([toolCall({ id: "first-copy", name: "copy_probe", arguments: { tag: "first" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "second-copy", name: "copy_probe", arguments: { tag: "second" } })], { stopReason: "toolUse" }),
        assistantMessage([text(answer)]),
      ],
    }).run(user);
    expect(result.exitCode).toBe(0);
    const observation: Observation = JSON.parse(await readFile(path.join(cwd, "block-copy-observation.json"), "utf8"));
    await writeFile(path.join(artifactsDir, `block-copy-${clipboardFailure ? "failure" : layout}`, "observation.json"), JSON.stringify(observation, null, 2));
    expect(observation.error, JSON.stringify(observation.frames.failure)).toBeUndefined();
    expect(getToolExecution(result, "first-copy").isError).toBe(false);
    expect(getToolExecution(result, "second-copy").isError).toBe(false);
    if (clipboardFailure) {
      expect(observation.copies).toEqual({});
      const frame = observation.frames.clipboardFailure.join("\n");
      expect(frame).toContain("Could not copy block:");
      expect(frame).not.toContain("Block sent to clipboard.");
      return;
    }
    expect(observation.copies.user).toBe(user);
    expect(observation.copies.assistant).toBe(answer);
    expect(observation.copies.reasoning).toBe(reasoning);
    expect(observation.copies.keyboard).toBe(user);
    expect(observation.copies.zoomed).toBe(user);
    expect(observation.copies.resized).toBe(user);
    expect(observation.copies.highlighted).toBe(user);
    expect(observation.frames.highlighted.join("\n")).toContain("Search:");
    expect(observation.frames.keyboardPicker.join("\n")).toContain("Copy a block from the active panel");
    for (const tag of ["first", "second"]) {
      const copied = observation.copies[tag + "Tool"];
      expect(copied).toContain("copy_probe");
      expect(copied).toContain(JSON.stringify({ tag }, null, 2));
      expect(copied).toContain(getToolResultText(result, tag + "-copy"));
      expect(copied).toContain("LATE " + tag.toUpperCase() + " COPY");
      expect(copied).not.toContain(tag === "first" ? "LATE SECOND COPY" : "LATE FIRST COPY");
      expect(copied).not.toContain("COLLAPSED COPY RESULT");
    }
    expect(observation.copies.firstTool.indexOf("LATE FIRST COPY")).toBeLessThan(observation.copies.firstTool.indexOf("LATER FIRST COPY"));
    expect(observation.copies.linked).toBe("LATE FIRST COPY");
    expect(observation.copies.streaming).toContain("PARTIAL COPY RESULT");
    expect(observation.copies.streaming).not.toContain("first full result line");
    expect(observation.copies.firstTool).not.toContain("PARTIAL COPY RESULT");
    expect(observation.copies.firstTool).toContain("first full result line 69");
    for (const copied of Object.values(observation.copies)) {
      expect(copied).not.toContain("\x1b");
      expect(copied).not.toContain("⧉");
      expect(copied).not.toContain("keep this unsent draft");
    }
    const toolFrame = observation.frames.firstTool.join("\n");
    expect(toolFrame).toContain("COLLAPSED COPY RESULT");
    expect(toolFrame).not.toContain("first full result line 69");
    // Activity may have a copy footer on the same screen row as Conversation text.
    const userFrame = observation.frames.user.map(line => layout === "columns" ? sliceByColumn(line, 0, 70) : line);
    const userIndex = userFrame.findIndex(line => line.includes("USER COPY"));
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(userFrame[userIndex]).not.toContain("⧉");
    const beforeUser = userFrame.slice(Math.max(0, userIndex - 3), userIndex).join("\n");
    if (showTimestamps) expect(beforeUser).toMatch(/\d{2}:\d{2}:\d{2}/);
    else expect(beforeUser).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(observation.frames.copySettings.join("\n")).toContain("Show copy buttons");
    expect(observation.frames.copyIconsHidden.join("\n")).not.toContain("⧉");
    expect(observation.frames.copyIconsRestored.join("\n")).toContain("⧉");
    expect(observation.draftBefore).toBe("keep this unsent draft");
    expect(observation.draftAfter).toBe(observation.draftBefore);
    expect(observation.selection).toBe(true);
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 60_000);
