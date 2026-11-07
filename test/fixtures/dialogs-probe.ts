import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { CustomEditor, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

export default function dialogsProbe(pi: ExtensionAPI): void {
  let host: Host;
  const frames: Record<string, unknown> = {};
  const results: Record<string, unknown> = {};
  const events: Array<{ type: string; x: number; y: number; width: number }> = [];
  const editorWidths: number[] = [];
  let disposed = 0;
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      host = tui as Host;
      queueMicrotask(done);
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true } });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const capture = async (key: string) => {
      host.requestRender(true);
      await setImmediate();
      const lines = host.getScreenLines();
      frames[key] = lines;
      return lines.map(stripTerminalSequences);
    };
    const key = (data: string) => host.handleTerminalInput(data);
    const click = async (label: string, side?: "left" | "right") => {
      const lines = await capture("_");
      const y = lines.findIndex(line => line.includes(label));
      if (y < 0) throw new Error("Missing control " + label + "\n" + lines.join("\n"));
      const x = lines[y].indexOf(label, side === "right" ? lines[y].indexOf("║") + 1 : 0);
      key(`\x1b[<0;${x + 1};${y + 1}M`);
      key(`\x1b[<0;${x + 1};${y + 1}m`);
      await setImmediate();
    };
    let pending = ctx.ui.select("SELECT-PROBE", ["CHOICE-A", "CHOICE-B"]);
    await capture("select");
    key("\x1b[B"); key("\r");
    results.select = await pending;
    const confirm = ctx.ui.confirm("CONFIRM-PROBE", "CONFIRM-DATA");
    await capture("confirm"); key("\r");
    results.confirm = await confirm;
    pending = ctx.ui.input("INPUT-PROBE");
    await capture("input"); key("INPUT-VALUE"); key("\r");
    results.input = await pending;
    pending = ctx.ui.editor("EDITOR-PROBE", "PREFILL-VALUE");
    await capture("editor"); key("\r");
    results.editor = await pending;
    pending = ctx.ui.input("CANCEL-PROBE");
    await capture("cancel"); key("\x1b");
    results.cancel = await pending;
    ctx.ui.setEditorComponent((tui, theme, kb) => new class extends CustomEditor {
      override render(width: number): string[] { editorWidths.push(width); return super.render(width); }
    }(tui, theme, kb));
    ctx.ui.setEditorText("MESSAGE-DRAFT");
    await capture("messageEditor");
    ctx.ui.setWidget("probe", ["WIDGET-PROBE"]);
    let customHeight = 2;
    const inputs: string[] = [];
    const custom = ctx.ui.custom<string>((_tui, _theme, _kb, done) => {
      return {
        // Editor-like capabilities must not turn a dialog into the message editor.
        getText: () => "CUSTOM-DRAFT", setText: () => {},
        render: () => ["CUSTOM-PROBE", ...Array.from({ length: customHeight - 1 }, (_, i) => "CUSTOM-ROW-" + i)],
        invalidate() {},
        handleInput: (data: string) => { inputs.push(data); if (data === "\r") done("CUSTOM-VALUE"); },
        handleMouse: (event: TuiMouseEvent) => {
          events.push({ type: event.type, x: event.x, y: event.y, width: event.width });
          return { handled: true };
        },
        dispose: () => { disposed++; },
      };
    });
    await capture("custom");
    for (let n = 0; n < 5; n++) key("\x1b[<64;45;7M");
    await capture("scrolled");
    await click("CUSTOM-PROBE");
    await click("[↗]", "left"); await capture("chatZoom");
    await click("[↙]", "left");
    const width = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 55 });
    process.stdout.emit("resize"); await capture("narrow");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
    process.stdout.emit("resize"); await capture("restored");
    await click("[↗]", "right"); await capture("activityZoom");
    await click("[↙]", "right");
    await click("[▤]"); await capture("rows");
    await click("[▥]");
    customHeight = 40; await capture("oversized");
    customHeight = 2; await capture("afterOversized");
    key("\x06"); await capture("dialogShortcut");
    await click("[▣]"); await capture("combined");
    await click("[◫]"); await capture("afterCombined");
    const stackSupported = typeof (InteractiveMode.prototype as unknown as { pushExtensionDialog?: unknown }).pushExtensionDialog === "function";
    frames.stackSupported = stackSupported;
    if (stackSupported) {
      const nested = ctx.ui.confirm("NESTED-PROBE", "NESTED-DATA");
      await capture("nested");
      key("\r"); results.nested = await nested;
      await capture("afterNested");
      ctx.ui.setEditorComponent((tui, theme, kb) => new CustomEditor(tui, theme, kb));
      await capture("replacedDuringDialog");
    }
    key("\r"); results.custom = await custom;
    await capture("afterCustom");
    const overlay = ctx.ui.custom<string>((_tui, _theme, _kb, done) => ({
      render: () => ["OVERLAY-PROBE"], invalidate() {},
      handleInput: () => done("OVERLAY-VALUE"),
    }), { overlay: true, overlayOptions: { width: 30, anchor: "top-left" } });
    await capture("overlay"); key("\r"); results.overlay = await overlay;
    frames.editorText = ctx.ui.getEditorText();
    const foreign = new Text("FOREIGN-PROBE", 0, 0);
    (host as Host & { layoutRoot: { addChild(child: Text): void } }).layoutRoot.addChild(foreign);
    key("x"); // Stereo detaches from a root changed by another extension.
    const detached = ctx.ui.input("DETACHED-PROBE");
    await capture("detached");
    key("DETACHED-VALUE"); key("\r");
    results.detached = await detached;
    ctx.ui.setEditorText("");
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setWidget("probe", undefined);
    delete frames._;
    await writeFile(path.join(ctx.cwd, "dialog-frames.json"), JSON.stringify({ ...frames, results, events, inputs, editorWidths, disposed }));
  });
}
