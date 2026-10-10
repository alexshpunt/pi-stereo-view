import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Keep the inline input and a native result visible through minimum sizing and resize. */
export default function searchResizeControls(pi: ExtensionAPI): void {
  let tui: Host;
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    await setImmediate();
    return tui.getScreenLines();
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
    ctx.ui.setEditorText("RESIZE UNSENT DRAFT");
    await capture();
    tui.handleTerminalInput("\x06");
    await capture();
    tui.handleTerminalInput("resize target");
    await capture();
    const frames: Record<string, string[]> = { opened: await capture() };
    const { columns, rows } = process.stdout;
    try {
      process.stdout.columns = 70;
      process.stdout.rows = 22;
      process.stdout.emit("resize");
      await capture();
      frames.narrow = await capture();
      const screen = frames.narrow.map(stripTerminalSequences);
      const row = screen.findIndex(line => line.includes("Conversation") && line.includes("[ ↗ ]"));
      const column = screen[row].indexOf("[ ↗ ]") + 2;
      for (const suffix of ["M", "m"]) {
        tui.handleTerminalInput(`\x1b[<0;${column + 1};${row + 1}${suffix}`);
        await setImmediate();
      }
      await capture();
      frames.zoom = await capture();
      process.stdout.rows = 12;
      process.stdout.emit("resize");
      await capture();
      frames.shortZoom = await capture();
      process.stdout.columns = 40;
      process.stdout.rows = 8;
      process.stdout.emit("resize");
      frames.fallback = await capture();
    } finally {
      process.stdout.columns = columns;
      process.stdout.rows = rows;
      process.stdout.emit("resize");
    }
    frames.restored = await capture();
    tui.handleTerminalInput("x");
    await capture();
    await writeFile(path.join(ctx.cwd, "search-resize-frames.json"), JSON.stringify({ frames, draft: ctx.ui.getEditorText() }));
  });
}
