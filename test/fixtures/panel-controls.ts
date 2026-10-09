import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";

type TestHost = TUI & {
  getScreenLines(): string[];
  handleTerminalInput(data: string): void;
};

/** Exercise real mouse targets in the loaded native fullscreen renderer. */
export default function panelControls(pi: ExtensionAPI): void {
  let tui: TestHost | undefined;
  const capture = async (): Promise<string[]> => {
    tui!.requestRender(true);
    await setImmediate();
    return tui!.getScreenLines();
  };
  const mouse = async (button: number, x: number, y: number, suffix = "M"): Promise<void> => {
    tui!.handleTerminalInput(`\x1b[<${button};${x + 1};${y + 1}${suffix}`);
    await setImmediate();
  };
  const target = async (label: string, owner?: string): Promise<{ x: number; y: number }> => {
    const lines = (await capture()).map(stripTerminalSequences);
    const y = lines.findIndex(line => line.includes(label) && (!owner || line.includes(owner)));
    if (y < 0) throw new Error("Missing visible button: " + (owner ?? "toolbar") + " " + label +
      "\nCurrent header:\n" + lines.slice(0, 4).join("\n"));
    const index = lines[y].indexOf(label, owner ? lines[y].indexOf(owner) + owner.length : 0);
    if (index < 0) throw new Error("Button does not belong to the requested panel: " + owner);
    return { x: visibleWidth(lines[y].slice(0, index)) + Math.floor(label.length / 2), y };
  };
  const click = async (label: string, owner?: string): Promise<void> => {
    const { x, y } = await target(label, owner);
    await mouse(0, x, y);
    await mouse(0, x, y, "m");
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish: () => void = () => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as TestHost;
      finish = done;
      return new Text("", 0, 0);
    }, {
      overlay: true,
      overlayOptions: { visible: () => false, nonCapturing: true },
      onHandle: () => finish(),
    });
  });
  let pending = Promise.resolve();
  let step = 0;
  const streamingFrames: { idle: boolean; lines: string[] }[] = [];
  pi.on("message_update", (event, ctx) => {
    if (process.env.TRANSCRIPT_BUTTON_STREAM !== "1" ||
        event.assistantMessageEvent.type !== "text_delta" || step >= 5) return;
    const actions: [string, string?][] = [
      ["[ ▤ ]"], ["[ ↗ ]", "Activity"], ["[ ↙ ]", "Activity"], ["[ ▣ ]"], ["[ ◫ ]"],
    ];
    const [label, owner] = actions[step++];
    pending = pending.then(async () => {
      await click(label, owner);
      streamingFrames.push({ idle: ctx.isIdle(), lines: await capture() });
    });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!tui) return;
    await pending;
    if (process.env.TRANSCRIPT_BUTTON_STREAM === "1") {
      await writeFile(path.join(ctx.cwd, "button-stream.json"), JSON.stringify(streamingFrames));
    }
    if (process.env.TRANSCRIPT_BUTTON_TOGGLE === "1") {
      const before = await capture();
      await click(stripTerminalSequences(before[0]).includes("[ ▣ ]") ? "[ ▣ ]" : "[ ◫ ]");
      await writeFile(path.join(ctx.cwd, "button-toggle.json"), JSON.stringify({ before, after: await capture() }));
    }
    if (process.env.TRANSCRIPT_BUTTON_DEFAULTS === "1") {
      const columns = await capture();
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 400 });
      process.stdout.emit("resize");
      const wider = await capture();
      await click("[ ▤ ]");
      const rows = await capture();
      await click("[ ▥ ]");
      const divider = stripTerminalSequences(wider[1]).indexOf("║");
      await mouse(0, divider, 2);
      await mouse(32, divider + 4, 2);
      await mouse(0, divider + 4, 2, "m");
      const manual = await capture();
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 500 });
      process.stdout.emit("resize");
      await writeFile(path.join(ctx.cwd, "default-layouts.json"), JSON.stringify({ columns, wider, rows, manual, resized: await capture() }));
    }
    if (process.env.TRANSCRIPT_BUTTON_CONTROLS !== "1") return;
    const frames: Record<string, string[]> = { initial: await capture() };
    const { x, y } = await target("[ ↗ ]", "Activity");
    await mouse(0, x, y);
    await mouse(32, x, y + 2);
    await mouse(0, x, y + 2, "m");
    frames.canceledClick = await capture();
    await click("[ ▤ ]");
    frames.rows = await capture();
    const lines = frames.rows.map(stripTerminalSequences);
    const row = lines.findIndex((line, index) => index > 1 && line.startsWith("═".repeat(120)));
    if (row < 0) throw new Error("Missing draggable horizontal divider");
    await mouse(0, 10, row);
    await mouse(32, 10, row - 3);
    await mouse(0, 10, row - 3, "m");
    frames.rowDrag = await capture();
    await click("[ ↕ ]");
    frames.rowSwap = await capture();
    await click("[ ▥ ]");
    frames.columns = await capture();
    const divider = stripTerminalSequences(frames.columns[1]).indexOf("║");
    if (divider < 0) throw new Error("Missing draggable vertical divider");
    await mouse(0, divider, 2);
    await mouse(32, divider - 8, 2);
    await mouse(0, divider - 8, 2, "m");
    frames.columnDrag = await capture();
    await click("[ ↗ ]", "Activity");
    frames.activity = await capture();
    await click("[ ↙ ]", "Activity");
    frames.activityRestored = await capture();
    await click("[ ↗ ]", "Conversation");
    frames.chat = await capture();
    await click("[ ↙ ]", "Conversation");
    frames.chatRestored = await capture();
    await click("[ ▣ ]");
    frames.combined = await capture();
    await click("[ ◫ ]");
    frames.splitRestored = await capture();
    await click("[ ▤ ]");
    frames.rowsRestored = await capture();
    const rows = process.stdout.rows;
    try {
      process.stdout.rows = 12;
      process.stdout.emit("resize");
      frames.shortRows = await capture();
    } finally {
      process.stdout.rows = rows;
      process.stdout.emit("resize");
    }
    frames.tallRows = await capture();
    await click("[ ↗ ]", "Conversation");
    frames.savedChat = await capture();
    await writeFile(path.join(ctx.cwd, "panel-controls.json"), JSON.stringify(frames));
  });
}
