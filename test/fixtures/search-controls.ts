import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Exercise panel search through real keyboard input and rendered header mouse targets. */
export default function searchControls(pi: ExtensionAPI): void {
  let tui: Host;
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    return tui.getScreenLines();
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const click = async (label: string, owner: string): Promise<void> => {
    const lines = (await capture()).map(stripTerminalSequences);
    const row = lines.findIndex(line => line.includes(owner) && line.includes(label));
    if (row < 0) throw new Error("Missing search header button: " + owner + " " + label);
    const offset = lines[row].indexOf(label, lines[row].indexOf(owner));
    const x = visibleWidth(lines[row].slice(0, offset)) + 2;
    await input(`\x1b[<0;${x + 1};${row + 1}M`);
    await input(`\x1b[<0;${x + 1};${row + 1}m`);
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
    const frames: Record<string, string[]> = {};
    const file = path.join(ctx.cwd, "search-frames.json");
    ctx.ui.setEditorText("UNSENT SEARCH DRAFT");
    frames.initial = await capture();
    await input("\x06");
    frames.keyboard = await capture();
    await writeFile(file, JSON.stringify({ frames, draft: ctx.ui.getEditorText() }));
    // Keep the pre-implementation failure observable instead of failing on a missing fixture file.
    if (!frames.keyboard.some(line => stripTerminalSequences(line).includes("Search Conversation"))) {
      await input("\x1b");
      return;
    }
    for (const character of "dplyrntm") await input(character);
    frames.query = await capture();
    await input("\x1b");
    frames.canceled = await capture();
    await click("[ ⌕ ]", "Conversation");
    frames.header = await capture();
    for (const character of "dplyrntm") await input(character);
    await input("\r");
    frames.jumped = await capture();
    await input("\x06");
    for (const character of "dplyrntm") await input(character);
    await capture();
    await input("\x1b[B");
    await input("\r");
    frames.older = await capture();
    await writeFile(file, JSON.stringify({ frames, draft: ctx.ui.getEditorText() }));
  });
}
