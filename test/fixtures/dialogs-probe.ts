import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { CustomEditor, getAgentDir, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { emittedFrame } from "./emitted-frame.ts";
import { loadPreferences } from "../../src/preferences.ts";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

export default function dialogsProbe(pi: ExtensionAPI): void {
  let host: Host;
  let native: { showTreeSelector(): void };
  const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const restorers: Array<() => void> = [];
  for (const name of ["createExtensionUIContext", "rebuildChatFromMessages"]) {
    const original = prototype[name];
    prototype[name] = function (...args) {
      native = this as unknown as typeof native;
      restorers.forEach(restore => restore());
      return original.apply(this, args);
    };
    restorers.push(() => { prototype[name] = original; });
  }
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
      await emittedFrame(host, () => host.requestRender(true));
      const lines = host.getScreenLines();
      frames[key] = lines;
      return lines.map(stripTerminalSequences);
    };
    const key = (data: string) => host.handleTerminalInput(data);
    const click = async (label: string, side?: "left" | "right") => {
      const lines = await capture("_");
      const matches = lines.flatMap((line, y) => {
        const x = side === "right" ? line.lastIndexOf(label) : line.indexOf(label);
        return x < 0 ? [] : [{ x, y }];
      });
      const match = side === "right" ? matches.at(-1) : matches[0];
      if (!match) throw new Error("Missing control " + label + "\n" + lines.join("\n"));
      const { x, y } = match;
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
    await capture("widget");
    const arrangements: unknown[] = [];
    for (const layout of ["columns", "rows"]) {
      if (layout === "rows") await click("[ ▤ ]");
      for (const zoom of [null, "chat", "activity"]) {
        if (zoom) await click("[ ↗ ]", zoom === "chat" ? "left" : "right");
        const before = await capture("_");
        const preferencesFile = path.join(getAgentDir(), "transcript.json");
        let preferences = await loadPreferences(preferencesFile);
        // Toolbar persistence is asynchronous; wait for the requested arrangement before comparing.
        for (let attempt = 0; preferences.layout !== layout && attempt < 100; attempt++) {
          preferences = await loadPreferences(preferencesFile);
        }
        if (preferences.layout !== layout) throw new Error("Layout preference was not saved");
        const select = ctx.ui.select("RESTORE-PROBE", ["RESTORE-CHOICE"]);
        const during = await capture("_");
        await click("[ ↙ ]"); // Transient zoom must not change the user's prior zoom.
        key("\r");
        const selected = await select;
        const after = await capture("_");
        const cancel = ctx.ui.input("RESTORE-CANCEL");
        await capture("_"); key("\x1b"); await cancel;
        const afterCancel = await capture("_");
        const timeout = ctx.ui.select("RESTORE-TIMEOUT", ["CHOICE"], { timeout: 250 });
        const duringTimeout = await capture("_");
        await timeout;
        const afterTimeout = await capture("_");
        const controller = new AbortController();
        const abort = ctx.ui.input("RESTORE-ABORT", undefined, { signal: controller.signal });
        await capture("_"); controller.abort(); await abort;
        const afterAbort = await capture("_");
        arrangements.push({ layout, zoom, before, during, after, afterCancel, duringTimeout, afterTimeout, afterAbort, selected,
          preferences, savedPreferences: await loadPreferences(preferencesFile),
          draft: ctx.ui.getEditorText() });
        if (zoom) await click("[ ↙ ]");
      }
    }
    frames.arrangements = arrangements;
    await click("[ ▥ ]");
    native.showTreeSelector();
    await capture("tree"); key("\x1b"); await capture("afterTree");
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
    await click("[ ↙ ]"); await capture("disabledRestore");
    const width = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 55 });
    process.stdout.emit("resize"); await capture("narrow");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 20 });
    process.stdout.emit("resize"); await capture("tooNarrow");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
    process.stdout.emit("resize"); await capture("restored");
    await click("[ ▤ ]"); await capture("rows");
    await click("[ ▥ ]");
    customHeight = 40; await capture("oversized");
    customHeight = 2; await capture("afterOversized");
    key("\x06"); await capture("dialogShortcut");
    await click("[ ▣ ]"); await capture("combined");
    await click("[ ◫ ]"); await capture("afterCombined");
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
    const detached = ctx.ui.input("DETACHED-PROBE");
    await capture("beforeDetach");
    const foreign = new Text("FOREIGN-PROBE", 0, 0);
    (host as Host & { layoutRoot: { addChild(child: Text): void } }).layoutRoot.addChild(foreign);
    key("DETACHED-VALUE"); // Detach while the native dialog is still live.
    await capture("detached");
    key("\r");
    results.detached = await detached;
    ctx.ui.setEditorText("");
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setWidget("probe", undefined);
    delete frames._;
    await writeFile(path.join(ctx.cwd, "dialog-frames.json"), JSON.stringify({ ...frames, results, events, inputs, editorWidths, disposed }));
  });
}
