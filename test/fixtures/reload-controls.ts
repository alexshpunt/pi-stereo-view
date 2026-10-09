import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };
type State = { reloads: number; frames: string[][] };

/** Cross two real extension reloads before starting the scripted model turn. */
export default function reloadControls(pi: ExtensionAPI): void {
  let tui: Host;
  let file: string;
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
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
    state.frames.push(await capture());
    await writeFile(file, JSON.stringify(state));
    // Use this new runtime only, after session_start returns.
    void setImmediate().then(() => {
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
