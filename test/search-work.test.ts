import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { PanelSearch, type SearchHit } from "../src/search.js";

const theme = () => ({ fg: (_color: string, value: string) => value }) as Theme;
const tui = { requestRender() {}, setFocus() {} } as unknown as TUI;

test("indexes an open nonempty search once, not on ordinary frames or query edits", () => {
  let reads = 0;
  const entry = { source: new Text("", 0, 0), label: "User", text: "deployment runtime ready" };
  const calls: (SearchHit | undefined)[] = [];
  const bar = new PanelSearch(() => { reads++; return [entry]; }, tui, theme, hit => calls.push(hit), () => {});
  bar.render(45);
  bar.markDirty();
  bar.render(45);
  expect(reads, "Opening an empty field must not scan the transcript").toBe(0);
  bar.input.handleInput("d");
  bar.render(45);
  bar.input.handleInput("p");
  for (let i = 0; i < 10; i++) bar.render(45);
  expect(reads).toBe(1);
  expect(calls.at(-1)?.text).toBe("deployment runtime ready");
  bar.markDirty();
  expect(reads, "Native updates should defer indexing until the next open-search render").toBe(1);
  bar.render(45);
  expect(reads).toBe(2);
  const jumps = calls.length;
  bar.markDirty();
  bar.render(45);
  expect(calls, "Unrelated streamed text must not pull the reader back to the same match").toHaveLength(jumps);
});

test("a retired search input repairs later overlay focus restoration without a mounted layout", async () => {
  const editor = new Text("editor", 0, 0);
  const overlay = new Text("overlay", 0, 0);
  let focused: Component | null = editor;
  const host = {
    requestRender() {},
    setFocus(component: Component | null) {
      if (focused && "focused" in focused) Reflect.set(focused, "focused", false);
      focused = component;
      if (focused && "focused" in focused) Reflect.set(focused, "focused", true);
    },
  } as unknown as TUI;
  const bar = new PanelSearch(() => [], host, theme, () => {}, () => {});
  bar.focus();
  host.setFocus(overlay);
  bar.retire(() => { if (focused === bar.input) host.setFocus(editor); });
  await Promise.resolve();
  expect(focused, "Retiring the field must not steal focus from the live overlay").toBe(overlay);
  // Native overlay dismissal can restore preFocus after this layout was disposed.
  host.setFocus(bar.input);
  await Promise.resolve();
  expect(focused).toBe(editor);
});
test("refreshes a retained occurrence when text before it changes in the same native block", () => {
  const source = new Text("", 0, 0);
  let content = "worker gone\nready";
  const selected: SearchHit[] = [];
  const bar = new PanelSearch(() => [{ source, label: "User", text: content }], tui, theme,
    hit => { if (hit) selected.push(hit); }, () => {});
  bar.input.handleInput("ready");
  expect(selected.at(-1)?.line).toBe(1);
  content = "worker ready\nready";
  bar.markDirty();
  bar.render(45);
  expect(selected.at(-1)?.line).toBe(1);
  expect(selected.at(-1)?.entry.text, "Occurrence mapping must use the updated complete saved text").toBe(content);
});
test("counts and visits every match beyond the old popup limit without wrapping a narrow search row", () => {
  const entries = Array.from({ length: 250 }, (_, index) => ({
    source: new Text("", 0, 0), label: String(index), text: "same phrase",
  }));
  let selected: SearchHit | undefined;
  const bar = new PanelSearch(() => entries, tui, theme, hit => { selected = hit; }, () => {});
  bar.input.handleInput("same");
  expect(bar.render(45).join("\n")).toContain("1/250");
  for (let index = 0; index < 249; index++) bar.input.handleInput("\r");
  expect(selected?.entry.label).toBe("0");
  expect(bar.render(45).join("\n")).toContain("250/250");
  expect(bar.render(24)).toHaveLength(1);
  expect(bar.render(24).join("\n")).toContain("[↓]");
  expect(bar.render(24).join("\n")).toContain("[×]");
  bar.input.handleInput("\r");
  expect(selected?.entry.label).toBe("249");
});
test("moves through repeated matches without closing and drops the highlight on an empty query", () => {
  const entries = ["older", "newer"].map(label => ({ source: new Text("", 0, 0), label, text: "same phrase" }));
  const calls: (SearchHit | undefined)[] = [];
  let closed = 0;
  const bar = new PanelSearch(() => entries, tui, theme, hit => calls.push(hit), () => { closed++; });
  bar.input.handleInput("smphrs");
  expect(calls.at(-1)?.entry.label).toBe("newer");
  bar.input.handleInput("\r");
  expect(calls.at(-1)?.entry.label).toBe("older");
  bar.input.handleInput("\r");
  expect(calls.at(-1)?.entry.label).toBe("newer");
  expect(closed).toBe(0);
  bar.input.handleInput("\x15");
  expect(calls.at(-1)).toBeUndefined();
  bar.input.handleInput("\x1b");
  expect(closed).toBe(1);
});
