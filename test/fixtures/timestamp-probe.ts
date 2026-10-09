import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void; layoutRoot?: Container };

/** Observe real streaming tools and native controls while timestamps are mounted. */
export default function timestampProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const frames: Record<string, string[]> = {};
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    return tui.getScreenLines();
  };
  const containers = (): Container[] => {
    const found = new Set<Container>();
    const walk = (component: Container): void => {
      if (found.has(component)) return;
      found.add(component);
      for (const child of component.children ?? []) if (child instanceof Container) walk(child);
    };
    if (tui.layoutRoot) walk(tui.layoutRoot);
    return [...found];
  };
  const views = (): ScrollView[] => containers().filter((component): component is ScrollView => component instanceof ScrollView);
  const click = async (label: string, owner?: string): Promise<void> => {
    const lines = (await capture()).map(stripTerminalSequences);
    const y = lines.findIndex(line => line.includes(label) && (!owner || line.includes(owner)));
    if (y < 0) throw new Error("Missing native timestamp control: " + label + " " + owner);
    const index = lines[y].indexOf(label, owner ? lines[y].indexOf(owner) : 0);
    const x = visibleWidth(lines[y].slice(0, index)) + 2;
    for (const suffix of ["M", "m"]) {
      tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}${suffix}`);
      await setImmediate();
    }
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
    name: "clock_probe", label: "Clock probe", description: "Exercise stable start time across partial output.",
    parameters: Type.Object({ tag: Type.Optional(Type.String()) }),
    renderCall: args => new Text(String(args.tag ?? "CLOCK") + " CALL MARKER", 0, 0),
    renderResult: result => new Text(result.content.filter(block => block.type === "text").map(block => block.text).join(""), 0, 0),
    async execute(_id, _params, _signal, onUpdate) {
      frames.started = await capture();
      onUpdate?.({ content: [{ type: "text", text: "CLOCK PARTIAL MARKER" }], details: {} });
      frames.partial = await capture();
      await setTimeout(1100);
      frames.later = await capture();
      return { content: [{ type: "text", text: "CLOCK DONE MARKER" }], details: {} };
    },
  });
  pi.on("message_end", async event => {
    if (event.message.role === "user") frames.unpersistedUser = await capture();
  });
  let streaming: Promise<void> | undefined;
  pi.on("message_update", (event, ctx) => {
    if (process.env.TIMESTAMP_STREAM !== "1" || streaming || event.assistantMessageEvent.type !== "text_delta") return;
    const idle = ctx.isIdle();
    // Pi delivers this event to native UI after extension observers return.
    streaming = setImmediate().then(async () => {
      frames.streaming = await capture();
      frames.streamingIdle = [String(idle)];
    });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    await streaming;
    const inspect = async (name: string): Promise<void> => {
      for (const view of views()) view.scrollTo(0);
      frames[name] = await capture();
    };
    if (process.env.TIMESTAMP_BAD_METADATA === "1") {
      await capture();
      const user = containers().find(component => component.constructor.name === "UserMessageComponent");
      if (!user) throw new Error("Missing native user component for compatibility check");
      const original = Reflect.get(user, "text");
      try {
        Reflect.deleteProperty(user, "text");
        frames.unsupported = await capture();
      } finally {
        Reflect.set(user, "text", original);
      }
    }
    if (process.env.TIMESTAMP_SCROLLBAR === "1") {
      for (const view of views()) {
        view.setScrollbar("auto");
        view.scrollTo(0);
      }
      await capture();
      // Native pointer activation makes the auto scrollbar overlay visible.
      tui.handleTerminalInput("\x1b[<35;10;5M");
      frames.scrollbar = await capture();
      frames.scrollbarVisible = views().map(view => String(view.isScrollbarVisible));
    }
    if (process.env.TIMESTAMP_LAYOUTS === "1") {
      await inspect("combined");
      for (const view of views()) view.scrollTo(100_000);
      frames.combinedEnd = await capture();
      await click("[ ◫ ]");
      await inspect("columns");
      await click("[ ↗ ]", "Activity");
      await inspect("activity");
      await click("[ ↙ ]", "Activity");
      await click("[ ↗ ]", "Conversation");
      await inspect("chat");
      await click("[ ↙ ]", "Conversation");
      await click("[ ▤ ]");
      await inspect("rows");
      for (const view of views()) view.scrollTo(100_000);
      frames.rowsEnd = await capture();
    } else frames.finished = await capture();
    await writeFile(path.join(ctx.cwd, "timestamp-frames.json"), JSON.stringify(frames));
    const file = ctx.sessionManager.getSessionFile();
    if (file) await writeFile(path.join(ctx.cwd, "timestamp-session.jsonl"), await readFile(file, "utf8"));
  });
}
