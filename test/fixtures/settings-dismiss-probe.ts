import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.ts";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void; renderedOverlayLayouts: { col: number; row: number; width: number; height: number }[] };

export default function settingsDismissProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const capture = async (): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    return tui.getScreenLines().map(stripTerminalSequences);
  };
  const click = async (x: number, y: number): Promise<void> => {
    tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}M`);
    tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}m`);
    await setImmediate();
  };
  const open = async (): Promise<void> => {
    const lines = await capture();
    const pos = lines[0].indexOf("[ ≡ ]");
    if (pos < 0) throw new Error("Settings button not found");
    await click(visibleWidth(lines[0].slice(0, pos)) + 2, 0);
    await capture();
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host; finish = done; return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const states: boolean[] = [];
    await open(); states.push(tui.hasOverlay());
    const bounds = tui.renderedOverlayLayouts.at(-1);
    if (!bounds) throw new Error("Settings bounds not found");
    await click(bounds.col + 1, bounds.row + 1); states.push(tui.hasOverlay());
    await click(0, 0); states.push(tui.hasOverlay());
    await open(); states.push(tui.hasOverlay());
    tui.handleTerminalInput("\x1b"); await setImmediate(); states.push(tui.hasOverlay());
    await open(); states.push(tui.hasOverlay());
    await click(0, 0); states.push(tui.hasOverlay());
    await writeFile(path.join(ctx.cwd, "settings-dismiss.json"), JSON.stringify(states));
  });
}
