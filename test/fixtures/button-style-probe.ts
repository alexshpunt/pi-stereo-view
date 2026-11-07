import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

export default function buttonStyleProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const copies: string[] = [];
  const original = process.stdout.write;
  let pending = "";
  const observe: typeof process.stdout.write = function (chunk, ...args: unknown[]): boolean {
    pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const match of pending.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)) copies.push(Buffer.from(match[1], "base64").toString("utf8"));
    const start = pending.lastIndexOf("\x1b]52;");
    pending = start >= 0 && !pending.slice(start).includes("\x07") ? pending.slice(start) : "";
    return Reflect.apply(original, process.stdout, [chunk, ...args]) as boolean;
  };
  process.stdout.write = observe;
  const capture = async (): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    return tui.getScreenLines().map(stripTerminalSequences);
  };
  const input = async (data: string): Promise<void> => { tui.handleTerminalInput(data); await setImmediate(); };
  const click = async (label: string, owner?: string): Promise<void> => {
    const lines = await capture();
    const y = lines.findIndex(line => line.includes(label) && (!owner || line.includes(owner)));
    if (y < 0) throw new Error("Missing " + label + "\n" + lines.join("\n"));
    const index = lines[y].indexOf(label, owner ? lines[y].indexOf(owner) : 0);
    const x = visibleWidth(lines[y].slice(0, index)) + Math.floor(label.length / 2);
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
    const frames: Record<string, string[]> = { initial: await capture() };
    try {
      if (process.env.STYLE_CONTROLS === "1") {
        await click("[ ≡ ]");
        frames.menu = await capture();
        await click("Button style");
        await input("\x1b");
        frames.text = await capture();
        await click("[Find]", "Conversation");
        frames.textSearch = await capture();
        for (const character of "STYLE") await input(character);
        await click("[Go]", "Search:");
        frames.textSearchNext = await capture();
        await click("[Exit]", "Search:");
        await click("[Copy]", "[Copy]");
        for (let n = 0; n < 100 && copies.length === 0; n++) await setTimeout(10);
        await click("[Rows]");
        frames.rows = await capture();
        const width = process.stdout.columns;
        try {
          process.stdout.columns = 24; process.stdout.emit("resize");
          frames.narrow = await capture();
          await click("[Max]", "Activity");
          frames.narrowZoom = await capture();
          await click("[Out]", "Activity");
          frames.narrowRestored = await capture();
        } finally {
          process.stdout.columns = width; process.stdout.emit("resize");
        }
      } else if (process.env.STYLE_CONTROLS === "2") {
        await click("[Menu]");
        await click("Button style");
        await input("\x1b");
        frames.iconsRestored = await capture();
      }
    } finally {
      await writeFile(path.join(ctx.cwd, process.env.STYLE_CONTROLS === "1" ? "style.json" : "style-restart.json"), JSON.stringify({ frames, copies }));
    }
  });
  pi.on("session_shutdown", () => { if (process.stdout.write === observe) process.stdout.write = original; });
}
