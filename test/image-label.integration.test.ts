import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecutionResult, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// Pi's own read tool returns image blocks; a collapsed compact row is then the only sign of the image.
test("compact Activity groups label images returned by Pi's read tool", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/image-label-"));
  const agent = await mkdtemp(path.resolve("tmp/image-label-agent-"));
  try {
    await copyFile(path.resolve("assets/logo-icon.png"), path.join(cwd, "picture.png"));
    await writeFile(path.join(cwd, "notes.txt"), "TEXT-FIXTURE\n");
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", chatWidth: 40, layout: "columns", chatHeight: null, zoom: null, showTimestamps: false,
      compactTools: true, groupTools: true, streamTools: false,
    }));
    const result = await new PiIntegrationTest({
      testName: "image-label", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_IMAGE_PROTOCOL: "kitty" },
      rawMode: false, tuiSize: { cols: 140, rows: 40 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/image-label-probe.ts")], tools: ["read"],
      conversation: [
        assistantMessage([toolCall({ id: "picture", name: "read", arguments: { path: "picture.png" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "notes", name: "read", arguments: { path: "notes.txt" } })], { stopReason: "toolUse" }),
        assistantMessage([text("ANSWER-FIXTURE")]),
      ],
    }).run("Read the picture");
    expect(result.exitCode).toBe(0);
    const picture = getToolExecutionResult(result, "picture") as { content: { type: string }[] };
    expect(picture.content.filter(block => block.type === "image")).toHaveLength(1);
    const frames = JSON.parse(await readFile(path.join(cwd, "image-label-observation.json"), "utf8")) as Record<string, string[]>;
    const rows = (name: string): string[] => frames[name].map(stripTerminalSequences);
    const placed = (name: string): boolean => frames[name].some(line => line.includes("\x1b_G"));
    // Adjacent reads share a group; its header counts the image of its one picture.
    expect(rows("collapsed").find(line => line.includes("read ×2"))).toMatch(/read ×2 \(1 image\)/);
    expect(rows("collapsed").join("\n")).not.toContain("picture.png");
    expect(placed("collapsed")).toBe(false);
    expect(rows("group").find(line => line.includes("picture.png"))).toMatch(/read \(1 image\) .*picture\.png/);
    expect(rows("group").find(line => line.includes("notes.txt"))).not.toContain("image");
    // Opening the call shows Pi's native image placement.
    expect(placed("call")).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
