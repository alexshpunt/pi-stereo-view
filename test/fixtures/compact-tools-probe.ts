import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Drive compact tools through real native controls, search and clipboard transport. */
export default function compactToolsProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const frames: Record<string, string[]> = {};
  let copied = "";
  const executions: string[] = [];
  const actions: string[] = [];
  const actionPoints: { tag: string; x: number; width: number }[] = [];
  const renderWidths: Record<string, number> = {};
  const widths: Record<string, Record<string, number>> = {};
  class NativeCallText extends Text {
    constructor(private readonly tag: string) { super("NATIVE-HEADER-" + tag, 0, 0); }
    override render(width: number): string[] {
      renderWidths[this.tag] = width;
      return super.render(width);
    }
  }
  const write = process.stdout.write;
  const observe: typeof process.stdout.write = function (chunk, ...args: unknown[]): boolean {
    const value = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const match of value.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)) copied = Buffer.from(match[1], "base64").toString("utf8");
    return Reflect.apply(write, process.stdout, [chunk, ...args]) as boolean;
  };
  const capture = async (name?: string): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const frame = tui.getScreenLines();
    if (name) {
      frames[name] = frame;
      widths[name] = { ...renderWidths };
    }
    return frame.map(stripTerminalSequences);
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const click = async (label: string, owner = "", match: (line: string) => boolean = () => true): Promise<void> => {
    const lines = await capture();
    const y = lines.findIndex(line => line.includes(owner) && line.includes(label) && match(line));
    if (y < 0) throw new Error("Missing compact control: " + owner + " " + label);
    const index = lines[y].indexOf(label, lines[y].indexOf(owner));
    const x = visibleWidth(lines[y].slice(0, index)) + 2;
    await input(`\x1b[<0;${x + 1};${y + 1}M`);
    await input(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  const clickGroup = (): Promise<void> => click("compact_probe", "", line =>
    !["A938", "D938", "B938", "E938", "C938"].some(tag => line.includes(tag)));
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
    // These lifecycle captures inspect the preceding completed call, not a concurrent sibling.
    executionMode: "sequential",
    renderCall: args => new NativeCallText(args.tag),
    renderResult: result => {
      const body = new Container();
      body.addChild(new Text(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), 0, 0));
      const tag = result.details && typeof result.details === "object" && "tag" in result.details && typeof result.details.tag === "string" ? result.details.tag : undefined;
      if (tag) body.addChild(new MouseRegion(new Text("ACTION-" + tag, 0, 0), event => {
        if (event.button !== "left") return;
        if (event.type === "press") return { capture: true };
        if (event.type === "click") {
          actions.push(tag);
          actionPoints.push({ tag, x: event.x, width: event.width });
          return { handled: true };
        }
      }));
      return body;
    },
    async execute(_id, args, _signal, onUpdate) {
      executions.push(args.tag);
      if (args.tag === "A938") {
        await capture("normal");
        await click("[ ⊟ ]", "Activity");
        await capture("initialGroup");
        await click("compact_probe");
        await capture("started");
        onUpdate?.({ content: [{ type: "text", text: "PARTIAL-FIXTURE" }], details: { tag: args.tag } });
        await capture("partial");
        await setTimeout(1100);
        await capture("pendingLater");
      } else if (args.tag === "D938") {
        await capture("firstFinished");
        await click("D938", "compact_probe");
        await capture("suffixCardOpen");
        await clickGroup();
        await capture("suffixHidden");
      } else if (args.tag === "B938") {
        await capture("mergedCollapsed");
        await clickGroup();
        await capture("mergedRestored");
        await click("D938", "compact_probe");
        await capture("peerFinished");
        throw new Error("ERROR-RESULT-FIXTURE");
      } else if (args.tag === "E938") {
        await capture("firstFailure");
        throw new Error("ERROR-RESULT-SECOND-FIXTURE");
      }
      return { content: [{ type: "text", text: "RESULT-" + args.tag }], details: { tag: args.tag } };
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
      await click("compact_probe");
      await capture("groupClosed");
      await click("compact_probe");
      await capture("groupOpen");
      await click("A938", "compact_probe");
      await capture("memberOpen");
      await click("ACTION-A938");
      await capture("nativeAction");
      await click("[ ↙ ]", "Activity");
      await capture("memberRows");
      await click("[ ▥ ]");
      await capture("memberColumns");
      const expandedSize = { columns: process.stdout.columns, rows: process.stdout.rows };
      try {
        process.stdout.columns = 65;
        process.stdout.rows = 45;
        process.stdout.emit("resize");
        await capture("memberNarrow");
      } finally {
        process.stdout.columns = expandedSize.columns;
        process.stdout.rows = expandedSize.rows;
        process.stdout.emit("resize");
      }
      await capture();
      await click("[ ▤ ]");
      await click("[ ↗ ]", "Activity");
      await capture("memberZoom");
      await click("compact_probe");
      await capture("memberHidden");
      await click("compact_probe");
      await capture("memberReopened");
      await click("A938", "compact_probe");
      await capture("memberClosed");
      await click("B938", "compact_probe");
      await capture("failureOpen");
      await click("B938", "compact_probe");
      await capture("failureClosed");
      await click("[ ≡ ]");
      await input(" ");
      await input("\x1b");
      await capture("clocksOff");
      await click("[ ≡ ]");
      await input(" ");
      await input("\x1b");
      await capture("clocksOn");
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
      const choice = picker.find(line => line.includes("compact_probe") && line.includes("A938") && /\d+\. /.test(line))?.match(/(\d+)\. /)?.[1];
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
      const starts = ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === "pi-agent-transcript/tool-start"
        ? [entry.data] : []);
      await writeFile(path.join(ctx.cwd, "compact-observation.json"), JSON.stringify({ frames, copied, starts, executions, actions, widths, actionPoints }));
    } catch (error) {
      await capture("failure");
      await writeFile(path.join(ctx.cwd, "compact-observation.json"), JSON.stringify({ frames, copied, widths, actionPoints, error: String(error) }));
      throw error;
    }
  });
  pi.on("session_shutdown", () => { if (process.stdout.write === observe) process.stdout.write = write; });
}
