import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Capture compact panes after native zoom and resize events. */
export default function compactProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    return tui.getScreenLines();
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish: () => void = () => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const frames: Record<string, string[]> = { rows: await capture() };
    const lines = frames.rows.map(stripTerminalSequences);
    const row = lines.findIndex(line => line.includes("Conversation"));
    const column = lines[row].indexOf("[ ↗ ]") + 2;
    for (const suffix of ["M", "m"]) {
      tui.handleTerminalInput(`\x1b[<0;${column + 1};${row + 1}${suffix}`);
      await setImmediate();
    }
    frames.zoom = await capture();
    const { columns, rows } = process.stdout;
    try {
      process.stdout.columns = 40;
      process.stdout.rows = 12;
      process.stdout.emit("resize");
      frames.small = await capture();
    } finally {
      process.stdout.columns = columns;
      process.stdout.rows = rows;
      process.stdout.emit("resize");
    }
    frames.restored = await capture();
    await writeFile(path.join(ctx.cwd, "compact-frames.json"), JSON.stringify(frames));
  });
}
