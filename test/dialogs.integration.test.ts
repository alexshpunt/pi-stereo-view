import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

test.each([false, true])("keeps original inline dialogs in Activity without moving the message editor (reload: %s)", async reload => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/dialogs-"));
  const agent = await mkdtemp(path.resolve("tmp/dialogs-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ mode: "split", side: "left", chatWidth: 36 }));
    const run = await new PiIntegrationTest({
      testName: "dialogs", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false,
      tuiSize: { cols: 120, rows: 44 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/dialogs-probe.ts"),
        ...(reload ? [path.resolve("test/fixtures/reload-controls.ts")] : [])],
      tools: ["bash"], conversation: [
        assistantMessage([toolCall({ id: "history", name: "bash", arguments: { command: "for i in $(seq 1 60); do echo SURFACE-HISTORY-$i; done" } })], { stopReason: "toolUse" }),
        assistantMessage([text("SURFACE-ANSWER")]),
      ],
    }).run(reload ? "/transcript-reload-check" : "SURFACE-PROMPT");
    expect(JSON.stringify(run.messages)).not.toMatch(/SELECT-PROBE|CUSTOM-PROBE|OVERLAY-PROBE/);
    const frames = JSON.parse(await readFile(path.join(cwd, "dialog-frames.json"), "utf8"));
    const lines = (key: string): string[] => frames[key].map(stripTerminalSequences);
    for (const [key, marker] of Object.entries({
      select: "SELECT-PROBE", confirm: "CONFIRM-PROBE", input: "INPUT-PROBE",
      editor: "EDITOR-PROBE", custom: "CUSTOM-PROBE",
    })) {
      const line = lines(key).find(line => line.includes(marker));
      expect(line, key).toBeDefined();
      expect(line!.indexOf(marker), key).toBeGreaterThan(36);
      expect(line, key).toContain("║");
      expect(lines(key).filter(line => line.includes(marker)), key).toHaveLength(1);
    }
    expect(frames.results).toEqual({ select: "CHOICE-B", confirm: true, input: "INPUT-VALUE", editor: "PREFILL-VALUE", custom: "CUSTOM-VALUE", overlay: "OVERLAY-VALUE", detached: "DETACHED-VALUE",
      ...(frames.stackSupported ? { nested: true } : {}) });
    expect(frames.results).not.toHaveProperty("cancel");
    if (frames.stackSupported) {
      expect(lines("nested").find(line => line.includes("NESTED-PROBE"))).toContain("║");
      expect(lines("nested").join("\n")).not.toContain("CUSTOM-PROBE");
      expect(lines("afterNested").find(line => line.includes("CUSTOM-PROBE"))).toContain("║");
      expect(lines("replacedDuringDialog").find(line => line.includes("CUSTOM-PROBE"))).toContain("║");
    }
    expect(lines("detached").find(line => line.includes("DETACHED-PROBE"))).not.toContain("║");
    expect(lines("detached").join("\n")).toContain("FOREIGN-PROBE");
    expect(frames.disposed).toBe(1);
    expect(frames.inputs).toContain("\x06");
    expect(lines("rows").join("\n")).toContain("CUSTOM-PROBE");
    expect(lines("activityZoom").join("\n")).toContain("CUSTOM-PROBE");
    expect(frames.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "click", x: 0, y: 0 })]));
    const customRow = lines("custom").findIndex(line => line.includes("CUSTOM-PROBE"));
    expect(lines("scrolled").findIndex(line => line.includes("CUSTOM-PROBE"))).toBe(customRow);
    expect(lines("scrolled").slice(0, customRow)).not.toEqual(lines("custom").slice(0, customRow));
    for (const key of ["chatZoom", "narrow", "combined", "oversized"]) {
      const line = lines(key).find(line => line.includes("CUSTOM-PROBE"));
      expect(line, key).toBeDefined();
      expect(line, key).not.toContain("║");
    }
    for (const key of ["restored", "afterCombined", "afterOversized", "dialogShortcut"]) {
      expect(lines(key).find(line => line.includes("CUSTOM-PROBE")), key).toContain("║");
    }
    expect(lines("overlay").find(line => line.includes("OVERLAY-PROBE"))!.indexOf("OVERLAY-PROBE")).toBeLessThan(36);
    expect(frames.editorWidths.length).toBeGreaterThan(0);
    expect(frames.editorWidths.every((width: number) => width === 120)).toBe(true);
    expect(frames.editorText).toBe("MESSAGE-DRAFT");
    expect(lines("afterCustom").join("\n")).not.toContain("CUSTOM-PROBE");
    expect(lines("afterCustom").find(line => line.includes("MESSAGE-DRAFT"))).not.toContain("║");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
});
