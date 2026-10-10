import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void; getFocusedComponent(): Component | null };
type State = { reloads: number; frames: string[][] };

/** Cross two real extension reloads before starting the scripted model turn. */
export default function reloadControls(pi: ExtensionAPI): void {
  let tui: Host;
  let file: string;
  const capture = async (): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    return tui.getScreenLines();
  };
  pi.on("session_start", async (event, ctx) => {
    file = process.env.RELOAD_FRAMES_FILE ?? path.join(ctx.cwd, "reload-frames.json");
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
    if (event.reason !== "reload") return;
    const state: State = JSON.parse(await readFile(file, "utf8"));
    const reloadFocus = tui.getFocusedComponent();
    // session_start runs while the native reload box still owns focus. Wait for
    // its dismissal before observing the restored layout or sending more input.
    void emittedFrame(tui, () => tui.requestRender(true), () => tui.getFocusedComponent() !== reloadFocus).then(async () => {
      state.frames.push(tui.getScreenLines());
      await writeFile(file, JSON.stringify(state));
      if (state.reloads < 2) {
        for (const character of "/transcript-reload-check") tui.handleTerminalInput(character);
        tui.handleTerminalInput("\r");
      } else pi.sendUserMessage("FRESH USER");
    });
  });
  pi.registerCommand("transcript-reload-check", {
    description: "Exercise the native reload lifecycle",
    handler: async (_args, ctx) => {
      let state: State;
      try { state = JSON.parse(await readFile(file, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = { reloads: 0, frames: [await capture()] };
      }
      state.reloads++;
      await writeFile(file, JSON.stringify(state));
      await ctx.reload();
      // The old runtime is now invalid: do not touch its context or TUI again.
    },
  });
  pi.on("agent_before_settle", async () => {
    const state: State = JSON.parse(await readFile(file, "utf8"));
    state.frames.push(await capture());
    await writeFile(file, JSON.stringify(state));
  });
}
