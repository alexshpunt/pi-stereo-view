import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & { layoutRoot?: Container; getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Observe native height growth, scrolling, drag and the auto controls. */
export default function automaticHeightProbe(pi: ExtensionAPI): void {
  let tui: Host;
  let pending = Promise.resolve();
  const samples: Record<string, { lines: string[]; height: number; available: number; contentRows: number }> = {};
  const thresholds = [1, 3, 10, 25];
  const sample = async (name: string): Promise<void> => {
    const preferences = JSON.parse(await readFile(path.join(getAgentDir(), "transcript.json"), "utf8"));
    await emittedFrame(tui, () => tui.requestRender(true));
    const views: ScrollView[] = [];
    const seen = new Set<Container>();
    const walk = (component: Container): void => {
      if (seen.has(component)) return;
      seen.add(component);
      if (component instanceof ScrollView) views.push(component);
      for (const child of component.children ?? []) if (child instanceof Container) walk(child);
    };
    walk(tui.layoutRoot!);
    const chat = views.find(view => view.viewportHeight > 0 && view.render(tui.terminal.columns)
      .some(line => stripTerminalSequences(line).includes("HEIGHT USER")));
    if (!chat) throw new Error("Missing visible Conversation viewport");
    const dock = tui.layoutRoot!.children.at(-1)!;
    const contentRows = chat.children[0].render(chat.getContentWidth(tui.terminal.columns)).length;
    samples[name] = {
      contentRows, lines: tui.getScreenLines(), height: chat.viewportHeight + (preferences.side === "left" ? 3 : 2),
      available: tui.terminal.rows - dock.render(tui.terminal.columns).length - 1,
    };
  };
  const mouse = async (button: number, x: number, y: number, suffix = "M"): Promise<void> => {
    tui.handleTerminalInput(`\x1b[<${button};${x + 1};${y + 1}${suffix}`);
    await setImmediate();
  };
  const click = async (label: string): Promise<void> => {
    const lines = tui.getScreenLines().map(stripTerminalSequences);
    const y = lines.findIndex(line => line.includes(label));
    if (y < 0) throw new Error("Missing height control: " + label);
    const x = lines[y].indexOf(label) + 2;
    await mouse(0, x, y);
    await mouse(0, x, y, "m");
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish: () => void = () => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("message_update", event => {
    if (process.env.AUTO_HEIGHT_PHASE !== "drag" || event.message.role !== "assistant") return;
    const content = event.message.content.filter(block => block.type === "text").map(block => block.text).join("");
    const count = content.split("\n").length;
    const threshold = thresholds[0];
    if (threshold === undefined || count < threshold) return;
    thresholds.shift();
    pending = pending.then(() => sample("growth" + threshold));
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    await pending;
    await sample("final");
    if (process.env.AUTO_HEIGHT_PHASE === "drag") {
      const lines = tui.getScreenLines().map(stripTerminalSequences);
      const row = lines.findIndex(line => line.startsWith("═".repeat(120)));
      if (row < 0) throw new Error("Missing horizontal drag divider");
      const preferences = JSON.parse(await readFile(path.join(getAgentDir(), "transcript.json"), "utf8"));
      const moved = row + (preferences.side === "left" ? 4 : -4);
      await mouse(0, 10, row);
      await mouse(32, 10, moved);
      await mouse(0, 10, moved, "m");
      await sample("manual");
    } else {
      for (const character of "/stereo-view height auto") tui.handleTerminalInput(character);
      tui.handleTerminalInput("\r");
      await sample("autoCommand");
      await click("[ ≡ ]");
      await sample("settings");
      await click("Conversation height");
      await sample("manualSetting");
      await click("Conversation height");
      await sample("autoSetting");
      tui.handleTerminalInput("\x1b");
      await sample("closedSettings");
    }
    await writeFile(path.join(ctx.cwd, "automatic-height-" + process.env.AUTO_HEIGHT_PHASE + ".json"), JSON.stringify(samples));
  });
}
