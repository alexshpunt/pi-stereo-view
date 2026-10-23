import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ScrollView, sliceByColumn, stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & {
  layoutRoot: Component;
  getScreenLines(): string[];
  handleTerminalInput(data: string): void;
  hasActiveSelection(): boolean;
  resetTextSelection(): void;
};
type Document = Component & { pane: string; lastWidth: number };
type Observation = {
  copies: Record<string, string>;
  frames: Record<string, string[]>;
  draftBefore?: string;
  draftAfter?: string;
  selection?: boolean;
  error?: string;
};

/** Capture the real clipboard transport while driving native mouse and keyboard input. */
export default function blockCopyProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const observation: Observation = { copies: {}, frames: {} };
  const clipboard: string[] = [];
  const write = process.stdout.write;
  let pending = "";
  const observeWrite: typeof process.stdout.write = function (chunk, ...args: unknown[]): boolean {
    const value = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    pending += value;
    const expression = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(pending))) clipboard.push(Buffer.from(match[1], "base64").toString("utf8"));
    const start = pending.lastIndexOf("\x1b]52;");
    pending = start >= 0 && !pending.slice(start).includes("\x07") ? pending.slice(start) : "";
    return Reflect.apply(write, process.stdout, [chunk, ...args]) as boolean;
  };
  const capture = async (): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    return tui.getScreenLines().map(stripTerminalSequences);
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const components = (): Component[] => {
    const seen = new Set<Component>();
    const visit = (component: Component): void => {
      if (seen.has(component)) return;
      seen.add(component);
      const container = component as Component & { children?: Component[] };
      for (const child of container.children ?? []) visit(child);
    };
    visit(tui.layoutRoot);
    return [...seen];
  };
  const reveal = async (pane: string, marker: string): Promise<void> => {
    await capture();
    const view = components().find(component => component instanceof ScrollView &&
      (component.children[0] as Document).pane === pane) as ScrollView | undefined;
    if (!view) throw new Error("Missing copy pane: " + pane);
    const document = view.children[0] as Document;
    const rows = document.render(document.lastWidth).map(stripTerminalSequences);
    const row = rows.findIndex(line => line.includes(marker));
    if (row < 0) throw new Error("Missing copy block: " + marker);
    view.scrollTo(row, { disableFollow: true });
    await capture();
  };
  const clickAt = async (x: number, y: number): Promise<void> => {
    for (const suffix of ["M", "m"]) await input(`\x1b[<0;${x + 1};${y + 1}${suffix}`);
  };
  const control = async (label: string, owner: string): Promise<void> => {
    const rows = await capture();
    const y = rows.findIndex(line => line.includes(owner) && line.includes(label));
    if (y < 0) throw new Error("Missing panel control: " + label);
    const offset = rows[y].indexOf(label, rows[y].indexOf(owner));
    await clickAt(visibleWidth(rows[y].slice(0, offset)) + 1, y);
  };
  const awaitCopy = async (before: number): Promise<string> => {
    for (let attempt = 0; attempt < 100 && clipboard.length === before; attempt++) await setTimeout(10);
    if (clipboard.length !== before + 1) throw new Error(`Expected one clipboard write, got ${clipboard.length - before}`);
    return clipboard[before];
  };
  const copy = async (name: string, pane: string, marker: string): Promise<void> => {
    await reveal(pane, marker);
    const frame = await capture();
    observation.frames[name] = frame;
    const bodyRow = frame.findIndex(line => line.includes(marker) && !line.includes("Search:"));
    if (bodyRow < 0) throw new Error("Copy target is not on screen: " + marker);
    const markerColumn = visibleWidth(frame[bodyRow].slice(0, frame[bodyRow].indexOf(marker)));
    const separator = frame[bodyRow].indexOf("║");
    const divider = separator < 0 ? -1 : visibleWidth(frame[bodyRow].slice(0, separator));
    const left = divider >= 0 && markerColumn > divider ? divider + 1 : 0;
    const right = divider >= 0 && markerColumn < divider ? divider : tui.terminal.columns;
    let y = -1;
    let x = -1;
    for (let row = bodyRow + 1; row < frame.length; row++) {
      const region = sliceByColumn(frame[row], left, right);
      const icon = region.indexOf("⧉");
      if (icon < 0) continue;
      y = row;
      // Exercise the glyph overhang, not just its first terminal cell.
      x = left + visibleWidth(region.slice(0, icon)) + 1;
      break;
    }
    if (y < 0) throw new Error("Missing copy footer for " + marker);
    const before = clipboard.length;
    await clickAt(x, y);
    observation.copies[name] = await awaitCopy(before);
  };
  const save = (ctx: ExtensionContext): Promise<void> =>
    writeFile(path.join(ctx.cwd, "block-copy-observation.json"), JSON.stringify(observation));

  pi.registerEntryRenderer<{ parentToolCallId: string; text: string }>("copy-linked-output", entry =>
    new Text(entry.data!.text, 0, 0));
  pi.registerTool({
    name: "copy_probe", label: "Copy probe", description: "Produce saved output for block-copy checks.",
    parameters: Type.Object({ tag: Type.String() }),
    renderCall: args => new Text("TOOL COPY " + args.tag, 0, 0),
    renderResult: (result, options) => new Text(options.expanded ? result.content
      .filter(block => block.type === "text").map(block => block.text).join("\n") : "COLLAPSED COPY RESULT", 0, 0),
    async execute(_id, args, _signal, onUpdate) {
      if (args.tag === "first" && process.env.COPY_CLIPBOARD_FAILURE !== "1") {
        onUpdate?.({ content: [{ type: "text", text: "PARTIAL COPY RESULT" }], details: {} });
        await copy("streaming", "activity", "TOOL COPY first");
      }
      return {
        content: [{ type: "text", text: Array.from({ length: 70 }, (_, index) => `${args.tag} full result line ${index}`).join("\n") }],
        details: {},
      };
    },
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant" || !event.message.content.some(block =>
      block.type === "text" && block.text.includes("ASSISTANT COPY"))) return;
    return { message: { ...event.message, content: [
      { type: "thinking", thinking: "REASON COPY **данные**\n\n```ts\nconst reasoning = 1;\n```" },
      ...event.message.content,
    ] } };
  });
  pi.on("session_start", async (_event, ctx) => {
    process.stdout.write = observeWrite;
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    try {
      if (process.env.COPY_CLIPBOARD_FAILURE === "1") {
        const names = ["PATH", "DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION", "WT_SESSION", "SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"];
        const original = names.map(name => process.env[name]);
        try {
          for (const name of names) process.env[name] = "";
          process.env.PATH = path.join(ctx.cwd, "no-clipboard-commands");
          process.env.DISPLAY = ":invalid-copy-display";
          try { await copy("failed", "chat", "USER COPY"); }
          catch { /* A rejected clipboard write must not emit OSC 52 or report success. */ }
          observation.frames.clipboardFailure = await capture();
        } finally {
          names.forEach((name, index) => {
            if (original[index] === undefined) delete process.env[name];
            else process.env[name] = original[index];
          });
        }
        await save(ctx);
        return;
      }
      pi.appendEntry("copy-linked-output", { parentToolCallId: "second-copy", text: "LATE SECOND COPY" });
      pi.appendEntry("copy-linked-output", { parentToolCallId: "first-copy", text: "LATE FIRST COPY" });
      pi.appendEntry("copy-linked-output", { parentToolCallId: "first-copy", text: "LATER FIRST COPY" });
      await capture();
      for (const component of components()) {
        if (component.constructor.name === "ToolExecutionComponent") {
          (component as Component & { setExpanded(expanded: boolean): void }).setExpanded(false);
        }
      }
      ctx.ui.setEditorText("keep this unsent draft");
      observation.draftBefore = ctx.ui.getEditorText();
      await copy("user", "chat", "USER COPY");
      await copy("assistant", "chat", "ASSISTANT COPY");
      await copy("reasoning", "activity", "REASON COPY");
      await copy("firstTool", "activity", "TOOL COPY first");
      await copy("secondTool", "activity", "TOOL COPY second");
      await copy("linked", "activity", "LATE FIRST COPY");
      await control("[ ↗ ]", "Conversation");
      await copy("zoomed", "chat", "USER COPY");
      await control("[ ↙ ]", "Conversation");
      const { columns, rows } = process.stdout;
      try {
        process.stdout.columns = 110;
        process.stdout.rows = 45;
        process.stdout.emit("resize");
        await copy("resized", "chat", "USER COPY");
      } finally {
        process.stdout.columns = columns;
        process.stdout.rows = rows;
        process.stdout.emit("resize");
      }
      await capture();
      await input("\x06");
      await input("USER COPY");
      await capture();
      await copy("highlighted", "chat", "USER COPY");
      await input("\x1b");
      observation.draftAfter = ctx.ui.getEditorText();
      await reveal("chat", "USER COPY");
      const frame = await capture();
      const y = frame.findIndex(line => line.includes("USER COPY"));
      const x = visibleWidth(frame[y].slice(0, frame[y].indexOf("USER COPY")));
      await input(`\x1b[<0;${x + 1};${y + 1}M`);
      await input(`\x1b[<32;${x + 5};${y + 1}M`);
      await input(`\x1b[<0;${x + 5};${y + 1}m`);
      observation.selection = tui.hasActiveSelection();
      tui.resetTextSelection();
      await control("[ ≡ ]", "");
      observation.frames.copySettings = await capture();
      await input("\x1b[B");
      await input(" ");
      await input("\x1b");
      observation.frames.copyIconsHidden = await capture();
      ctx.ui.setEditorText("/stereo-view copy");
      await input("\r");
      const picker = await capture();
      observation.frames.keyboardPicker = picker;
      const choice = picker.find(line => line.includes(". User:") && line.includes("USER COPY"))?.match(/(\d+)\. User:/)?.[1];
      if (!choice) throw new Error("User block is missing from the keyboard copy picker");
      for (let index = 1; index < Number(choice); index++) await input("\x1b[B");
      const before = clipboard.length;
      await input("\r");
      observation.copies.keyboard = await awaitCopy(before);
      await control("[ ≡ ]", "");
      await input("\x1b[B");
      await input(" ");
      await input("\x1b");
      observation.frames.copyIconsRestored = await capture();
      await save(ctx);
    } catch (error) {
      observation.error = String(error);
      observation.frames.failure = await capture();
      await save(ctx);
      throw error;
    }
  });
  pi.on("session_shutdown", () => {
    if (process.stdout.write === observeWrite) process.stdout.write = write;
  });
}
