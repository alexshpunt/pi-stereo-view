import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

export default function widgetsProbe(pi: ExtensionAPI): void {
  let host: Host;
  const events: Array<{ type: string; x: number; y: number; width: number }> = [];
  let disposed = 0;
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      host = tui as Host;
      queueMicrotask(done);
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true } });
    ctx.ui.setWidget("first", () => ({
      render: () => ["WIDGET ALPHA"],
      invalidate: () => {},
      dispose: () => { disposed++; },
      handleMouse: (event: TuiMouseEvent) => {
        events.push({ type: event.type, x: event.x, y: event.y, width: event.width });
        return { handled: true };
      },
    }));
    ctx.ui.setWidget("second", ["WIDGET BETA"], { placement: "belowEditor" });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const capture = async () => {
      host.requestRender(true);
      await setImmediate();
      return host.getScreenLines();
    };
    const click = async (label: string, owner?: string) => {
      const lines = (await capture()).map(stripTerminalSequences);
      const y = lines.findIndex(line => line.includes(label) && (!owner || line.includes(owner)));
      if (y < 0) throw new Error(`Missing ${owner ?? ""} ${label}:\n${lines.join("\n")}`);
      const x = lines[y].indexOf(label, owner ? lines[y].indexOf(owner) + owner.length : 0);
      host.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}M`);
      host.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}m`);
      await setImmediate();
    };
    const split = await capture();
    const plainSplit = split.map(stripTerminalSequences);
    const header = plainSplit.findIndex(line => line.includes("Activity"));
    const activityColumn = plainSplit[header].indexOf("Activity");
    for (let count = 0; count < 5; count++) {
      host.handleTerminalInput(`\x1b[<64;${activityColumn + 1};${header + 4}M`);
    }
    const scrolled = await capture();
    await click("WIDGET ALPHA");
    const markerLine = split.map(stripTerminalSequences).findIndex(line => line.includes("WIDGET ALPHA"));
    const markerColumn = stripTerminalSequences(split[markerLine]).indexOf("WIDGET ALPHA");
    host.handleTerminalInput(`\x1b[<65;${markerColumn + 1};${markerLine + 1}M`);
    await setImmediate();
    await click("[↗]", "Conversation");
    const chatZoom = await capture();
    await click("[↙]", "Conversation");
    await click("[↗]", "Activity");
    const activityZoom = await capture();
    await click("[↙]", "Activity");
    await click("[▤]");
    const rows = await capture();
    await click("[▥]");
    const width = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 55 });
    process.stdout.emit("resize");
    const narrow = await capture();
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
    process.stdout.emit("resize");
    const restored = await capture();
    await click("[▣]");
    const combined = await capture();
    await click("[◫]");
    ctx.ui.setWidget("first", ["WIDGET UPDATED"]);
    ctx.ui.setWidget("second", undefined);
    const updated = await capture();
    ctx.ui.setWidget("first", () => ({
      render: () => Array.from({ length: 15 }, (_, index) => `MEDIUM WIDGET ${index + 1}`),
      invalidate: () => {},
    }));
    const medium = await capture();
    ctx.ui.setWidget("first", () => ({
      render: () => Array.from({ length: 30 }, (_, index) => `LONG WIDGET ${index + 1}`),
      invalidate: () => {},
    }));
    const oversized = await capture();
    ctx.ui.setWidget("first", ["WIDGET RETURNED"]);
    const afterOversized = await capture();
    await writeFile(path.join(ctx.cwd, "widget-frames.json"), JSON.stringify({ split, scrolled, chatZoom, activityZoom, rows, narrow, restored, combined, updated, medium, oversized, afterOversized, events, disposed }));
  });
}
