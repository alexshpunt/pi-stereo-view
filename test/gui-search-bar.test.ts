import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// GPUI is supplied by Herdr, so exercise the retained view using its input and timer contracts.
function harness() {
  class Element {
    idValue?: string;
    nodes: Array<Element | string> = [];
    click?: (...args: any[]) => void;
    keyDown?: (...args: any[]) => void;
    constructor() {
      return new Proxy(this, { get(target, property, receiver) {
        if (property in target) return (target as any)[property];
        return (...args: any[]) => {
          if (property === "id") target.idValue = args[0];
          if (property === "child") target.nodes.push(args[0]);
          if (property === "on_click") target.click = args[0];
          if (property === "on_key_down") target.keyDown = args[0];
          return receiver;
        };
      } });
    }
  }
  const entries: any[] = [];
  const InputState = { new: () => {
    const callbacks: Record<string, Function> = {};
    const input = { current: "", callbacks, focused: false, released: false,
      on(name: string, callback: Function) { callbacks[name] = callback; return true; },
      value() { return this.current; }, focus() { this.focused = true; }, release() { this.released = true; return true; } };
    entries.push(input); return input;
  } };
  const element = () => new Element();
  const source = readFileSync(new URL("../herdr/mods/stereo-view/search-bar.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export /gm, "") + "\nreturn { createSearchBar };";
  const { createSearchBar } = new Function("div", "h_flex", "Input", "InputState", source)
    (element, element, { new: element }, InputState);
  const timers: Array<{ cancelled: boolean; fn: Function }> = [];
  const cx = { notify() {}, stop_propagation() {}, timer: { after(_ms: number, fn: Function) {
    const task = { cancelled: false, fn, cancel() { this.cancelled = true; } }; timers.push(task); return task;
  } } };
  const events: string[] = [];
  const bar = createSearchBar("chat", {
    query: (value: string) => events.push(`query:${value}`), next: () => events.push("next"),
    previous: () => events.push("previous"), close: () => events.push("close"),
  });
  const find = (node: Element, id: string): Element | undefined => node.idValue === id ? node :
    node.nodes.flatMap(child => child instanceof Element ? find(child, id) ?? [] : [])[0];
  const flush = () => { for (const task of timers.splice(0)) if (!task.cancelled) task.fn(cx); };
  return { bar, input: entries[0], cx, events, flush, find };
}

test("retains and focuses a draft and coalesces rapid edits", () => {
  const h = harness();
  expect(h.input.focused).toBe(true);
  h.input.current = "alpha"; h.input.callbacks.change({}, h.cx);
  h.input.current = "alpha beta"; h.input.callbacks.change({}, h.cx);
  expect(h.events).toEqual([]);
  h.bar.render({ current: 0, count: 0, pending: true }, {});
  h.flush();
  expect(h.events).toEqual(["query:alpha beta"]);
  expect(h.input.current).toBe("alpha beta");
});

test("submitting flushes the latest query before navigating in either direction", () => {
  const h = harness();
  h.input.current = "needle"; h.input.callbacks.change({}, h.cx);
  h.input.callbacks.submit({ shift: true }, h.cx);
  h.input.callbacks.submit({}, h.cx);
  h.flush();
  expect(h.events).toEqual(["query:needle", "previous", "next"]);
});

test("buttons navigate and close cancels an unsent query", () => {
  const h = harness();
  const root = h.bar.render({ current: 1, count: 3, pending: false }, {});
  h.find(root, "stereo-search-chat-next")!.click!({}, h.cx);
  h.find(root, "stereo-search-chat-previous")!.click!({}, h.cx);
  h.input.current = "unsent"; h.input.callbacks.change({}, h.cx);
  root.keyDown!({ key: "escape" }, h.cx);
  h.flush();
  expect(h.events).toEqual(["next", "previous", "close"]);
  h.bar.dispose();
  expect(h.input.released).toBe(true);
});

test("shows the backend's match count and error", () => {
  const h = harness();
  const text = (node: any): string[] => node.nodes.flatMap((child: any) => typeof child === "string" ? [child] : text(child));
  expect(text(h.bar.render({ current: 2, count: 7, pending: false }, {}))).toContain("2/7");
  expect(text(h.bar.render({ current: 0, count: 0, pending: false, error: "test-error-42" }, {}))).toContain("test-error-42");
});
