import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const CHAT_WIDTH = 36;
const TREE = "Session Tree";
const SUMMARY = "Summarize branch?";

test.each(["combined", "maximize", "inline"] as const)("opens Pi's own windows by the %s setting and leaves extension dialogs in Activity", async piWindows => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/pi-windows-"));
  const agent = await mkdtemp(path.resolve("tmp/pi-windows-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ side: "left", chatWidth: CHAT_WIDTH, piWindows }));
    await new PiIntegrationTest({
      testName: "pi-windows-" + piWindows, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false,
      tuiSize: { cols: 120, rows: 40 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/pi-windows-probe.ts")],
      conversation: [assistantMessage([text("FIRST-ANSWER")]), assistantMessage([text("DONE-ANSWER")])],
    }).run("PI-WINDOWS-PROMPT");
    const result = JSON.parse(await readFile(path.join(cwd, "pi-windows-frames.json"), "utf8"));
    expect(result.error).toBeUndefined();
    const screen = (key: string): string => result.frames[key].join("\n");
    const column = (key: string, marker: string): number => {
      const line = result.frames[key].find((line: string) => line.includes(marker));
      expect(line, key).toBeDefined();
      return line.indexOf(marker);
    };
    const split = (key: string): void => {
      expect(screen(key), key).toContain("║");
      expect(screen(key), key).toContain("Conversation");
      expect(screen(key), key).toContain("Activity");
    };

    split("split");
    // Pi's follow-up question after the tree keeps the window's placement until the chain of windows ends.
    for (const [key, marker] of [["treeEscape", TREE], ["treeSummary", SUMMARY], ["treeAgain", TREE], ["treeCommand", TREE]]) {
      if (piWindows === "combined") {
        // Pi's own single history and dock: no panels, the window at full width.
        expect(screen(key), key).not.toMatch(/║|Conversation|Activity/);
        expect(column(key, marker), key).toBeLessThan(CHAT_WIDTH);
      } else if (piWindows === "maximize") {
        expect(screen(key), key).not.toMatch(/║|Conversation/);
        expect(screen(key), key).toContain("Activity");
        expect(column(key, marker), key).toBeLessThan(CHAT_WIDTH);
      } else {
        split(key);
        expect(column(key, marker), key).toBeGreaterThan(CHAT_WIDTH);
      }
    }
    // Closing the window by Escape or by a selection returns the same split, scroll positions included.
    expect(result.frames.afterEscape).toEqual(result.frames.split);
    expect(result.frames.afterSummary).toEqual(result.frames.split);
    // Choosing the current leaf adds Pi's own status line to history.
    const status = "Already at this point";
    expect(result.frames.afterSelect.map((line: string) => line.replace(status, " ".repeat(status.length))))
      .toEqual(result.frames.split);
    expect(result.savedUnchanged).toBe(true);

    // Extension dialogs, such as the agent's questions, keep the split whatever the setting.
    expect(result.selected).toBe("CHOICE-A");
    expect(result.customValue).toBe("CUSTOM-VALUE");
    for (const [key, marker] of [["extensionSelect", "EXTENSION-SELECT-PROBE"], ["extensionCustom", "EXTENSION-CUSTOM-PROBE"]]) {
      split(key);
      expect(column(key, marker), key).toBeGreaterThan(CHAT_WIDTH);
    }

    // Rows and a zoomed panel already give the window the full width; they keep today's placement.
    expect(screen("rowsTree")).toContain(TREE);
    expect(screen("rowsTree")).toMatch(/Conversation[\s\S]*═[\s\S]*Activity/);
    expect(screen("chatZoomTree")).toContain(TREE);
    expect(screen("chatZoomTree")).toContain("Conversation");
    expect(screen("chatZoomTree")).not.toMatch(/║|Activity/);
    split("restored");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
});
