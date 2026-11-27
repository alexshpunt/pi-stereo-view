import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
// @ts-expect-error The mod has no TypeScript declarations.
import { parseAnsi } from "../herdr/mods/stereo-view/ansi.js";
// @ts-expect-error The mod has no TypeScript declarations.
import { createSelection } from "../herdr/mods/stereo-view/selection.js";

// GPUI and Herdr are native modules available inside the app, not in Node.
function harness() {
  const calls: any[] = [];
  let total = 1;
  const pending: Promise<unknown>[] = [];
  class Element {
    name?: string;
    nodes: Element[] = [];
    click?: (...args: any[]) => void;
    mouseDown?: (...args: any[]) => void;
    mouseUp?: (...args: any[]) => void;
    windowMove?: (...args: any[]) => void;
    windowUp?: (...args: any[]) => void;
    keyDown?: (...args: any[]) => void;
    constructor(readonly kind: string) {
      return new Proxy(this, { get(target, prop, receiver) {
        if (prop in target) return (target as any)[prop];
        return (...args: any[]) => {
          if (prop === "id") target.name = args[0];
          if (prop === "child" && args[0] instanceof Element) target.nodes.push(args[0]);
          if (prop === "children") target.nodes.push(...args[0]);
          if (prop === "on_click") target.click = args[0];
          if (prop === "on_mouse_down") target.mouseDown = args[1];
          if (prop === "on_mouse_up") target.mouseUp = args[1];
          if (prop === "on_window_mouse_move") target.windowMove = args[0];
          if (prop === "on_window_mouse_up") target.windowUp = args[1];
          if (prop === "on_key_down") target.keyDown = args[0];
          return receiver;
        };
      } });
    }
  }
  const el = (kind: string) => () => new Element(kind);
  const ui = { View: class {}, div: el("div"), image: el("image"), h_flex: el("horizontal"), v_flex: el("vertical"),
    v_virtual_list: el("list"), VirtualListScrollHandle: { new: () => ({ offset: () => ({ y: 0 }), viewport_size: () => ({ height: 300 }), content_size: () => ({ height: 0 }), scroll_to_bottom() {}, scroll_to_item() {} }) },
    Scrollbar: { vertical: el("scrollbar") } };
  const opened: string[] = [];
  const copied: string[] = [];
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {}, is_focused: () => true, release() {} }),
    write_to_clipboard(text: string) { copied.push(text); },
    open_url(url: string) { opened.push(url); }, timer: { every() {} }, spawn(fn: (cx: any) => Promise<unknown>) { pending.push(fn(cx)); } };
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
    const data = request.op === "state" ? state : request.op === "search" ? { v: 1, open: true, count: 1, current: 1, pending: false, top: 0 } : request.op === "action" || request.op === "setting" || request.op === "mouse" ? { v: 1, ok: true } :
      { v: 1, frame: 1, total, top: request.following ? Math.max(0, total - request.height) : request.top, width: request.width, height: request.height, scrollShift: 0,
        images: [], lines: request.top === 0 ? ["native rendered row"] : [],
        selection: request.top === 0 ? [{ cells: Array.from("native rendered row", (text, start) => ({ text, start, end: start + 1 })), words: [{ start: 0, end: 6 }] }] : [] };
    return { code: 0, stdout: JSON.stringify(data) };
  }, panes: () => [{ pane: "m/p", tab: "tab", terminal: "m/t" }], props: () => ({ pane: "m/p", origin: "m/t" }), run() {}, settings: () => ({ zoom: 1 }), spaces: () => [{ active: true, tabs: [{ id: "tab", active: true }] }], terminals: () => [terminal], theme: () => ({}), window: () => ({ visible: true }), parseAnsi, lineRange: () => ({ first: 0, last: 0 }) };
  const source = readFileSync(new URL("../herdr/mods/stereo-view/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class StereoView", "return class StereoView");
  const names = { ...ui, ...env, createSettingsPanel, createSearchBar, createSelection, Buffer, createHash,
    appHome: () => "/tmp", mkdir: async () => {}, writeFile: async () => {} };
  const StereoView = new Function(...Object.keys(names), source)(...Object.values(names));
  const view = new StereoView();
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const find = (node: Element, id: string): Element | undefined => node.name === id ? node : node.nodes.flatMap(child => find(child, id) ?? [])[0];
  return { view, cx, calls, state, flush, find, opened, copied, setTotal(value: number) { total = value; } };
}

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

test("keeps previously loaded history visible while a different viewport is refreshed", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.view.chat.items.set(80, { id: "prior", lines: ["previously visible"] });
  h.setTotal(100);
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

test("uses the saved conversation size and a 20 percent default in columns", async () => {
  const h = harness();
  h.view.init({}, h.cx);
  await h.flush();
  h.view.areaWidth = 1600;
  h.view.cellWidth = 10;
  expect(h.view.chatExtent()).toBe(320);
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
  bar.mouseDown({ position: { x: 320, y: 0 } }, h.cx);
  bar.windowMove({ position: { x: 420, y: 0 } }, h.cx);
  bar.windowUp({}, h.cx);
  await h.flush();
  expect(h.calls).toContainEqual({ v: 1, op: "setting", key: "chatWidth", value: 40 });
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
  box.windowMove!({ local_position: { x: 44, y: 3 }, modifiers: {} }, h.cx);
  box.windowUp!({ local_position: { x: 44, y: 3 }, modifiers: {}, click_count: 1 }, h.cx);
  await h.flush();
  h.view.render().keyDown({ key: "c", modifiers: { control: true } }, h.cx);
  expect(h.copied).toEqual(["ati"]);
});
