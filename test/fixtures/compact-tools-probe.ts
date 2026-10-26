import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Drive compact tools through real native controls, search and clipboard transport. */
export default function compactToolsProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const frames: Record<string, string[]> = {};
  let copied = "";
  const write = process.stdout.write;
  const observe: typeof process.stdout.write = function (chunk, ...args: unknown[]): boolean {
    const value = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const match of value.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)) copied = Buffer.from(match[1], "base64").toString("utf8");
    return Reflect.apply(write, process.stdout, [chunk, ...args]) as boolean;
  };
  const capture = async (name?: string): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const frame = tui.getScreenLines();
    if (name) frames[name] = frame;
    return frame.map(stripTerminalSequences);
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const click = async (label: string, owner = ""): Promise<void> => {
    const lines = await capture();
    const y = lines.findIndex(line => line.includes(owner) && line.includes(label));
    if (y < 0) throw new Error("Missing compact control: " + owner + " " + label);
    const index = lines[y].indexOf(label, lines[y].indexOf(owner));
    const x = visibleWidth(lines[y].slice(0, index)) + 2;
    await input(`\x1b[<0;${x + 1};${y + 1}M`);
    await input(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  pi.on("session_start", async (_event, ctx) => {
    process.stdout.write = observe;
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.registerEntryRenderer<{ parentToolCallId: string; text: string }>("compact-linked", entry => new Text(entry.data!.text, 0, 0));
  pi.registerTool({
    name: "compact_probe", label: "Compact probe", description: "Produce deterministic compact tool activity.",
    parameters: Type.Object({ tag: Type.String() }),
    renderCall: args => new Text("NATIVE-HEADER-" + args.tag, 0, 0),
    renderResult: result => new Text(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), 0, 0),
    async execute(_id, args, _signal, onUpdate) {
      if (args.tag === "FIRST-FIXTURE") {
        await capture("normal");
        await click("[ ⊟ ]", "Activity");
        await capture("started");
        onUpdate?.({ content: [{ type: "text", text: "PARTIAL-FIXTURE" }], details: {} });
        await capture("partial");
      } else if (args.tag === "SECOND-FIXTURE") {
        await capture("firstFinished");
        throw new Error("ERROR-RESULT-FIXTURE");
      }
      return { content: [{ type: "text", text: "RESULT-" + args.tag }], details: {} };
    },
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant" || !event.message.content.some(block => block.type === "toolCall" && block.id === "compact-third")) return;
    return { message: { ...event.message, content: [
      { type: "thinking", thinking: "REASON-FIXTURE" }, ...event.message.content,
    ] } };
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    try {
      pi.appendEntry("compact-linked", { parentToolCallId: "compact-first", text: "LATE-RESULT-FIXTURE" });
      ctx.ui.setEditorText("UNSENT-FIXTURE");
      await capture("rows");
      await click("[ ↗ ]", "Activity");
      await capture("zoom");
      await click("[ ⌕ ]", "Activity");
      await input("LATE-RESULT-FIXTURE");
      await input("\r");
      await capture();
      await capture("search");
      await input("\x1b");
      await capture("searchClosed");
      ctx.ui.setEditorText("/stereo-view copy");
      await input("\r");
      const picker = await capture("picker");
      const choice = picker.find(line => line.includes("compact_probe") && line.includes("FIRST-FIXTURE") && /\d+\. /.test(line))?.match(/(\d+)\. /)?.[1];
      if (!choice) throw new Error("Missing compact tool copy choice");
      for (let index = 1; index < Number(choice); index++) await input("\x1b[B");
      await input("\r");
      for (let attempt = 0; attempt < 100 && !copied; attempt++) await setTimeout(10);
      await click("[ ⊞ ]", "Activity");
      await capture("restored");
      await click("[ ⊟ ]", "Activity");
      await click("[ ↙ ]", "Activity");
      await click("[ ▥ ]");
      await capture("columns");
      const { columns, rows } = process.stdout;
      try {
        // Columns need 24 Conversation + 40 Activity + one divider cell.
        process.stdout.columns = 65;
        process.stdout.rows = 45;
        process.stdout.emit("resize");
        await capture("narrow");
        process.stdout.columns = 64;
        process.stdout.emit("resize");
        await capture("fallback");
      } finally {
        process.stdout.columns = columns;
        process.stdout.rows = rows;
        process.stdout.emit("resize");
      }
      await capture();
      await click("[ ▣ ]");
      await capture("combined");
      await click("[ ◫ ]");
      await capture("again");
      await writeFile(path.join(ctx.cwd, "compact-observation.json"), JSON.stringify({ frames, copied }));
    } catch (error) {
      await capture("failure");
      await writeFile(path.join(ctx.cwd, "compact-observation.json"), JSON.stringify({ frames, copied, error: String(error) }));
      throw error;
    }
  });
  pi.on("session_shutdown", () => { if (process.stdout.write === observe) process.stdout.write = write; });
}
