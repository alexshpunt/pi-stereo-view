import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, ScrollView, stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & {
  getScreenLines(): string[]; handleTerminalInput(data: string): void; layoutRoot?: Container;
  copyTextToClipboard(text: string): Promise<boolean>;
  getFocusedComponent(): Component | null;
  resetTextSelection(): void;
};

/** Exercise inline search through real keyboard and native mouse targets. */
export default function searchControls(pi: ExtensionAPI): void {
  let tui: Host;
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    await setImmediate();
    return tui.getScreenLines();
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const click = async (label: string, owner: string): Promise<void> => {
    const lines = (await capture()).map(stripTerminalSequences);
    const row = lines.findIndex(line => line.includes(owner) && line.includes(label));
    if (row < 0) throw new Error("Missing search control: " + owner + " " + label);
    const offset = lines[row].indexOf(label, lines[row].indexOf(owner));
    const x = visibleWidth(lines[row].slice(0, offset)) + 1;
    await input(`\x1b[<0;${x + 1};${row + 1}M`);
    await input(`\x1b[<0;${x + 1};${row + 1}m`);
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const frames: Record<string, string[]> = {};
    const file = path.join(ctx.cwd, "search-frames.json");
    const states: Record<string, { chatTop: number; activityTop: number; following: boolean }> = {};
    const snapshot = (name: string): void => {
      const views = new Map<string, ScrollView>();
      const walk = (component: Container): void => {
        if (component instanceof ScrollView) views.set(Reflect.get(component.children[0], "pane"), component);
        for (const child of component.children ?? []) if (child instanceof Container) walk(child);
      };
      if (tui.layoutRoot) walk(tui.layoutRoot);
      states[name] = { chatTop: views.get("chat")!.scrollTop, activityTop: views.get("activity")!.scrollTop,
        following: views.get("chat")!.isFollowingEnd };
    };
    ctx.ui.setEditorText("UNSENT SEARCH DRAFT");
    frames.initial = await capture();
    snapshot("initial");
    await input("\x06");
    frames.keyboard = await capture();
    await writeFile(file, JSON.stringify({ frames, draft: ctx.ui.getEditorText() }));
    // Preserve the expected red observation if the old popup is still installed.
    if (!frames.keyboard.some(line => stripTerminalSequences(line).includes("[↓]"))) {
      await input("\x1b");
      return;
    }
    for (const character of "dplyrntm") await input(character);
    frames.query = await capture();
    const queryLines = frames.query.map(stripTerminalSequences);
    let selectedRow = -1;
    queryLines.forEach((line, row) => { if (line.includes("deployment runtime ready")) selectedRow = row; });
    const highlighted = frames.query[selectedRow].includes(ctx.ui.theme.style("d", { fg: "searchMatchText", bg: "searchMatchBg" }));
    const copied: string[] = [];
    const copy = tui.copyTextToClipboard;
    tui.copyTextToClipboard = async value => { copied.push(value); return true; };
    try {
      const column = queryLines[selectedRow].indexOf("deployment runtime ready");
      const end = column + "deployment runtime ready".length - 1;
      for (const [button, x, suffix] of [[0, column, "M"], [32, end, "M"], [0, end, "m"]] as const) {
        await input(`\x1b[<${button};${x + 1};${selectedRow + 1}${suffix}`);
      }
      // Releasing a native selection copies it once; do not request a second copy.
      tui.resetTextSelection();
    } finally { tui.copyTextToClipboard = copy; }
    await input("\x06");
    frames.refocused = await capture();
    await input("\r");
    frames.older = await capture();
    await click("[↓]", "Search:");
    frames.next = await capture();
    await input("\x1b");
    frames.canceled = await capture();
    snapshot("canceled");
    await input("x");
    frames.editor = await capture();
    const editedDraft = ctx.ui.getEditorText();
    ctx.ui.setEditorText("UNSENT SEARCH DRAFT");
    await click("[ ⌕ ]", "Conversation");
    frames.header = await capture();
    await input("dplyrntm");
    frames.headerQuery = await capture();
    await click("[×]", "Search:");
    frames.closed = await capture();
    snapshot("closed");
    await input("\x06");
    await capture();
    const overlayInput = new Input({ prompt: "OTHER: " });
    let dismiss = (): void => {};
    const overlay = ctx.ui.custom<void>((_host, _theme, _keys, done) => {
      dismiss = done;
      return overlayInput;
    }, { overlay: true, overlayOptions: { width: 30, maxHeight: 1 } });
    await capture();
    await click("[×]", "Search:");
    await capture();
    const overlayKeptFocus = tui.getFocusedComponent() === overlayInput;
    await input("z");
    const overlayValue = overlayInput.getValue();
    dismiss();
    await overlay;
    await capture();
    await input("x");
    const focusAfterOverlayDraft = ctx.ui.getEditorText();
    ctx.ui.setEditorText("UNSENT SEARCH DRAFT");
    await writeFile(file, JSON.stringify({ frames, draft: ctx.ui.getEditorText(), editedDraft, highlighted, copied, states,
      overlayKeptFocus, overlayValue, focusAfterOverlayDraft }));
  });
}
