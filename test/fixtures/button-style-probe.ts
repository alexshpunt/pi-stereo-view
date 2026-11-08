import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.ts";

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
    const ownerRow = owner ? lines.findIndex(line => line.includes(owner)) : -1;
    const y = lines.findIndex((line, row) => line.includes(label) && (!owner ||
      (row >= ownerRow && row <= ownerRow + 3 && ownerRow >= 0)));
    if (y < 0) throw new Error("Missing " + label + "\n" + lines.join("\n"));
    const index = lines[y].indexOf(label);
    const x = visibleWidth(lines[y].slice(0, index)) + Math.floor(label.length / 2);
    await input(`\x1b[<0;${x + 1};${y + 1}M`);
    await input(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  const clickButton = async (button: number, pane?: string): Promise<void> => {
    const lines = await capture();
    const start = pane ? lines.findIndex(line => line.includes(pane)) : 0;
    const end = pane ? Math.min(lines.length, start + 4) : lines.findIndex(line => line.includes("─"));
    const divider = pane ? lines[start].indexOf("║") : -1;
    const paneColumn = divider >= 0 && lines[start].indexOf(pane!) > divider ? divider + 1 : 0;
    const paneEnd = divider >= 0 && paneColumn === 0 ? divider : Number.POSITIVE_INFINITY;
    const buttons = lines.slice(start, end).flatMap((line, offset) =>
      Array.from(line.matchAll(/\[[^\[\]]+\]/g))
        .filter(match => !pane || (match.index >= paneColumn && match.index < paneEnd))
        .map(match => ({ x: visibleWidth(line.slice(0, match.index)) + 1, y: start + offset })));
    const target = buttons[button];
    if (!target) throw new Error("Missing button " + button + "\n" + lines.join("\n"));
    await clickAt(target.x, target.y);
  };
  const clickAt = async (x: number, y: number): Promise<void> => {
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
    const compactStates: boolean[] = [];
    const headerBackgrounds: string[] = [];
    const waitForCompact = async (expected: boolean): Promise<void> => {
      const file = path.join(process.env.PI_CODING_AGENT_DIR!, "transcript.json");
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const value = JSON.parse(await readFile(file, "utf8")).compactTools;
          if (value === expected) { compactStates.push(value); return; }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await setTimeout(10);
      }
      throw new Error("Compact tools setting did not change");
    };
    try {
      if (process.env.STYLE_CONTROLS === "1") {
        await click("[ ≡ ]");
        frames.menu = await capture();
        await click("Button style");
        await input("\x1b");
        frames.text = await capture();
        const headerRow = frames.text.findIndex(line => line.includes("Activity"));
        const header = frames.text[headerRow];
        const gap = header.indexOf("] [", header.indexOf("Activity"));
        if (gap < 0) throw new Error("Missing Activity button gap");
        const column = visibleWidth(header.slice(0, gap)) + 1;
        const raw = tui.getScreenLines()[headerRow];
        for (const x of [column - 1, column]) {
          const cell = sliceByColumn(raw, x, 1);
          let background = "default";
          for (const match of cell.matchAll(/\x1b\[([0-9;]*)m/g)) {
            const codes = match[1].split(";").map(value => Number(value || 0));
            for (let i = 0; i < codes.length; i++) {
              if (codes[i] === 0 || codes[i] === 49) background = "default";
              else if (codes[i] === 48 && (codes[i + 1] === 2 || codes[i + 1] === 5)) {
                const count = codes[i + 1] === 2 ? 5 : 3;
                background = codes.slice(i, i + count).join(";");
                i += count - 1;
              }
            }
          }
          headerBackgrounds.push(background);
        }
        await clickButton(0, "Activity");
        await waitForCompact(true);
        await clickButton(0, "Activity");
        await waitForCompact(false);
        await click("[Find]", "Conversation");
        frames.textSearch = await capture();
        for (const character of "STYLE") await input(character);
        await click("[Go]", "Search:");
        frames.textSearchNext = await capture();
        await click("[Exit]", "Search:");
        await click("[Copy]", "[Copy]");
        for (let n = 0; n < 100 && copies.length === 0; n++) await setTimeout(10);
        await clickButton(1);
        frames.rows = await capture();
        const width = process.stdout.columns;
        try {
          process.stdout.columns = 24; process.stdout.emit("resize");
          frames.narrow = await capture();
          await clickButton(2, "Activity");
          frames.narrowZoom = await capture();
          await clickButton(2, "Activity");
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
      await writeFile(path.join(ctx.cwd, process.env.STYLE_CONTROLS === "1" ? "style.json" : "style-restart.json"), JSON.stringify({ frames, copies, compactStates, headerBackgrounds }));
    }
  });
  pi.on("session_shutdown", () => { if (process.stdout.write === observe) process.stdout.write = original; });
}
