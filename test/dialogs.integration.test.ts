import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

test.each([false, true])("temporarily maximizes Activity for native inline dialogs (reload: %s)", async reload => {
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
    await writeFile(path.resolve("tmp/test-runs/dialogs/dialog-frames.json"), JSON.stringify(frames));
    const lines = (key: string): string[] => frames[key].map(stripTerminalSequences);
    for (const [key, marker] of Object.entries({
      select: "SELECT-PROBE", confirm: "CONFIRM-PROBE", input: "INPUT-PROBE",
      editor: "EDITOR-PROBE", custom: "CUSTOM-PROBE",
    })) {
      const line = lines(key).find(line => line.includes(marker));
      expect(line, key).toBeDefined();
      expect(line!.indexOf(marker), key).toBeLessThan(36);
      expect(lines(key).join("\n"), key).not.toMatch(/║|Conversation/);
      expect(lines(key).join("\n"), key).toContain("Activity");
      expect(lines(key).filter(line => line.includes(marker)), key).toHaveLength(1);
    }
    expect(frames.results).toEqual({ select: "CHOICE-B", confirm: true, input: "INPUT-VALUE", editor: "PREFILL-VALUE", custom: "CUSTOM-VALUE", overlay: "OVERLAY-VALUE", detached: "DETACHED-VALUE",
      ...(frames.stackSupported ? { nested: true } : {}) });
    expect(frames.results).not.toHaveProperty("cancel");
    if (frames.stackSupported) {
      expect(lines("nested").join("\n")).toContain("NESTED-PROBE");
      expect(lines("nested").join("\n")).not.toMatch(/║|Conversation/);
      expect(lines("nested").join("\n")).not.toContain("CUSTOM-PROBE");
      for (const key of ["afterNested", "replacedDuringDialog"]) {
        expect(lines(key).join("\n")).toContain("CUSTOM-PROBE");
        expect(lines(key).join("\n")).not.toMatch(/║|Conversation/);
      }
    }
    expect(lines("beforeDetach").join("\n")).toContain("Activity");
    expect(lines("beforeDetach").join("\n")).not.toMatch(/║|Conversation/);
    expect(lines("tooNarrow").join("\n")).not.toContain("Activity");
    expect(lines("narrow").join("\n")).toContain("Activity");
    expect(lines("detached").find(line => line.includes("DETACHED-PROBE"))).not.toContain("║");
    expect(lines("detached").join("\n")).toContain("FOREIGN-PROBE");
    expect(frames.disposed).toBe(1);
    expect(frames.inputs).toContain("\x06");
    expect(lines("rows").join("\n")).toContain("CUSTOM-PROBE");
    expect(lines("disabledRestore").join("\n")).toContain("CUSTOM-PROBE");
    expect(lines("disabledRestore").join("\n")).not.toMatch(/║|Conversation/);
    expect(frames.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "click", x: 0, y: 0 })]));
    const customRow = lines("custom").findIndex(line => line.includes("CUSTOM-PROBE"));
    expect(lines("scrolled").findIndex(line => line.includes("CUSTOM-PROBE"))).toBe(customRow);
    expect(lines("scrolled").slice(0, customRow)).not.toEqual(lines("custom").slice(0, customRow));
    for (const key of ["narrow", "tooNarrow", "combined", "oversized"]) {
      const line = lines(key).find(line => line.includes("CUSTOM-PROBE"));
      expect(line, key).toBeDefined();
      expect(line, key).not.toContain("║");
    }
    for (const key of ["restored", "afterCombined", "afterOversized", "dialogShortcut"]) {
      expect(lines(key).join("\n"), key).toContain("CUSTOM-PROBE");
      expect(lines(key).join("\n"), key).not.toMatch(/║|Conversation/);
    }
    expect(lines("overlay").find(line => line.includes("OVERLAY-PROBE"))!.indexOf("OVERLAY-PROBE")).toBeLessThan(36);
    for (const key of ["widget", "overlay", "afterTree", "afterCustom"]) {
      expect(lines(key).join("\n"), key).toContain("Conversation");
      expect(lines(key).join("\n"), key).toContain("║");
    }
    expect(lines("tree").join("\n")).toContain("Activity");
    expect(lines("tree").join("\n")).not.toMatch(/║|Conversation/);
    expect(frames.arrangements).toHaveLength(6);
    for (const arrangement of frames.arrangements) {
      const headers = (frame: string[]) => frame.filter(line => /Conversation|Activity|║|═/.test(line));
      expect(arrangement.during.join("\n")).toContain("RESTORE-PROBE");
      expect(arrangement.during.join("\n")).not.toMatch(/║|Conversation/);
      expect(arrangement.duringTimeout.join("\n")).toContain("RESTORE-TIMEOUT");
      expect(arrangement.duringTimeout.join("\n")).not.toMatch(/║|Conversation/);
      for (const key of ["after", "afterCancel", "afterTimeout", "afterAbort"]) {
        expect(headers(arrangement[key]), `${arrangement.layout}/${arrangement.zoom}/${key}`).toEqual(headers(arrangement.before));
      }
      expect(arrangement.selected).toBe("RESTORE-CHOICE");
      expect(arrangement.savedPreferences, `${arrangement.layout}/${arrangement.zoom}`).toEqual(arrangement.preferences);
      expect(arrangement.draft).toBe("MESSAGE-DRAFT");
    }
    expect(frames.editorWidths.length).toBeGreaterThan(0);
    expect(frames.editorWidths.every((width: number) => width === 120)).toBe(true);
    expect(frames.editorText).toBe("MESSAGE-DRAFT");
    expect(lines("afterCustom").join("\n")).not.toContain("CUSTOM-PROBE");
    expect(lines("afterCustom").find(line => line.includes("MESSAGE-DRAFT"))).not.toContain("║");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
});
