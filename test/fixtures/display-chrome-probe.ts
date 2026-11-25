import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Container } from "@earendil-works/pi-tui";
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
  const clickControl = async (label: string): Promise<void> => {
    const lines = tui.getScreenLines().map(stripTerminalSequences);
    const row = lines.findIndex(line => line.includes(label));
    if (row < 0) throw new Error("Missing control: " + label);
    const column = visibleWidth(lines[row].slice(0, lines[row].indexOf(label)));
    await mouse(0, column, row);
    await mouse(0, column, row, "m");
  };
  const openSettings = async (): Promise<void> => {
    await command("settings");
    await emittedFrame(tui, () => tui.requestRender(true));
  };
  const changeSetting = async (label: "Show toolbar" | "Show pane headers", times = 1): Promise<void> => {
    await openSettings();
    await clickControl(label);
    for (let click = 1; click < times; click++) await input("\r");
    await input("\x1b");
  };
  const openThreshold = async (): Promise<void> => {
    await openSettings();
    // Select the threshold directly below the header mode without cycling the mode.
    const row = tui.getScreenLines().findIndex(line => stripTerminalSequences(line).includes("Show pane headers"));
    if (row < 0) throw new Error("Missing pane headers setting");
    await mouse(0, 60, row);
    await input("\x1b[B");
    await input("\r");
  };
  const enterThreshold = async (value: string): Promise<void> => {
    await input("\x15");
    for (const char of value) await input(char);
    await input("\r");
  };

  const resize = async (name: string, rows: number): Promise<void> => {
    process.stdout.rows = rows;
    process.stdout.emit("resize");
    await capture(name);
  };
  // Set the viewport by history rows so unrelated changes to the native footer do not move the cutoff.
  const resizeHistory = (name: string, height: number): Promise<void> => {
    const dock = (tui as TestHost & { layoutRoot?: Container }).layoutRoot?.children.at(-1);
    if (!dock) throw new Error("Missing native editor dock");
    return resize(name, dock.render(tui.terminal.columns).length + 1 + height);
  };

  pi.on("session_start", async (_event, ctx) => { tui = await captureTui(ctx); });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const phase = process.env.CHROME_PHASE;
    const originalRows = process.stdout.rows;
    try {
      await capture("initial");
      if (phase === "auto-select") {
        await changeSetting("Show pane headers", 2);
        await capture("autoSelected");
        return;
      }
      if (phase === "auto-columns" || phase === "auto-rows") {
        await resizeHistory("shrunk", 31);
        await capture("shortRepaint");
        await resizeHistory("grown", 32);
        await capture("tallRepaint");
        return;
      }
      if (phase === "auto-threshold-edit") {
        await openThreshold();
        await enterThreshold("0");
        await capture("invalidThreshold");
        await enterThreshold("22");
        await input("\x1b");
        await resizeHistory("customLiveBelow", 21);
        await resizeHistory("customLiveAt", 22);
        return;
      }
      if (phase === "auto-threshold-restart") {
        await resizeHistory("customAt", 22);
        await resizeHistory("customBelow", 21);
        await command("toolbar");
        await capture("customAtWithoutToolbar");

        await command("toolbar");
        await resize("roomForThreshold", originalRows);
        await openThreshold();
        await enterThreshold("1");
        await input("\x1b");
        await resizeHistory("headersDoNotFit", 3);
        await resizeHistory("headersFit", 9);
        return;
      }
      if (phase === "auto-controls") {
        await command("layout columns");
        await capture("autoVisible");
        await clickControl("[ ⌃ ]");
        await capture("chevronHides");

        await changeSetting("Show pane headers"); // Off -> Auto.
        await resizeHistory("autoHidden", 5);
        await clickControl("[ ⌄ ]");
        await capture("chevronRestores");
        await resizeHistory("chevronPinnedOn", 4);

        await resize("roomForSettings", originalRows);
        await changeSetting("Show pane headers", 2); // On -> Off -> Auto.
        await resizeHistory("shortWithToolbar", 5);
        await command("toolbar");
        await capture("shortWithoutToolbar");
        await command("headers");
        await capture("commandRestores");

        await resize("wideWithoutToolbar", originalRows);
        await changeSetting("Show pane headers", 2);
        await capture("visibleWithoutToolbar");
        await command("headers");
        await capture("commandHides");
        await command("toolbar");
        await changeSetting("Show pane headers"); // Off -> Auto.
        await resizeHistory("shortAgain", 5);
        await command("chrome");
        await capture("chromeRestores");

        await resize("wideAgain", originalRows);
        await changeSetting("Show pane headers", 2);
        await capture("autoVisibleAgain");
        await command("chrome");
        await capture("chromeHides");
        return;
      }
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
      if (process.stdout.rows !== originalRows) {
        process.stdout.rows = originalRows;
        process.stdout.emit("resize");
      }
      await writeFile(path.join(ctx.cwd, `display-chrome-${phase}.json`), JSON.stringify(frames));
    }
  });
}
