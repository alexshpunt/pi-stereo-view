import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Drive display settings and capture real headers in both theme appearances. */
export default function displayControls(pi: ExtensionAPI): void {
  let tui: Host;
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    return tui.getScreenLines();
  };
  const click = async (label: string): Promise<void> => {
    const lines = (await capture()).map(stripTerminalSequences);
    const y = lines.findIndex(line => line.includes(label));
    if (y < 0) throw new Error("Missing display control: " + label);
    const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(label))) + 2;
    for (const suffix of ["M", "m"]) {
      tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}${suffix}`);
      await setImmediate();
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const frames: Record<string, string[]> = { initial: await capture() };
    try {
      if (process.env.DISPLAY_SETTINGS_CONTROLS === "1") {
        await click("[ ≡ ]");
        frames.settings = await capture();
        await click("Show timestamps");
        frames.offMenu = await capture();
        tui.handleTerminalInput("\x1b");
        frames.off = await capture();
        await click("[ ▣ ]");
        frames.offCombined = await capture();
        await click("[ ◫ ]");
        for (const character of "/transcript settings") tui.handleTerminalInput(character);
        tui.handleTerminalInput("\r");
        frames.commandMenu = await capture();
        await click("Show timestamps");
        tui.handleTerminalInput("\x1b");
        frames.on = await capture();
        await click("[ ▥ ]");
        frames.columns = await capture();
        await click("[ ↔ ]");
        frames.swapped = await capture();
        await click("[ ▤ ]");
        frames.swappedRows = await capture();
        await click("[ ↗ ]");
        frames.expanded = await capture();
        const theme = ctx.ui.setTheme("light");
        if (!theme.success) throw new Error("Could not load native light theme");
        frames.light = await capture();
        await click("[ ↙ ]");
        await click("[ ≡ ]");
        await click("Show timestamps");
        tui.handleTerminalInput("\x1b");
        frames.savedOff = await capture();
      }
    } finally {
      await writeFile(process.env.DISPLAY_FRAMES_FILE ?? path.join(ctx.cwd, "display-frames.json"), JSON.stringify(frames));
    }
  });
}
