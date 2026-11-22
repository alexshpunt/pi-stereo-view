import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ScrollView, sliceByColumn, stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.ts";

type Host = TUI & { layoutRoot: Component; getScreenLines(): string[]; handleTerminalInput(data: string): void };
type Document = Component & { pane: string; lastWidth: number };
interface Observation {
  frames: Record<string, string[]>;
  raw: Record<string, string[]>;
  tops: Record<string, number>;
  divider?: number;
  error?: string;
}

/** Drive turn marks, hover and Go to through real terminal mouse input. */
export default function turnNavigationProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const observation: Observation = { frames: {}, raw: {}, tops: {} };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const capture = async (name?: string): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const raw = tui.getScreenLines();
    const lines = raw.map(stripTerminalSequences);
    if (name) { observation.frames[name] = lines; observation.raw[name] = raw; }
    return lines;
  };
  const components = (): Component[] => {
    const seen = new Set<Component>();
    const visit = (component: Component): void => {
      if (seen.has(component)) return;
      seen.add(component);
      for (const child of (component as Component & { children?: Component[] }).children ?? []) visit(child);
    };
    visit(tui.layoutRoot);
    return [...seen];
  };
  const view = (pane: string): ScrollView => {
    const found = components().find(component => component instanceof ScrollView && (component.children[0] as Document).pane === pane);
    if (!found) throw new Error("Missing pane: " + pane);
    return found as ScrollView;
  };
  /** Scroll a pane so the row with a marker is its first visible row. */
  const reveal = async (pane: string, marker: string): Promise<void> => {
    await capture();
    const target = view(pane);
    const document = target.children[0] as Document;
    const row = document.render(document.lastWidth).map(stripTerminalSequences).findIndex(line => line.includes(marker));
    if (row < 0) throw new Error("Missing block: " + marker);
    target.scrollTo(Math.max(0, row - 3), { disableFollow: true });
    await capture();
  };
  const region = (_line: string, pane: string): [number, number] => {
    const divider = observation.divider!;
    return pane === "chat" ? [0, divider] : [divider + 1, Math.max(0, tui.terminal.columns - divider - 1)];
  };
  /** The screen row and column of a marker inside one pane. */
  const locate = (frame: string[], pane: string, marker: string): { x: number; y: number } => {
    for (let y = 0; y < frame.length; y++) {
      const [start, width] = region(frame[y], pane);
      const part = sliceByColumn(frame[y], start, width);
      const index = part.indexOf(marker);
      if (index >= 0) return { x: start + visibleWidth(part.slice(0, index)), y };
    }
    throw new Error(`Missing ${marker} in ${pane}`);
  };
  const click = async (x: number, y: number): Promise<void> => {
    for (const suffix of ["M", "m"]) await input(`\x1b[<0;${x + 1};${y + 1}${suffix}`);
  };
  const move = (x: number, y: number): Promise<void> => input(`\x1b[<35;${x + 1};${y + 1}M`);
  /** The clock row is the first row above a block that shows a time. */
  const clockAbove = (frame: string[], pane: string, marker: string): { x: number; y: number } => {
    const block = locate(frame, pane, marker);
    for (let y = block.y; y >= 0; y--) {
      const [start, width] = region(frame[y], pane);
      const part = sliceByColumn(frame[y], start, width);
      const match = /~?\d{2}:\d{2}:\d{2}/.exec(part);
      if (match) return { x: start + visibleWidth(part.slice(0, match.index)) + 1, y };
    }
    throw new Error("Missing clock above " + marker);
  };
  const top = (pane: string): number => view(pane).scrollTop;
  const save = (ctx: ExtensionContext): Promise<void> =>
    writeFile(path.join(ctx.cwd, "turn-navigation-observation.json"), JSON.stringify(observation));

  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    try {
      const first = await capture("initial");
      const header = first.findIndex(line => line.includes("Conversation") && line.includes("Activity"));
      if (header < 0) throw new Error("Missing panel headers");
      observation.divider = visibleWidth(first[header].slice(0, first[header].indexOf("║")));
      if (process.env.TURN_SCENARIO === "settings") {
        // Turn clock colors from the settings list, with hover unavailable in a multiplexer.
        const toolbar = first[0];
        await click(visibleWidth(toolbar.slice(0, toolbar.indexOf("[ ≡ ]"))) + 2, 0);
        await capture("settings");
        // Past the general settings and the Turns header to Clock color.
        for (let index = 0; index < 10; index++) await input("\x1b[B");
        await input(" ");
        await input("\x1b");
        await reveal("activity", "FIRST-PATH");
        await reveal("chat", "FIRST REQUEST");
        const frame = await capture("colored");
        await move(locate(frame, "activity", "FIRST-PATH").x, locate(frame, "activity", "FIRST-PATH").y);
        await capture("unavailableHover");
        await save(ctx);
        return;
      }
      await reveal("activity", "FIRST-PATH");
      await reveal("chat", "FIRST ANSWER");
      const before = await capture("beforeHover");
      const tool = locate(before, "activity", "FIRST-PATH");
      await move(tool.x + 2, tool.y);
      await capture("hovered");
      await move(tool.x + 6, tool.y);
      await capture("hoveredSameAct");
      await move(0, 0);
      await capture("left");

      // Activity -> Conversation from a clock.
      view("chat").scrollToEnd();
      await reveal("activity", "SECOND-PATH");
      const clock = clockAbove(await capture(), "activity", "SECOND-PATH");
      await click(clock.x, clock.y);
      await capture("clockJump");
      observation.tops.clockJump = top("chat");

      // Conversation -> Activity from the Go to button.
      view("activity").scrollToEnd();
      await reveal("chat", "SECOND REQUEST");
      const frame = await capture();
      const request = locate(frame, "chat", "SECOND REQUEST");
      let button: { x: number; y: number } | undefined;
      for (let y = request.y + 1; y < frame.length && !button; y++) {
        const [start, width] = region(frame[y], "chat");
        const part = sliceByColumn(frame[y], start, width);
        const index = part.indexOf("[ ⇄ ]");
        if (index >= 0) button = { x: start + visibleWidth(part.slice(0, index)) + 2, y };
      }
      if (!button) throw new Error("Missing Go to button below SECOND REQUEST");
      await click(button.x, button.y);
      await capture("buttonJump");
      observation.tops.buttonJump = top("activity");

      // A zoomed panel returns to the split before scrolling the other one.
      const zoom = await capture();
      const activityHeader = zoom.find(line => line.includes("Activity") && line.includes("[ ↗ ]"))!;
      await click(visibleWidth(activityHeader.slice(0, activityHeader.lastIndexOf("[ ↗ ]"))) + 2, zoom.indexOf(activityHeader));
      await capture("zoomed");
      view("chat").scrollToEnd();
      await reveal("activity", "FIRST-PATH");
      const zoomedFrame = await capture();
      // A zoomed Activity takes the whole width.
      const toolRow = zoomedFrame.findIndex(line => line.includes("FIRST-PATH"));
      if (toolRow < 0) throw new Error("Missing FIRST-PATH in zoomed Activity");
      const zoomedTool = { y: toolRow };
      let zoomedClock: { x: number; y: number } | undefined;
      for (let y = zoomedTool.y; y >= 0 && !zoomedClock; y--) {
        const match = /~?\d{2}:\d{2}:\d{2}/.exec(zoomedFrame[y]);
        if (match) zoomedClock = { x: visibleWidth(zoomedFrame[y].slice(0, match.index)) + 1, y };
      }
      if (!zoomedClock) throw new Error("Missing zoomed clock");
      await click(zoomedClock.x, zoomedClock.y);
      await setImmediate();
      await capture("restored");
      observation.tops.restored = top("chat");
      await save(ctx);
    } catch (error) {
      observation.error = String(error) + "\n" + (error as Error).stack;
      observation.frames.failure = await capture();
      await save(ctx);
      throw error;
    }
  });
}
