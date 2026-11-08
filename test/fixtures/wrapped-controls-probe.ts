import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

export default function wrappedControlsProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const capture = async (): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    return tui.getScreenLines().map(stripTerminalSequences);
  };
  const input = async (data: string): Promise<void> => { tui.handleTerminalInput(data); await setImmediate(); };
  const click = async (x: number, y: number): Promise<void> => {
    await input(`\x1b[<0;${x + 1};${y + 1}M`);
    await input(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host; finish = done; return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const original = process.stdout.columns;
    try {
      process.stdout.columns = 20; process.stdout.emit("resize");
      const narrow = await capture();
      const buttons = narrow.slice(0, 4).flatMap((line, y) => Array.from(line.matchAll(/\[[^\[\]]+\]/g), match => ({
        x: visibleWidth(line.slice(0, match.index)) + 1, y, label: match[0],
      })));
      if (buttons.length >= 4) await click(buttons[3].x, buttons[3].y);
      const menuOpened = tui.hasOverlay();
      if (menuOpened) await input("\x1b");
      await writeFile(path.join(ctx.cwd, "wrapped-controls.json"), JSON.stringify({ buttons, menuOpened, narrow }));
    } finally { process.stdout.columns = original; process.stdout.emit("resize"); }
  });
}
