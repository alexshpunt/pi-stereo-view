import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
// @ts-expect-error The mod has no TypeScript declarations.
import { parseAnsi } from "../herdr/mods/stereo-view/ansi.js";
// @ts-expect-error The mod has no TypeScript declarations.
import { createSelection } from "../herdr/mods/stereo-view/selection.js";
// @ts-expect-error The mod has no TypeScript declarations.
import { dialogKey } from "../herdr/mods/stereo-view/dialog-keys.js";
// @ts-expect-error The mod has no TypeScript declarations.
import { composerAlive, composerFieldCommand, composerRoute } from "../herdr/mods/stereo-view/composer-route.js";
// @ts-expect-error The mod has no TypeScript declarations.
import { createBoundedImageStore, createImageCache, IMAGE_CACHE_INIT } from "../herdr/mods/stereo-view/image-pruner.js";
// @ts-expect-error The mod has no TypeScript declarations.
import { blockAround, buttonRow, columnsFit, footerControls, leadingMarker, MIN_COLUMN_CELLS, padsToEnd } from "../herdr/mods/stereo-view/history-blocks.js";
// @ts-expect-error The mod has no TypeScript declarations.
import { dropStaleRows, pageUsable, paneDimensions, refreshPlan, rowHasText, SETTLE_MS, TICK_MS, UNUSABLE_LIMIT } from "../herdr/mods/stereo-view/refresh-plan.js";

// GPUI and Herdr are native modules available inside the app, not in Node.
function harness(stored?: string) {
  let saved: string | null = stored ?? null;
  const calls: any[] = [];
  const runs: string[] = [];
  let total = 1;
  let jump: { serial: number; top: number } | undefined;
  let rows: string[] | undefined;
  let zoom = 1;
  let terminalFont: string | undefined = "Test Mono";
  let terminalSize: number | undefined;
  let surface: { active: boolean; frame: number; mouseFrame?: number; piWindow?: boolean; lines: string[] } = { active: false, frame: 1, mouseFrame: 1, lines: [] };
  let overlays: any[] = [];
  let pointerHandled = true;
  let stopped = 0;
  let focusCount = 0;
  let paneView = false;
  let shownView = "gui";
  let paneFocused = true;
  const pending: Promise<unknown>[] = [];
  let listening = false;
  let deliverCommand: ((command: string) => void) | undefined;
  const nextCommand = () => { listening = true; return new Promise<string>(resolve => { deliverCommand = resolve; }); };
  class Element {
    name?: string;
    nodes: Element[] = [];
    click?: (...args: any[]) => void;
    mouseDown?: (...args: any[]) => void;
    mouseUp?: (...args: any[]) => void;
    mouseMove?: (...args: any[]) => void;
    wheel?: (...args: any[]) => void;
    mouseDownByButton: Record<string, (...args: any[]) => void> = {};
    windowUpByButton: Record<string, (...args: any[]) => void> = {};
    windowMove?: (...args: any[]) => void;
    windowUp?: (...args: any[]) => void;
    keyDown?: (...args: any[]) => void;
    scrollHandle?: { y: number };
    scrollable = false;
    /** The last arguments of every style or layout call, by method name. */
    styles: Record<string, any[]> = {};
    constructor(readonly kind: string) {
      return new Proxy(this, { get(target, prop, receiver) {
        if (prop in target) return (target as any)[prop];
        return (...args: any[]) => {
          if (prop !== "child" && prop !== "children") target.styles[String(prop)] = args;
          if (prop === "id") target.name = args[0];
          if (prop === "child" && args[0] instanceof Element) target.nodes.push(args[0]);
          if (prop === "children") target.nodes.push(...args[0]);
          if (prop === "on_click") target.click = args[0];
          if (prop === "on_mouse_down") { target.mouseDownByButton[args[0]] = args[1]; if (args[0] === "left") target.mouseDown = args[1]; }
          if (prop === "on_mouse_move") target.mouseMove = args[0];
          if (prop === "on_scroll_wheel") target.wheel = args[0];
          if (prop === "on_mouse_up") target.mouseUp = args[1];
          if (prop === "on_window_mouse_move") target.windowMove = args[0];
          if (prop === "on_window_mouse_up") { target.windowUpByButton[args[0]] = args[1]; if (args[0] === "left") target.windowUp = args[1]; }
          if (prop === "on_key_down") target.keyDown = args[0];
          if (prop === "overflow_y_scrollbar") target.scrollable = true;
          if (prop === "track_scroll") target.scrollHandle = args[0];
          return receiver;
        };
      } });
    }
  }
  const el = (kind: string) => () => new Element(kind);
  const handlers: Record<string, (event: any, cx: any) => void> = {};
  let inputValue = "";
  let inputFocused = false;
  const input = {
    value: () => inputValue,
    set_value(value: string) { inputValue = value; handlers.change?.({}, cx); },
    on(name: string, callback: (event: any, cx: any) => void) { handlers[name] = callback; },
    focus() { inputFocused = true; }, blur() { inputFocused = false; }, release() {},
  };
  const ui = { View: class {}, div: el("div"), image: el("image"), svg: el("svg"), h_flex: el("horizontal"), v_flex: el("vertical"),
    v_virtual_list: el("list"), VirtualListScrollHandle: { new: () => ({ offset: () => ({ y: 0 }), viewport_size: () => ({ height: 300 }), content_size: () => ({ height: 0 }), scroll_to_bottom() {}, scroll_to_item() {} }) },
    ScrollHandle: { new: () => ({ y: 0, offset() { return { y: this.y }; }, viewport_size: () => ({ height: 34 }), scroll_to_item(index: number) { this.y = index * 17; }, release() {} }) },
    Scrollbar: { vertical: el("scrollbar") }, Input: { new: () => new Element("input") }, InputState: { new: () => input } };
  const opened: string[] = [];
  const copied: string[] = [];
  const cx = { notify() {}, stop_propagation() { stopped++; }, focus_handle: () => ({ focus() { focusCount++; }, is_focused: () => true, release() {} }),
    write_to_clipboard(text: string) { copied.push(text); },
    open_url(url: string) { opened.push(url); }, timer: { every() {}, after(_delay: number, callback: (cx: any) => void) { callback(cx); } }, spawn(fn: (cx: any) => Promise<unknown>) { listening = false; const promise = fn(cx); if (!listening) pending.push(promise); } };
  const terminal = { address: "m/t", state: "live", pid: 1, labels: { "herdr.stereo.bridge": JSON.stringify({ v: 1, pid: 1, socket: "/tmp/stereo-ABC123/s" }) } };
  const state = { v: 1, layout: "columns", side: "left", mode: "split", zoom: null, showToolbar: true, showHeaders: true, compactTools: true };
  Object.assign(state, { preferences: { compactTools: true } });
  const createSettingsPanel = (_preferences: unknown, update: (key: string, value: unknown, cx: unknown) => void, close: (cx: unknown) => void) => ({
    render: () => {
      const panel: any = new Element("settings"), setting: any = new Element("button"), done: any = new Element("button");
      return panel.id("stereo-settings")
        .child(setting.id("setting-test").on_click((_event: unknown, cx: unknown) => update("compactTools", false, cx)))
        .child(done.id("setting-close").on_click((_event: unknown, cx: unknown) => close(cx)));
    },
  });
  const createSearchBar = (_pane: string, actions: any) => ({
    render: () => {
      const panel: any = new Element("search"), button: any = new Element("button");
      return panel.id("search-bar").child(button.id("search-query").on_click((_event: unknown, next: unknown) => actions.query("hello", next)));
    },
    focus() {}, dispose() {},
  });
  const env = { checking: () => false, exec: async (_cmd: string, args: string[]) => {
    const request = JSON.parse(args[3]); calls.push(request);
    const data: any = request.op === "overlays" ? { v: 1, revision: 1, columns: 80, rows: 24, overlays } : request.op === "overlay-key" || request.op === "overlay-mouse" || request.op === "overlay-paste" || request.op === "surface-paste" ? { v: 1, ok: true } : request.op === "surface" ? { v: 1, mouseFrame: 1, piWindow: false, ...surface } : request.op === "surface-key" || request.op === "surface-mouse" ? { v: 1, ok: true } : request.op === "state" ? state : request.op === "search" ? { v: 1, open: true, count: 1, current: 1, pending: false, top: 0 } : request.op === "action" || request.op === "setting" || request.op === "mouse" ? { v: 1, ok: true } :
      { v: 1, frame: 1, total, top: request.following ? Math.max(0, total - request.height) : request.top, width: request.width, height: request.height, scrollShift: 0,
        images: [], jump: request.pane === "activity" ? jump : undefined, lines: request.top === 0 ? ["native rendered row"] : [],
        selection: request.top === 0 ? [{ cells: Array.from("native rendered row", (text, start) => ({ text, start, end: start + 1 })), words: [{ start: 0, end: 6 }] }] : [] };
    if ((request.op === "overlay-mouse" || request.op === "surface-mouse") && request.event.type === "wheel") data.ok = pointerHandled;
    if (request.op === "view" && rows) {
      const page = rows.slice(data.top, data.top + data.height);
      Object.assign(data, { lines: page, selection: page.map(line => ({
        cells: Array.from(line, (text, start) => ({ text, start, end: start + 1 })), words: [],
      })) });
    }
    return { code: 0, stdout: JSON.stringify(data) };
  }, panes: () => [{ pane: "m/p", tab: "tab", terminal: "m/t", view: shownView, focused: paneFocused }], props: () => paneView ? ({ pane: "m/p", terminal: "m/t", view: "gui" }) : ({ pane: "m/p", origin: "m/t" }), run(command: string) { runs.push(command); }, settings: () => ({ zoom, font: terminalFont, font_size: terminalSize }), spaces: () => [{ active: true, tabs: [{ id: "tab", active: true }] }], terminals: () => [terminal], theme: () => ({}), window: () => ({ visible: true }), parseAnsi, lineRange: () => ({ first: 0, last: 0 }) };
  const source = readFileSync(new URL("../herdr/mods/stereo-view/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class StereoView", "return class StereoView");
  const names = { ...ui, ...env, nextCommand, composerRoute, composerAlive, composerFieldCommand, dropStaleRows, pageUsable, paneDimensions, refreshPlan, rowHasText, SETTLE_MS, TICK_MS, UNUSABLE_LIMIT, blockAround, buttonRow, columnsFit, footerControls, leadingMarker, MIN_COLUMN_CELLS, padsToEnd, createSettingsPanel, createSearchBar, createSelection, dialogKey, createBoundedImageStore, createImageCache, IMAGE_CACHE_INIT,
    appHome: () => "/tmp", writeFile: async () => {}, unlink: async () => {},
    localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } } };
  const StereoView = new Function(...Object.keys(names), source)(...Object.values(names));
  const view = new StereoView();
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const find = (node: Element, id: string): Element | undefined => node.name === id ? node : node.nodes.flatMap(child => find(child, id) ?? [])[0];
  return { view, cx, calls, state, flush, find, opened, copied, saved: () => saved, setTotal(value: number) { total = value; },
    setJump(value: { serial: number; top: number }) { jump = value; },
    setRows(value: string[]) { rows = value; total = value.length; }, setZoom(value: number) { zoom = value; }, setFont(value: string | undefined) { terminalFont = value; }, setFontSize(value: number | undefined) { terminalSize = value; },
    setSurface(value: typeof surface) { surface = value; }, setOverlays(value: any[]) { overlays = value; },
    typeSurface(value: string) { inputValue = value; handlers.change?.({}, cx); },
    setPointerHandled(value: boolean) { pointerHandled = value; }, stopped: () => stopped,
    surfaceFocused: () => inputFocused, sendCommand: (command: string) => deliverCommand?.(command),
    runs, setComposerLabel(stamp?: number) { (terminal.labels as any)["herdr.composer"] = stamp === undefined ? undefined : String(stamp); },
    setPaneView(value: boolean) { paneView = value; }, setShownView(value: string) { shownView = value; }, setPaneFocused(value: boolean) { paneFocused = value; }, focused: () => focusCount };
}

test("pane view drops app chrome, starts with a live bridge and pauses in TUI", async () => {
  const h = harness(); h.setPaneView(true); h.view.init({}, h.cx);
  expect(h.view.available).toBe(true);
  await h.flush();
  expect(h.find(h.view.render(), "stereo-terminal")).toBeUndefined();
  const before = h.calls.length;
  h.setShownView("tui"); h.view.refresh(h.cx); await h.flush();
  expect(h.calls.length).toBe(before);
  h.setShownView("gui"); h.view.refresh(h.cx); await h.flush();
  expect(h.calls.length).toBeGreaterThan(before);
});

test("a pane created in TUI mode recognizes a live bridge and reads ahead, so its first GUI frame has content (LPT-1932)", async () => {
  const h = harness(); h.setPaneView(true); h.setShownView("tui");
  h.view.init({}, h.cx);
  expect(h.view.available).toBe(true);
  await h.flush();
  expect(h.calls.some(call => call.op === "state")).toBe(true);
  expect(h.calls.some(call => call.op === "view" && call.pane === "chat")).toBe(true);
  expect(h.view.viewState).not.toBeNull();
  expect(h.view.chat.total).toBe(1);
  // A hidden copy never takes the keyboard, and it reads again only after the slow interval.
  expect(h.view.surfaceInput).toBeNull();
  const reads = h.calls.length;
  h.view.tick(h.cx); await h.flush();
  expect(h.calls.length).toBe(reads);
});

test("a new copy draws only its background until the first state arrives, not the default layout (LPT-1932)", async () => {
  const h = harness(); h.setPaneView(true);
  h.view.init({}, h.cx);
  expect(h.view.loading()).toBe(true);
  expect(h.find(h.view.render(), "stereo-panels")).toBeUndefined();
  expect(h.find(h.view.render(), "stereo-body")).toBeDefined();
  await h.flush();
  expect(h.view.loading()).toBe(false);
  expect(h.find(h.view.render(), "stereo-panels")).toBeDefined();
});

test("a copy that remembers the last structure draws toolbar and panels at once and fills the rows in place (LPT-1932)", async () => {
  const stored = JSON.stringify({ state: { v: 1, layout: "columns", side: "left", mode: "split", zoom: null, showToolbar: true, showHeaders: true, compactTools: true }, geometry: null });
  const h = harness(stored); h.setPaneView(true); h.setRows(["one", "two"]);
  h.view.init({}, h.cx);
  expect(h.view.loading()).toBe(false);
  const lists = (node: any): any[] => [...(node.kind === "list" ? [node] : []), ...node.nodes.flatMap(lists)];
  const first = h.view.render();
  expect(h.find(first, "stereo-panels")).toBeDefined();
  expect(h.find(first, "stereo-action-mode")).toBeDefined();
  // The rows wait for their first page; the structure around them is already final.
  expect(lists(first).length).toBe(2);
  expect(lists(first).every(list => list.styles.opacity?.[0] === 0)).toBe(true);
  await h.flush();
  const later = h.view.render();
  expect(h.find(later, "stereo-panels")).toBeDefined();
  expect(lists(later).every(list => list.styles.opacity === undefined)).toBe(true);
});

test("a copy remembers what the bridge reported for the next one, and ignores a stored value that is not a state (LPT-1932)", async () => {
  const h = harness(); h.setPaneView(true);
  h.view.init({}, h.cx); await h.flush();
  const kept = JSON.parse(h.saved() as string);
  expect(kept.state.layout).toBe("columns");
  const broken = harness("{\"state\":{\"v\":2}}"); broken.setPaneView(true);
  broken.view.init({}, broken.cx);
  expect(broken.view.viewState).toBeNull();
  expect(broken.view.loading()).toBe(true);
});

test("a width change keeps the rows on screen, reads them again at once and then drops the old ones (LPT-1932)", async () => {
  const h = harness(); h.setRows(Array.from({ length: 5 }, (_, i) => `row ${i}`));
  h.view.init({}, h.cx); await h.flush();
  const pane = h.view.chat;
  expect(pane.items.size).toBe(5);
  const before = h.calls.length;
  h.view.sizePane(pane, { width: 900, height: 300 }, h.cx);
  expect(pane.stale).toBe(true);
  expect(pane.items.size).toBe(5);
  await h.flush();
  const reads = h.calls.slice(before).filter(call => call.op === "view" && call.pane === "chat");
  expect(reads.length).toBeGreaterThan(0);
  expect(reads[0].width).toBe(pane.width);
  expect(pane.stale).toBe(false);
  expect(pane.items.size).toBe(5);
});

test("pane focus targets the active panel or the open Pi dialog", async () => {
  const h = harness(); h.setPaneView(true); h.view.init({}, h.cx); await h.flush();
  const claimed = h.focused();
  h.sendCommand("focus"); await Promise.resolve(); await h.flush();
  expect(h.focused()).toBe(claimed + 1);
  h.setSurface({ active: true, frame: 2, lines: ["dialog"] });
  h.view.refresh(h.cx); await h.flush();
  h.sendCommand("focus"); await Promise.resolve();
  expect(h.surfaceFocused()).toBe(true);
});

test("a GUI focus goes on to the composer field of its pane unless a Pi dialog is open", async () => {
  const h = harness(); h.setPaneView(true); h.view.init({}, h.cx); await h.flush();
  h.sendCommand("focus"); await Promise.resolve(); await h.flush();
  expect(h.runs, "no composer is alive").toEqual([]);

  h.setComposerLabel(Date.now() - 60000);
  h.sendCommand("focus"); await Promise.resolve(); await h.flush();
  expect(h.runs, "a stale composer label").toEqual([]);

  h.setComposerLabel(Date.now());
  h.sendCommand("focus"); await Promise.resolve(); await h.flush();
  expect(h.runs).toEqual(["paste-composer.field:m%2Fp:focus"]);

  h.setSurface({ active: true, frame: 2, lines: ["dialog"] });
  h.view.refresh(h.cx); await h.flush();
  h.sendCommand("focus"); await Promise.resolve();
  expect(h.surfaceFocused()).toBe(true);
  expect(h.runs, "the dialog keeps the keyboard").toHaveLength(1);
});
// LPT-1930: Herdr sends "focus" only when a pane takes the keyboard. A pane that was focused already when its
// GUI first appeared (a new pane whose Pi starts after the pane was made) got no such command, so the keyboard
// stayed on the hidden terminal and typed text was lost.
test("a pane that is focused when its GUI appears hands the keyboard to the composer without a focus command", async () => {
  const h = harness(); h.setPaneView(true); h.setShownView("tui"); h.view.init({}, h.cx); await h.flush();
  h.setComposerLabel(Date.now());
  h.view.refresh(h.cx); await h.flush();
  expect(h.runs, "still in TUI").toEqual([]);

  h.setShownView("gui"); h.view.refresh(h.cx); await h.flush();
  expect(h.runs).toEqual(["paste-composer.field:m%2Fp:focus"]);
  expect(h.focused(), "the view takes the keyboard first").toBe(1);

  h.view.refresh(h.cx); await h.flush();
  h.view.refresh(h.cx); await h.flush();
  h.view.refresh(h.cx); await h.flush();
  expect(h.runs.length, "a few retries, not a stream").toBeLessThanOrEqual(3);
});

test("a GUI that appears before its composer is alive hands the keyboard over when the composer comes", async () => {
  const h = harness(); h.setPaneView(true); h.setShownView("tui"); h.view.init({}, h.cx); await h.flush();
  h.setShownView("gui"); h.view.refresh(h.cx); await h.flush();
  expect(h.runs, "no composer yet").toEqual([]);
  h.setComposerLabel(Date.now());
  h.view.refresh(h.cx); await h.flush();
  expect(h.runs).toEqual(["paste-composer.field:m%2Fp:focus"]);
});

test("a GUI that appears in a pane without the keyboard leaves the keyboard where it is", async () => {
  const h = harness(); h.setPaneView(true); h.setShownView("tui"); h.view.init({}, h.cx); await h.flush();
  h.setComposerLabel(Date.now()); h.setPaneFocused(false);
  h.setShownView("gui"); h.view.refresh(h.cx); await h.flush();
  h.view.refresh(h.cx); await h.flush();
  expect(h.runs).toEqual([]);
  expect(h.focused()).toBe(0);
});

test("a GUI that appears with a Pi dialog open leaves the keyboard with the dialog", async () => {
  const h = harness(); h.setPaneView(true); h.setShownView("tui"); h.view.init({}, h.cx); await h.flush();
  h.setComposerLabel(Date.now());
  h.setSurface({ active: true, frame: 2, lines: ["dialog"] });
  h.setShownView("gui"); h.view.refresh(h.cx); await h.flush();
  h.view.refresh(h.cx); await h.flush();
  expect(h.surfaceFocused()).toBe(true);
  // The composer itself declines the handover while Pi's editor does not have the keyboard (a dialog is open).
});

test("keeps split history visible while an extension dialog is open", async () => {
  const h = harness(); h.setSurface({ active: true, frame: 8, mouseFrame: 12, lines: ["dialog"] });
  h.view.init({}, h.cx); await h.flush();
  const root = h.view.render();
  expect(h.find(root, "stereo-chat-box")).toBeDefined();
  expect(h.find(root, "stereo-activity-box")).toBeDefined();
  expect(h.find(root, "stereo-surface")).toBeDefined();
});

test("keeps both history panels usable when a saved chat width exceeds the window", async () => {
  const h = harness(); h.view.init({}, h.cx); await h.flush();
  h.view.viewState.preferences.chatWidth = 75;
  h.view.areaWidth = 536;
  h.view.cellWidth = 5; // Narrow cells, so that two columns still fit at this width.
  expect(h.view.layout()).toBe("columns");
  expect(h.view.areaWidth - h.view.chatExtent()).toBeGreaterThanOrEqual(200);
});

test("fits pane controls independently of the window toolbar", async () => {
  const h = harness(); h.view.init({}, h.cx); await h.flush();
  h.view.areaWidth = 536; h.view.controlWidth = 536;
  h.view.cellWidth = 5;
  h.view.viewState.preferences.chatWidth = 75;
  const root = h.view.render();
  expect(h.find(root, "stereo-icon-compact")).toBeDefined();
  expect(h.find(root, "stereo-icon-zoom-activity")).toBeDefined();
});

test("uses picker placement temporarily and restores the saved history layout", async () => {
  const h = harness(); h.setSurface({ active: true, piWindow: true, frame: 8, mouseFrame: 12, lines: ["picker"] });
  h.view.init({}, h.cx); await h.flush();
  for (const [placement, visible, hidden] of [
    ["combined", "stereo-combined-box", "stereo-chat-box"],
    ["maximize", "stereo-activity-box", "stereo-chat-box"],
    ["inline", "stereo-chat-box", "stereo-combined-box"],
  ]) {
    h.view.viewState.preferences.piWindows = placement;
    const root = h.view.render();
    expect(h.find(root, visible)).toBeDefined();
    expect(h.find(root, hidden)).toBeUndefined();
    expect(h.find(root, "stereo-surface")).toBeDefined();
    expect(h.view.viewState.mode).toBe("split");
  }
  h.view.viewState.preferences.piWindows = "combined";
  h.view.viewState.layout = "rows";
  expect(h.find(h.view.render(), "stereo-chat-box")).toBeDefined();
  h.view.viewState.layout = "columns";
  h.view.viewState.zoom = "chat";
  const zoomed = h.view.render();
  expect(h.find(zoomed, "stereo-chat-box")).toBeDefined();
  expect(h.find(zoomed, "stereo-surface")).toBeDefined();
  h.view.viewState.zoom = null;
  h.view.surface = { ...h.view.surface, active: false };
  const restored = h.view.render();
  expect(h.find(restored, "stereo-chat-box")).toBeDefined();
  expect(h.find(restored, "stereo-activity-box")).toBeDefined();
  expect(h.find(restored, "stereo-surface")).toBeUndefined();
});

test("forwards dialog pointer movement, wheel and right-button gestures", async () => {
  const h = harness(); h.setSurface({ active: true, frame: 8, mouseFrame: 12, lines: ["first", "second"] });
  h.view.init({}, h.cx); await h.flush();
  const dialog = h.find(h.view.render(), "stereo-surface")!;
  const point = { local_position: { x: 20, y: 5 }, modifiers: { shift: true, control: false, alt: false } };
  dialog.mouseMove!(point, h.cx);
  h.find(dialog, "stereo-surface-row-0")!.wheel!({ ...point, local_position: { x: 12, y: 1 }, delta_lines: { x: 0, y: 2 }, delta: { x: 0, y: 38 } }, h.cx);
  dialog.mouseDownByButton.right({ ...point, button: "right" }, h.cx);
  dialog.windowUpByButton.right({ ...point, button: "right" }, h.cx);
  await h.flush();
  const events = h.calls.filter(call => call.op === "surface-mouse").map(call => call.event);
  expect(events).toEqual([
    { type: "move", button: "none", x: 1, y: 0, shift: true },
    { type: "wheel", button: "none", x: 1, y: 0, shift: true, wheelDelta: -2 },
    { type: "press", button: "right", x: 1, y: 0, shift: true },
    { type: "release", button: "right", x: 1, y: 0, shift: true },
  ]);
});
test("scrolls a clipped dialog only when its component did not handle the wheel", async () => {
  const h = harness(); h.setSurface({ active: true, frame: 8, mouseFrame: 12, lines: Array(20).fill("row") });
  h.view.init({}, h.cx); await h.flush();
  const dialog = h.find(h.view.render(), "stereo-surface")!;
  const row = h.find(dialog, "stereo-surface-row-0")!;
  const event = { local_position: { x: 12, y: 1 }, delta_lines: { x: 0, y: -1 } };
  row.wheel!(event, h.cx); await h.flush();
  expect(h.stopped()).toBe(1);
  expect(h.view.surfaceScroll.y).toBe(0);
  h.setPointerHandled(false);
  row.wheel!(event, h.cx); await h.flush();
  expect(h.stopped()).toBe(2);
  expect(h.view.surfaceScroll.y).toBeGreaterThan(0);
});
test("keeps a visible image while evicting an older offscreen image", async () => {
  const h = harness(); h.view.init({}, h.cx); await h.flush();
  h.view.chat.images = [{ id: "visible", row: 0, rows: 1 }];
  const store = h.view.imagePaths;
  await store.load("old", async () => ({ path: "old", size: 80 * 1024 * 1024 }));
  await store.load("visible", async () => ({ path: "visible", size: 80 * 1024 * 1024 }));
  expect(store.get("old")).toBeUndefined();
  expect(store.get("visible")).toBe("visible");
});

test("pins images in both views at their measured fractional-scale scroll positions", async () => {
  const h = harness(); h.setZoom(1.1); h.view.init({}, h.cx); await h.flush();
  const second = new h.view.constructor(); second.init({}, h.cx); await h.flush();
  const state = h.view.chat;
  state.total = 194;
  state.handle.content_size = () => ({ height: 3292.13 });
  state.handle.offset = () => ({ y: 2104.85 });
  state.handle.viewport_size = () => ({ height: 34 });
  state.images = [{ id: "fractional", row: 124, rows: 1 }];
  second.chat.images = [{ id: "second", row: 0, rows: 1 }];
  const store = h.view.imagePaths;
  await store.load("fractional", async () => ({ path: "fractional", size: 80 * 1024 * 1024 }));
  await store.load("second", async () => ({ path: "second", size: 80 * 1024 * 1024 }));
  expect(store.get("fractional")).toBe("fractional");
  expect(store.get("second")).toBe("second");
  state.handle.offset = () => ({ y: 0 });
  await store.prune();
  expect(store.get("fractional")).toBeUndefined();
  expect(store.get("second")).toBe("second");
});

test("keeps history visible behind Pi overlays and forwards overlay input", async () => {
  const h = harness();
  h.setOverlays([{ id: 7, frame: 4, mouseFrame: 5, focused: true, row: 3, col: 4, width: 20, height: 2, lines: ["overlay"] }]);
  h.view.init({}, h.cx);
  await h.flush();
  const root = h.view.render();
  expect(h.find(root, "stereo-chat-box")).toBeDefined();
  const layer = h.find(root, "stereo-overlay-7");
  expect(layer).toBeDefined();
  h.typeSurface("x");
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "overlay-key", revision: 1, id: 7, frame: 4, data: "x" });
  layer!.mouseDown!({ local_position: { x: 13, y: 1 } }, h.cx);
  layer!.windowUp!({ local_position: { x: 13, y: 1 } }, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "overlay-mouse", revision: 1, id: 7, frame: 5,
    event: { type: "press", button: "left", x: 1, y: 0 } });
  expect(h.calls).toContainEqual({ v: 1, op: "overlay-mouse", revision: 1, id: 7, frame: 5,
    event: { type: "release", button: "left", x: 1, y: 0 } });
});

test("does not copy stale selection coordinates after history reflows", () => {
  const h = harness();
  h.view.init({}, h.cx);
  const pane = h.view.chat;
  const cells = Array.from("abcdef", (text, start) => ({ text, start, end: start + 1 }));
  pane.selectionRows.set(0, { cells, words: [] });
  pane.selection.start({ row: 0, col: 1 }, "character");
  pane.selection.extend({ row: 0, col: 3 });
  expect(pane.selection.text()).toBe("bcd");
  h.view.sizePane(pane, { width: 900, height: 300 }, h.cx);
  expect(pane.selection.bounds()).toBeUndefined();
  expect(pane.selectionRows.size).toBe(0);
});

test("scrolls a tall overlay and routes clicks to the scrolled row", async () => {
  const h = harness();
  h.setOverlays([{ id: 7, frame: 4, mouseFrame: 5, focused: true, row: 0, col: 0, width: 20, height: 60, lines: Array.from({ length: 60 }, (_, i) => `row ${i}`) }]);
  h.view.init({}, h.cx);
  await h.flush();
  const layer = h.find(h.view.render(), "stereo-overlay-7")!;
  expect(layer.scrollable).toBe(true);
  expect(layer.scrollHandle).toBeDefined();
  layer.scrollHandle!.y = 17 * 30;
  layer.mouseDown!({ local_position: { x: 13, y: 18 } }, h.cx);
  layer.windowUp!({ local_position: { x: 13, y: 18 } }, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "overlay-mouse", revision: 1, id: 7, frame: 5,
    event: { type: "press", button: "left", x: 1, y: 31 } });
  expect(h.calls).toContainEqual({ v: 1, op: "overlay-mouse", revision: 1, id: 7, frame: 5,
    event: { type: "release", button: "left", x: 1, y: 31 } });
});

test("sends a long paste as one ordered overlay transaction", async () => {
  const h = harness();
  h.setOverlays([{ id: 7, frame: 4, mouseFrame: 5, focused: true, row: 3, col: 4, width: 20, height: 2, lines: ["overlay"] }]);
  h.view.init({}, h.cx);
  await h.flush();
  const paste = "a".repeat(600) + "🙂";
  h.typeSurface(paste);
  await h.flush();
  const chunks = h.calls.filter(call => call.op === "overlay-paste");
  expect(chunks.map(chunk => chunk.data).join("")).toBe(paste);
  expect(chunks.map(chunk => chunk.index)).toEqual([0, 1, 2]);
  expect(new Set(chunks.map(chunk => chunk.transaction)).size).toBe(1);
  expect(chunks.every(chunk => chunk.count === 3 && chunk.id === 7 && chunk.frame === 4 && chunk.revision === 1)).toBe(true);
  expect(h.calls.some(call => call.op === "overlay-key" && call.data.includes("\x1b[200~"))).toBe(false);
});

test("forwards Enter to a focused Pi overlay even with an empty input", async () => {
  const h = harness();
  h.setOverlays([{ id: 7, frame: 4, mouseFrame: 5, focused: true, row: 3, col: 4, width: 20, height: 2, lines: ["overlay"] }]);
  h.view.init({}, h.cx);
  await h.flush();
  h.view.render().keyDown!({ key: "enter", modifiers: {} }, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "overlay-key", revision: 1, id: 7, frame: 4, data: "\r" });
});

test("preserves Enter modifiers when forwarding an overlay key", async () => {
  const h = harness();
  h.setOverlays([{ id: 7, frame: 4, mouseFrame: 5, focused: true, row: 3, col: 4, width: 20, height: 2, lines: ["overlay"] }]);
  h.view.init({}, h.cx); await h.flush();
  h.view.render().keyDown!({ key: "enter", modifiers: { shift: true } }, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "overlay-key", revision: 1, id: 7, frame: 4, data: "\x1b[13;2u" });
});

test("uses icon controls when the saved preference requests icons", async () => {
  const h = harness();
  (h.state as any).preferences.buttonStyle = "icons";
  h.view.init({}, h.cx);
  await h.flush();
  expect(h.find(h.view.render(), "stereo-icon-mode")).toBeDefined();
  (h.state as any).preferences.buttonStyle = "text";
  h.view.refresh(h.cx);
  await h.flush();
  expect(h.find(h.view.render(), "stereo-icon-mode")).toBeUndefined();
});

test("keeps the toolbar usable in a narrow pane", async () => {
  const h = harness();
  (h.state as any).preferences.buttonStyle = "text";
  h.view.init({}, h.cx);
  await h.flush();
  h.view.controlWidth = 250;
  expect(h.find(h.view.render(), "stereo-icon-mode")).toBeDefined();
});

test("loads the live layout and sends toolbar actions to the same bridge", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "state" });
  expect(h.calls).toContainEqual({ v: 1, op: "view", pane: "chat", top: 0, height: 57, width: 80, following: true });
  expect(h.view.chat.items.get(0)?.lines).toEqual(["native rendered row"]);
  const button = h.find(h.view.render(), "stereo-action-swap");
  expect(button?.click).toBeTypeOf("function");
  button!.click!({}, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "action", action: "swap" });
  expect(h.calls.filter(call => call.op === "state").length).toBeGreaterThan(1);
});
test("reflects pane order, zoom and header visibility from the live state", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.state.layout = "rows";
  h.state.side = "right";
  h.state.showHeaders = false;
  h.view.refresh(h.cx);
  await h.flush();
  const root = h.view.render();
  expect(h.find(root, "stereo-activity-box")).toBeDefined();
  expect(h.find(root, "stereo-chat-box")).toBeDefined();
  expect(h.find(root, "stereo-action-zoom-chat")).toBeUndefined();
  const body = root.nodes.find((node: any) => h.find(node, "stereo-activity-box"));
  expect(body.kind).toBe("vertical");
  expect(h.find(body.nodes[0], "stereo-activity-box")).toBeDefined();

  h.state.zoom = "activity" as any;
  h.view.refresh(h.cx);
  await h.flush();
  const zoomed = h.view.render();
  expect(h.find(zoomed, "stereo-activity-box")).toBeDefined();
  expect(h.find(zoomed, "stereo-chat-box")).toBeUndefined();
});

test("sends pane actions in click order", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  const root = h.view.render();
  for (const action of ["layout", "compact", "zoom-activity", "headers", "mode"]) {
    h.find(root, `stereo-action-${action}`)!.click!({}, h.cx);
  }
  await h.flush();
  expect(h.calls.filter(call => call.op === "action").map(call => call.action))
    .toEqual(["layout", "compact", "zoom-activity", "headers", "mode"]);
});

test("shows Pi's active dialog and forwards keys until it closes", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.setSurface({ active: true, frame: 8, lines: ["question", "choice"] });
  h.view.refresh(h.cx);
  await h.flush();
  const root = h.view.render();
  expect(h.find(root, "stereo-surface")).toBeDefined();
  root.keyDown!({ key: "down", modifiers: {} }, h.cx);
  root.keyDown!({ key: "enter", modifiers: {} }, h.cx);
  await h.flush();
  expect(h.calls.filter(call => call.op === "surface-key")).toEqual([
    { v: 1, op: "surface-key", frame: 8, data: "\x1b[B" },
    { v: 1, op: "surface-key", frame: 8, data: "\r" },
  ]);
  h.setSurface({ active: false, frame: 9, lines: [] });
  h.view.refresh(h.cx);
  await h.flush();
  expect(h.find(h.view.render(), "stereo-chat-box")).toBeDefined();
});

test("uses native text input to send typed and pasted dialog text once", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.setSurface({ active: true, frame: 5, lines: ["question"] });
  h.view.refresh(h.cx);
  await h.flush();
  expect(h.surfaceFocused()).toBe(true);
  h.typeSurface("é");
  h.typeSurface("pasted text");
  await h.flush();
  expect(h.calls.filter(call => call.op === "surface-key").map(call => call.data)).toEqual(["é"]);
  expect(h.calls.filter(call => call.op === "surface-paste").map(call => call.data)).toEqual(["pasted text"]);
  h.setSurface({ active: false, frame: 6, lines: [] });
  h.view.refresh(h.cx);
  await h.flush();
  expect(h.surfaceFocused()).toBe(false);
});

test("does not forward an escape-bearing paste as terminal commands", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.setSurface({ active: true, frame: 5, lines: ["question"] });
  h.view.refresh(h.cx);
  await h.flush();
  h.typeSurface("hello\x1b[201~\r");
  await h.flush();
  expect(h.calls.filter(call => call.op === "surface-key")).toEqual([]);
  expect(h.view.controlError).toBeTruthy();
});

test("sends dialog pointer gestures using the painted frame", async () => {
  const h = harness(); h.view.init({}, h.cx); await h.flush();
  h.setSurface({ active: true, frame: 8, mouseFrame: 12, lines: ["first", "second"] });
  h.view.refresh(h.cx); await h.flush();
  const dialog = h.find(h.view.render(), "stereo-surface")!;
  dialog.mouseDown!({ local_position: { x: 20, y: 10 } }, h.cx);
  dialog.windowUp!({ local_position: { x: 20, y: 10 } }, h.cx);
  await h.flush();
  expect(h.calls.filter(call => call.op === "surface-mouse")).toEqual([
    { v: 1, op: "surface-mouse", frame: 12, event: { type: "press", button: "left", x: 1, y: 0 } },
    { v: 1, op: "surface-mouse", frame: 12, event: { type: "release", button: "left", x: 1, y: 0 } },
  ]);
});

test("cancels a lost dialog pointer capture without clicking", async () => {
  const h = harness(); h.view.init({}, h.cx); await h.flush();
  h.setSurface({ active: true, frame: 8, mouseFrame: 12, lines: ["first"] });
  h.view.refresh(h.cx); await h.flush();
  const dialog = h.find(h.view.render(), "stereo-surface")!;
  dialog.mouseDown!({ local_position: { x: 20, y: 10 } }, h.cx);
  dialog.windowMove!({ local_position: { x: 30, y: 10 } }, h.cx);
  await h.flush();
  expect(h.view.surfacePress).toBeNull();
  expect(h.calls.filter(call => call.op === "surface-mouse").at(-1).event).toMatchObject({ type: "release", cancel: true });
});

test("forwards overlay and widget pointer input with the painted target", async () => {
  const h = harness();
  h.setOverlays([{ id: 7, frame: 4, mouseFrame: 5, focused: true, row: 3, col: 4, width: 20, height: 2, lines: ["overlay"] }]);
  h.view.init({}, h.cx); await h.flush();
  const layer = h.find(h.view.render(), "stereo-overlay-7")!;
  const point = { local_position: { x: 13, y: 1 }, modifiers: { alt: true } };
  layer.mouseMove!(point, h.cx);
  h.find(layer, "stereo-overlay-7-row-0")!.wheel!({ ...point, delta_lines: { x: 0, y: -3 } }, h.cx);
  layer.mouseDownByButton.middle({ ...point, button: "middle", click_count: 2 }, h.cx);
  layer.windowUpByButton.middle({ ...point, button: "middle" }, h.cx);
  h.view.dock = { active: true, width: 20, mouseFrame: 6, lines: ["dock"] };
  const dock = h.view.renderDock({});
  dock.mouseMove({ local_position: { x: 20, y: 5 } }, h.cx);
  h.find(dock, "stereo-dock-row-0")!.wheel!({ local_position: { x: 12, y: 1 }, delta: { x: 0, y: 17 } }, h.cx);
  await h.flush();
  expect(h.calls.filter(call => call.op === "overlay-mouse").map(call => call.event)).toEqual([
    { type: "move", button: "none", x: 1, y: 0, alt: true },
    { type: "wheel", button: "none", x: 1, y: 0, alt: true, wheelDelta: 15 },
    { type: "press", button: "middle", x: 1, y: 0, alt: true, clickCount: 2 },
    { type: "release", button: "middle", x: 1, y: 0, alt: true },
  ]);
  expect(h.calls.filter(call => call.op === "surface-mouse" && call.target === "dock").map(call => call.event)).toEqual([
    { type: "move", button: "none", x: 1, y: 0 },
    { type: "wheel", button: "none", x: 1, y: 0, wheelDelta: -1 },
  ]);
});
test("lost overlay and dock captures release without clicks", async () => {
  const h = harness();
  h.setOverlays([{ id: 7, frame: 4, mouseFrame: 5, focused: true, row: 3, col: 4, width: 20, height: 2, lines: ["overlay"] }]);
  h.view.init({}, h.cx); await h.flush();
  const layer = h.find(h.view.render(), "stereo-overlay-7")!;
  layer.mouseDown!({ local_position: { x: 13, y: 1 } }, h.cx);
  layer.windowMove!({ local_position: { x: 13, y: 1 } }, h.cx);
  await h.flush();
  expect(h.view.overlayPress).toBeNull();
  expect(h.calls.filter(call => call.op === "overlay-mouse").at(-1).event).toMatchObject({ type: "release", cancel: true });
  h.view.dock = { active: true, width: 20, mouseFrame: 6, lines: ["dock"] };
  const dock = h.view.renderDock({});
  dock.mouseDown({ local_position: { x: 20, y: 10 } }, h.cx);
  dock.windowUp({}, h.cx);
  await h.flush();
  expect(h.view.dockPress).toBeNull();
  expect(h.calls.filter(call => call.op === "surface-mouse" && call.target === "dock").at(-1).event).toMatchObject({ type: "release", cancel: true });
});

test("lost history capture sends cancel and unblocks paging", async () => {
  const h = harness(); h.view.init({}, h.cx); await h.flush();
  const pane = h.view.chat;
  const box = h.find(h.view.render(), "stereo-chat-box")!;
  box.mouseDown!({ local_position: { x: 20, y: 3 }, click_count: 1 }, h.cx);
  await h.flush();
  expect(pane.pressed).toBe(true);
  box.windowMove!({ local_position: { x: 25, y: 3 } }, h.cx);
  await h.flush();
  expect(pane.pressed).toBe(false);
  expect(pane.autoScroll).toBe(0);
  expect(h.calls.filter(call => call.op === "mouse").at(-1).event).toMatchObject({ type: "release", cancel: true });
});

test("lost divider capture cancels resizing without saving", async () => {
  const h = harness(); h.view.init({}, h.cx); await h.flush();
  const bar = h.view.divider({});
  bar.mouseDown({ position: { x: 320, y: 0 } }, h.cx);
  bar.windowMove({ position: { x: 420, y: 0 } }, h.cx);
  bar.windowUp({}, h.cx);
  await h.flush();
  expect(h.view.drag).toBeUndefined();
  expect(h.calls.some(call => call.op === "setting")).toBe(false);
});

test("clicks the visible row at fractional app zoom after scrolling", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.setZoom(1.1);
  h.view.chat.handle.offset = () => ({ y: 1582.73 });
  h.view.chat.frameTop = 0; h.view.chat.frameHeight = 256;
  const panel = h.find(h.view.render(), "stereo-chat-box")!;
  panel.mouseDown!({ local_position: { x: 100, y: 149 }, click_count: 1 }, h.cx);
  const press = h.calls.filter(call => call.op === "mouse" && call.event.type === "press").at(-1);
  expect(press.event.y).toBe(99);
  panel.windowUp!({ local_position: { x: 100, y: 149 }, click_count: 1 }, h.cx);
  await h.flush();
});

test("hovering and leaving a panel sends pointer motion without selecting", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  Object.assign((h.state as any).preferences, { turns: true, turnHover: true });
  Object.assign(h.view.viewState.preferences, { turns: true, turnHover: true });
  h.view.chat.lastSize = { width: 400, height: 300 };
  h.view.sendHover("chat", h.view.chat, { local_position: { x: 20, y: 5 } }, h.cx);
  await h.flush();
  h.view.sendHover("chat", h.view.chat, { local_position: { x: -1, y: 5 } }, h.cx);
  await h.flush();
  const moves = h.calls.filter(call => call.op === "mouse").map(call => call.event);
  expect(moves).toEqual([{ type: "move", button: "none", x: 1, y: 0 }, { type: "move", button: "none", x: -1, y: -1 }]);
  expect(h.view.chat.pressed).toBe(false);
});

test("moves to a requested position in the other panel only once", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.setTotal(100);
  h.setJump({ serial: 1, top: 35 });
  const positions: number[] = [];
  h.view.activity.handle.scroll_to_item = (index: number) => positions.push(index);
  h.view.refresh(h.cx);
  await h.flush();
  expect(positions).toEqual([35]);
  expect(h.view.activity.following).toBe(false);
  h.view.refresh(h.cx);
  await h.flush();
  expect(positions).toEqual([35]);
});

test("copies a selection spanning uncached history through the bridge", async () => {
  const h = harness();
  const rows = Array.from({ length: 600 }, (_, index) => `row ${index}`);
  h.setRows(rows);
  h.view.init({}, h.cx);
  await h.flush();
  const first = rows[0];
  h.view.chat.selectionRows.set(0, { cells: Array.from(first, (text, start) => ({ text, start, end: start + 1 })), words: [] });
  h.view.chat.selection.start({ row: 0, col: 0 }, "character");
  h.view.chat.selection.extend({ row: 599, col: 6 });
  h.view.activePane = "chat";
  h.view.render().keyDown({ key: "c", modifiers: { control: true } }, h.cx);
  await h.flush();
  expect(h.copied).toEqual([rows.join("\n")]);
  expect(h.calls.some(call => call.op === "view" && call.pane === "chat" && !call.following && call.height === 256)).toBe(true);
});

test("selects the visible history row at fractional desktop scaling", async () => {
  const h = harness();
  h.setZoom(1.1);
  h.view.init({}, h.cx);
  await h.flush();
  const pane = h.view.chat;
  pane.total = 194;
  pane.revision = 1;
  pane.frameTop = 0;
  pane.frameHeight = 194;
  pane.handle.content_size = () => ({ height: 3292.13 });
  pane.handle.offset = () => ({ y: 2104.85 });
  const root = h.view.render();
  h.find(root, "stereo-chat-box")!.mouseDown!({ local_position: { x: 20, y: 0 } }, h.cx);
  expect(pane.selection.endpoints()).toEqual([124, 124]);
  await h.flush();
});

test("renders a long selected row as a small number of styled spans", () => {
  const h = harness();
  h.view.init({}, h.cx);
  const line = "a".repeat(200);
  h.view.chat.items.set(0, { id: "row", lines: [line] });
  h.view.chat.selectionRows.set(0, { cells: Array.from(line, (text, start) => ({ text, start, end: start + 1 })), words: [] });
  h.view.chat.selection.start({ row: 0, col: 0 }, "character");
  h.view.chat.selection.extend({ row: 0, col: 199 });
  const row = h.view.entry(h.view.chat, 0, {});
  expect(row.nodes.length).toBe(1);
});

test("dragging outside a panel scrolls while retaining the selection", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.setTotal(100);
  h.view.chat.total = 100;
  let offset = 0;
  h.view.chat.handle.offset = () => ({ y: offset });
  h.view.chat.handle.viewport_size = () => ({ height: 34 });
  h.view.chat.handle.scroll_to_item = (index: number) => { offset = index * 17; };
  const timers: (() => void)[] = [];
  (h.cx.timer as any).after = (_delay: number, callback: (cx: any) => void) => timers.push(() => callback(h.cx));
  const panel = h.find(h.view.render(), "stereo-chat-box")!;
  panel.mouseDown!({ local_position: { x: 15, y: 8 }, click_count: 1 }, h.cx);
  await h.flush();
  panel.windowMove!({ local_position: { x: 15, y: 36 }, pressed_button: "left", click_count: 1 }, h.cx);
  await h.flush();
  expect(timers.length).toBe(1);
  timers.shift()!();
  expect(offset).toBeGreaterThan(0);
  expect(h.view.chat.following).toBe(false);
  panel.windowUp!({ local_position: { x: 15, y: 36 }, click_count: 1 }, h.cx);
  await h.flush();
  const stopped = offset;
  timers.shift()?.();
  expect(offset).toBe(stopped);
});

test("keeps following new output until the user scrolls away", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  let moves = 0;
  h.view.activity.handle.scroll_to_bottom = () => { moves++; };
  h.setTotal(100);
  h.view.refresh(h.cx);
  await h.flush();
  expect(moves).toBe(1);
  h.view.activity.following = false;
  h.setTotal(120);
  h.view.refresh(h.cx);
  await h.flush();
  expect(moves).toBe(1);
});

test("keeps previously loaded history visible while a different viewport is refreshed", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.view.chat.items.set(80, { id: "prior", lines: ["previously visible"] });
  h.setTotal(100);
  h.view.chat.following = false;
  h.view.chat.handle.content_size = () => ({ height: 1700 });
  h.view.refresh(h.cx);
  await h.flush();
  expect(h.view.chat.items.get(80)?.lines).toEqual(["previously visible"]);
});

test("virtualized rows contain no event handlers", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  const row = h.view.entry(h.view.chat, 0, {});
  expect(row.mouseDown).toBeUndefined();
  expect(row.mouseUp).toBeUndefined();
});

test("opens HTTP links from styled terminal content without running other URL schemes", () => {
  const h = harness();
  h.view.init({}, h.cx);
  const pane = h.view.chat;
  pane.selectionRows.set(0, { cells: [{ text: "link", start: 0, end: 4 }], words: [] });
  pane.items.set(0, { id: "0", lines: ["\u001b]8;;https://example.com/a\u001b\\link\u001b]8;;\u001b\\"] });
  h.view.openLink(pane, 0, 1, h.cx);
  expect(h.opened).toEqual(["https://example.com/a"]);
  pane.items.set(0, { id: "0", lines: ["\u001b]8;;file:///etc/passwd\u001b\\link\u001b]8;;\u001b\\"] });
  h.view.openLink(pane, 0, 1, h.cx);
  expect(h.opened).toEqual(["https://example.com/a"]);
});

test("opens native settings and sends validated setting changes to the bridge", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.find(h.view.render(), "stereo-action-settings")!.click!({}, h.cx);
  expect(h.find(h.view.render(), "stereo-settings")).toBeDefined();
  h.find(h.view.render(), "setting-test")!.click!({}, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "setting", key: "compactTools", value: false });
  h.find(h.view.render(), "setting-close")!.click!({}, h.cx);
  expect(h.find(h.view.render(), "stereo-settings")).toBeUndefined();
});

test("forwards native document mouse events with the displayed frame", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  const box = h.find(h.view.render(), "stereo-chat-box")!;
  const event = { local_position: { x: 20, y: 3 }, modifiers: {}, click_count: 1 };
  box.mouseDown!(event, h.cx);
  box.windowUp!(event, h.cx);
  await h.flush();
  const mouse = h.calls.filter(call => call.op === "mouse");
  expect(mouse.map(call => call.event.type)).toEqual(["press", "release"]);
  expect(mouse[0]).toMatchObject({ pane: "chat", frame: 1, event: { x: 1, y: 0, button: "left" } });
});

const BLOCK_ROWS = ["13:52:57", "Run the command", "      [Go to] [Copy]", "", "13:53:39", "fini", "                [Copy]"];

test("draws history rows in the terminal's monospace font, not the UI font", async () => {
  const h = harness(); h.view.init({}, h.cx);
  h.view.chat.items.set(0, { id: "0", lines: ["plain"] });
  const run = h.view.entry(h.view.chat, 0, {}).nodes[0];
  expect(run.styles.font_family).toEqual(["Test Mono"]);
  expect(run.styles.text_size, "no terminal size: the default").toEqual([12]);
  expect(h.view.entry(h.view.chat, 0, {}).styles.h, "and the default row height").toEqual([17]);
  h.setFontSize(11); h.view.render();
  const sized = h.view.entry(h.view.chat, 0, {});
  expect(sized.nodes[0].styles.text_size).toEqual([11]);
  expect(sized.styles.h, "a row is as tall as the terminal's own").toEqual([14.5]);
  expect(sized.nodes[0].styles.line_height, "a pixel length: a bare number is a multiple of the text size").toEqual(["14.5px"]);
  h.setFontSize(undefined); h.view.render();
  const probe = h.find(h.view.render(), "stereo-cell-probe")!;
  expect(probe.styles.font_family, "the cell probe measures the same font").toEqual(["Test Mono"]);
  h.setFont(undefined);
  expect(h.view.entry(h.view.chat, 0, {}).nodes[0].styles.font_family, "a layout without a terminal font").toEqual(["JetBrains Mono"]);
  expect(h.find(h.view.render(), "stereo-cell-probe")!.styles.font_family).toEqual(["JetBrains Mono"]);
});

test("a block's background runs on to the row's end, and a turn's bar stays one cell", async () => {
  const h = harness(); h.view.init({}, h.cx);
  const bar = "\u001b[48;2;249;216;222m \u001b[49m";
  h.view.chat.items.set(0, { id: "0", lines: [`${bar}\u001b[48;2;240;241;235m $ sleep 1   \u001b[0m`] });
  const [marker, body] = h.view.entry(h.view.chat, 0, {}).nodes;
  expect(marker.styles.flex_none, "the bar keeps its cell").toBeDefined();
  expect(marker.styles.flex_grow).toBeUndefined();
  expect(body.styles.flex_grow, "the padded run runs on to the row's end").toEqual([1]);
  expect(body.styles.bg).toEqual(["#f0f1eb"]);

  h.view.chat.items.set(1, { id: "1", lines: [bar] });
  const only = h.view.entry(h.view.chat, 1, {}).nodes;
  expect(only, "a row of only the bar").toHaveLength(1);
  expect(only[0].styles.flex_grow, "the bar alone does not become a band").toBeUndefined();

  h.view.chat.items.set(2, { id: "2", lines: ["\u001b[48;2;10;20;30mcode\u001b[0m"] });
  expect(h.view.entry(h.view.chat, 2, {}).nodes[0].styles.flex_grow, "an inline span keeps its own extent").toBeUndefined();

  h.view.chat.items.set(3, { id: "3", lines: [`${bar}text with trailing blanks      `] });
  expect(h.view.entry(h.view.chat, 3, {}).nodes[1].styles.flex_grow, "padding without a background has nothing to carry").toBeUndefined();

  h.view.chat.items.set(4, { id: "4", lines: ["\u001b[48;2;238;240;242m        \u001b[49m"] });
  expect(h.view.entry(h.view.chat, 4, {}).nodes[0].styles.flex_grow, "a padding row of a message block").toEqual([1]);
});

test("a footer row keeps the turn's bar and draws nothing else", async () => {
  const h = harness(); h.view.init({}, h.cx);
  const bar = "\u001b[48;2;249;216;222m \u001b[49m";
  h.view.chat.items.set(0, { id: "0", lines: [`${bar}           [Go to] [Copy]`], footer: footerControls("             [Go to] [Copy]") });
  const nodes = h.view.entry(h.view.chat, 0, {}).nodes;
  expect(nodes).toHaveLength(1);
  expect(nodes[0].styles.bg).toEqual(["#f9d8de"]);
});

test("a block's footer draws nothing and its controls appear as buttons on hover", async () => {
  const h = harness(); h.setRows(BLOCK_ROWS); h.view.init({}, h.cx); await h.flush();
  const pane = h.view.chat;
  expect(pane.items.get(2).footer).toEqual({ goTo: { column: 6, width: 7 }, copy: { column: 14, width: 6 } });
  expect(pane.items.get(1).footer).toBeNull();
  expect(h.view.entry(pane, 2, {}).nodes, "the footer row is blank").toHaveLength(0);

  pane.lastSize = { width: 400, height: 300 };
  const box = h.find(h.view.render(), "stereo-chat-box")!;
  expect(h.find(h.view.render(), "stereo-block-buttons"), "no buttons without the pointer").toBeUndefined();
  box.windowMove!({ local_position: { x: 20, y: 20 } }, h.cx); // Row 1.
  const bar = h.find(h.view.render(), "stereo-block-buttons")!;
  expect(bar).toBeDefined();
  expect(h.find(bar, "stereo-block-goTo")?.styles.tooltip?.[0]).toMatch(/Go to/);
  expect(h.find(bar, "stereo-block-copy")?.styles.tooltip?.[0]).toBe("Copy this block");
  for (const id of ["stereo-block-goTo", "stereo-block-copy"]) {
    const button = h.find(bar, id)!;
    expect(button.styles.cursor_pointer, id).toBeDefined();
    expect(button.styles.w?.[0], id).toBeGreaterThanOrEqual(24);
    expect(button.styles.h?.[0], id).toBeGreaterThanOrEqual(24);
  }

  box.windowMove!({ local_position: { x: 20, y: 6 * 17 + 3 } }, h.cx); // Row 6, the second block's footer.
  const second = h.find(h.view.render(), "stereo-block-buttons")!;
  expect(h.find(second, "stereo-block-goTo"), "this block has no Go to").toBeUndefined();
  expect(h.find(second, "stereo-block-copy")).toBeDefined();

  box.windowMove!({ local_position: { x: 20, y: -5 } }, h.cx);
  expect(h.find(h.view.render(), "stereo-block-buttons"), "leaving the panel hides them").toBeUndefined();
});

test("a block button presses the control Pi drew and Copy shows it was done", async () => {
  const h = harness(); h.setRows(BLOCK_ROWS); h.view.init({}, h.cx); await h.flush();
  const pane = h.view.chat;
  pane.lastSize = { width: 400, height: 300 };
  const box = h.find(h.view.render(), "stereo-chat-box")!;
  box.windowMove!({ local_position: { x: 20, y: 20 } }, h.cx);
  const bar = h.find(h.view.render(), "stereo-block-buttons")!;
  const before = h.calls.length;
  h.find(bar, "stereo-block-copy")!.click!({}, h.cx);
  await h.flush();
  const mouse = h.calls.slice(before).filter(call => call.op === "mouse");
  expect(mouse.map(call => call.event)).toEqual([
    { type: "press", button: "left", x: 17, y: 2, shift: false, ctrl: false, alt: false, clickCount: 1 },
    { type: "release", button: "left", x: 17, y: 2, shift: false, ctrl: false, alt: false, clickCount: 1 },
  ]);
  expect(mouse.every(call => call.pane === "chat" && call.frame === 1)).toBe(true);
  expect(h.find(h.view.render(), "stereo-block-copy")?.styles.tooltip?.[0], "the button says it was copied").toBe("Copied");

  h.find(bar, "stereo-block-goTo")!.click!({}, h.cx);
  await h.flush();
  expect(h.calls.filter(call => call.op === "mouse").slice(-2).map(call => call.event.x)).toEqual([9, 9]);
  expect(h.view.chat.pressed, "a button press does not start a selection").toBe(false);
  expect(h.view.chat.selection.bounds()).toBeFalsy();
});

test("scrolling hides the block buttons until the pointer moves again", async () => {
  const h = harness(); h.setRows(BLOCK_ROWS); h.view.init({}, h.cx); await h.flush();
  h.view.chat.lastSize = { width: 400, height: 300 };
  const box = h.find(h.view.render(), "stereo-chat-box")!;
  box.windowMove!({ local_position: { x: 20, y: 20 } }, h.cx);
  expect(h.find(h.view.render(), "stereo-block-buttons")).toBeDefined();
  box.wheel!({}, h.cx);
  expect(h.find(h.view.render(), "stereo-block-buttons")).toBeUndefined();
});

test("a block taller than the view keeps its buttons on its first visible row", async () => {
  const h = harness();
  const rows = ["13:52:57", ...Array.from({ length: 40 }, (_, n) => `item ${n}`), "                [Copy]"];
  h.setRows(rows); h.view.init({}, h.cx); await h.flush();
  const pane = h.view.chat;
  pane.lastSize = { width: 400, height: 300 };
  pane.handle.offset = () => ({ y: 10 * 17 });
  pane.blockHover = 15;
  expect(h.view.hoveredBlock(pane)).toMatchObject({ start: 0, end: 41, anchor: 10 });
  pane.blockHover = 5;
  expect(h.view.hoveredBlock(pane)).toMatchObject({ anchor: 10 });
});

test("two columns that are too narrow to read stack as rows without changing the saved choice", async () => {
  const h = harness(); h.view.init({}, h.cx); await h.flush();
  h.view.areaWidth = 355;
  expect(h.view.layout(), "before the font is measured the choice stands").toBe("columns");
  h.view.measureCell({ width: 100, height: 20 }, h.cx); // One cell is 10 px.
  expect(h.view.cellWidth).toBe(10);
  h.view.areaWidth = 1600;
  expect(h.view.layout()).toBe("columns");
  expect(h.find(h.view.render(), "stereo-panels")?.kind).toBe("horizontal");
  expect(h.find(h.view.render(), "stereo-action-layout")?.click, "the layout control works while columns fit").toBeDefined();

  h.view.areaWidth = 355;
  expect(h.view.layout()).toBe("rows");
  expect(h.view.viewState.layout, "the choice stays").toBe("columns");
  const root = h.view.render();
  expect(h.find(root, "stereo-panels")?.kind).toBe("vertical");
  expect(h.find(root, "stereo-chat-box")).toBeDefined();
  expect(h.find(root, "stereo-activity-box")).toBeDefined();
  const control = h.find(root, "stereo-action-layout")!;
  expect(control.click, "the layout control cannot act while stacked").toBeUndefined();
  expect(control.styles.tooltip?.[0]).toMatch(/too narrow/);

  h.view.areaWidth = 1600;
  expect(h.view.layout()).toBe("columns");
  h.view.viewState.mode = "combined";
  h.view.areaWidth = 355;
  expect(h.view.layout(), "combined history is one column already").toBe("columns");
});

test("uses the saved conversation size and a 20 percent default in columns", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.view.areaWidth = 1600;
  h.view.cellWidth = 10;
  expect(h.view.chatExtent(), "a narrow area: room for the minimum number of cells").toBe(MIN_COLUMN_CELLS * 10 + 24);
  h.view.areaWidth = 3000;
  expect(h.view.chatExtent(), "a wide area: 20 percent").toBe(600);
  h.view.areaWidth = 1600;
  h.view.viewState.preferences.chatWidth = 40;
  expect(h.view.chatExtent()).toBe(416);
});

test("resizing the divider persists the new conversation width", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.view.areaWidth = 1600;
  h.view.cellWidth = 10;
  const bar = h.view.divider({});
  bar.mouseDown({ position: { x: 424, y: 0 } }, h.cx);
  bar.windowMove({ position: { x: 520, y: 0 }, pressed_button: "left" }, h.cx);
  bar.windowUp({}, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "setting", key: "chatWidth", value: 50 });
});

test("opens a panel search and sends its query through the bridge", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.find(h.view.render(), "stereo-action-find-chat")!.click!({}, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "search", pane: "chat", action: "open", top: 0, height: 19, following: true });
  h.find(h.view.render(), "search-query")!.click!({}, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "search", pane: "chat", action: "query", query: "hello" });
  expect(h.view.chat.searchState.count).toBe(1);
});

test("selects and copies text from a native rendered row", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  const box = h.find(h.view.render(), "stereo-chat-box")!;
  box.mouseDown!({ local_position: { x: 20, y: 3 }, modifiers: {}, click_count: 1 }, h.cx);
  box.windowMove!({ local_position: { x: 44, y: 3 }, pressed_button: "left", modifiers: {} }, h.cx);
  box.windowUp!({ local_position: { x: 44, y: 3 }, modifiers: {}, click_count: 1 }, h.cx);
  await h.flush();
  h.view.render().keyDown({ key: "c", modifiers: { control: true } }, h.cx);
  expect(h.copied).toEqual(["ati"]);
});
