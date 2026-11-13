import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emittedFrame } from "./emitted-frame.ts";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Observe compact Activity while streamed tool calls run, wait out their delay and collapse. */
export default function streamToolsProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const frames: Record<string, string[]> = {};
  const capture = async (name: string): Promise<void> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    frames[name] = tui.getScreenLines().map(stripTerminalSequences);
  };
  const click = async (label: string): Promise<void> => {
    const lines = tui.getScreenLines().map(stripTerminalSequences);
    const y = lines.findIndex(line => line.includes(label));
    if (y < 0) throw new Error("Missing control: " + label);
    const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(label))) + 2;
    tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}M`);
    tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}m`);
    await setTimeout(50);
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.registerTool({
    name: "stream_probe", label: "Stream probe", description: "Produce deterministic streamed tool activity.",
    parameters: Type.Object({ tag: Type.String() }),
    executionMode: "sequential",
    renderCall: args => new Text("NATIVE-HEADER-" + args.tag, 0, 0),
    renderResult: result => new Text(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), 0, 0),
    async execute(_id, args) {
      if (args.tag === "A") await capture("running");
      else if (args.tag === "B") await capture("secondRunning");
      return { content: [{ type: "text", text: "RESULT-" + args.tag }], details: {} };
    },
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    await capture("justFinished");
    await setTimeout(Number(process.env.STREAM_WAIT_MS ?? 1400));
    await capture("collapsed");
    const lines = tui.getScreenLines().map(stripTerminalSequences);
    const label = lines.some(line => line.includes("[Settings]")) ? "[Settings]" : "[ ≡ ]";
    await click(label);
    await capture("settings");
    if (process.env.GROUP_TOOLS_TOGGLE === "1") {
      tui.handleTerminalInput("\x1b");
      await capture("closedSettings");
      await click("[ ⊞ ]");
      await capture("toolbar");
      await click("[ ⊟ ]");
      await capture("compactAgain");
      await click(label);
      await click("Group Activity tools");
      tui.handleTerminalInput("\x1b");
      await capture("grouped");
      await click(label);
      await click("Group Activity tools");
      tui.handleTerminalInput("\x1b");
      await capture("ungroupedAgain");
    }
    await writeFile(path.join(ctx.cwd, "stream-observation.json"), JSON.stringify(frames));
  });
}
