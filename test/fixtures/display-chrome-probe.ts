import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { captureTui, type TestHost } from "./tui-host.ts";
import { emittedFrame } from "./emitted-frame.ts";

export default function displayChromeProbe(pi: ExtensionAPI): void {
  let tui: TestHost;
  const frames: Record<string, string[]> = {};
  const capture = async (name: string): Promise<void> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    frames[name] = tui.getScreenLines().slice();
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const command = async (name: string): Promise<void> => {
    for (const char of "/stereo-view " + name) tui.handleTerminalInput(char);
    await input("\r");
  };
  const mouse = (button: number, x: number, y: number, suffix = "M"): Promise<void> =>
    input(`\x1b[<${button};${x + 1};${y + 1}${suffix}`);
  const changeSetting = async (label: "Show toolbar" | "Show pane headers"): Promise<void> => {
    await command("settings");
    await emittedFrame(tui, () => tui.requestRender(true));
    const lines = tui.getScreenLines().map(stripTerminalSequences);
    const row = lines.findIndex(line => line.includes(label));
    if (row < 0) throw new Error("Missing visibility setting: " + label);
    const column = visibleWidth(lines[row].slice(0, lines[row].indexOf(label)));
    await mouse(0, column, row);
    await mouse(0, column, row, "m");
    await input("\x1b");
  };

  pi.on("session_start", async (_event, ctx) => { tui = await captureTui(ctx); });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const phase = process.env.CHROME_PHASE;
    try {
      await capture("initial");
      if (phase === "restart") {
        await command("chrome");
        await capture("restored");
        return;
      }
      await command("toolbar");
      await capture("toolbarHidden");
      await command("headers");
      await capture("columnsHidden");

      await input("\x06");
      await input("REPORT ROW 03");
      await emittedFrame(tui, () => tui.requestRender(true), () => tui.getScreenLines().map(stripTerminalSequences)
        .some(line => line.includes("REPORT ROW 03") && !line.includes("[ ↓ ]")));
      await capture("search");
      await input("\x1b");

      await changeSetting("Show toolbar");
      await capture("settingsToolbar");
      await command("chrome");
      await capture("restored");
      await changeSetting("Show pane headers");
      await capture("settingsHeaders");
      await command("chrome");
      await command("layout rows");
      await capture("rows");
      await command("chrome");
      await capture("rowsHidden");
      const divider = frames.rowsHidden.findIndex(line => stripTerminalSequences(line).startsWith("═".repeat(120)));
      if (divider < 0) throw new Error("Missing horizontal divider with chrome hidden");
      await mouse(0, 10, divider);
      await mouse(32, 10, 2);
      await mouse(0, 10, 2, "m");
      await capture("rowsDragged");
      await command("toggle");
      await capture("combined");
      await command("toggle");
      await capture("split");
    } finally {
      await writeFile(path.join(ctx.cwd, `display-chrome-${phase}.json`), JSON.stringify(frames));
    }
  });
}
