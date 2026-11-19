import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.ts";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Capture compact Activity after the run, then open the image group and the call that returned the image. */
export default function imageLabelProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const frames: Record<string, string[]> = {};
  const capture = async (name: string): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    frames[name] = tui.getScreenLines();
    return frames[name].map(stripTerminalSequences);
  };
  const click = async (lines: string[], text: string): Promise<void> => {
    const y = lines.findIndex(line => line.includes(text));
    if (y < 0) return;
    const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(text))) + 1;
    tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}M`);
    tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}m`);
    await setTimeout(50);
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
    await click(await capture("collapsed"), "read ×2");
    await click(await capture("group"), "picture.png");
    await capture("call");
    await writeFile(path.join(ctx.cwd, "image-label-observation.json"), JSON.stringify(frames));
  });
}
