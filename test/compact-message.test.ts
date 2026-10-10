import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { CompactMessage } from "../src/timestamps.js";

const theme = () => ({ fg: (_color: string, value: string) => value }) as Theme;

test("reuses compact formatting for unchanged native lines without hiding native updates", () => {
  let clocks = 0;
  let renders = 0;
  let content = ["", "old text", ""];
  let label = "12:34:56";
  const colors = { fg: (_color: string, value: string) => { clocks++; return value; } } as Theme;
  const native: Component = { render: () => { renders++; return [...content]; }, invalidate() {} };
  const message = new CompactMessage(native, () => label, () => colors, () => 0, () => true);
  message.prepare(30, false);
  const first = message.render(30);
  message.prepare(30, true);
  expect(message.render(30).slice(1)).toEqual(first);
  expect(renders).toBe(1);
  expect(clocks, "Unchanged history must not repeat clock and line formatting on each layout pass").toBe(1);
  content = ["", "new text", ""];
  native.invalidate();
  message.prepare(30, false);
  expect(message.render(30).join("\n")).toContain("new text");
  expect(clocks).toBe(2);
  label = "12:35:00";
  message.prepare(30, false);
  expect(message.render(30).join("\n")).toContain(label);
  expect(clocks).toBe(3);
  message.invalidate();
  message.prepare(30, false);
  expect(clocks).toBe(4);
});

test("reuses separated rows without hiding native updates on the next preparation", () => {
  let content = ["", "same content", ""];
  let renders = 0;
  const native: Component = { render: () => { renders++; return [...content]; }, invalidate() {} };
  const colors = theme();
  const message = new CompactMessage(native, () => "12:34:56", () => colors, () => 0, () => true);
  message.prepare(30, true);
  const first = message.render(30);
  message.prepare(30, true);
  expect(message.render(30), "Unchanged history must not copy every row just to add its separator").toBe(first);
  expect(renders).toBe(1);
  content = ["", "changed content", ""];
  native.invalidate();
  message.prepare(30, true);
  expect(message.render(30)).not.toBe(first);
  expect(message.render(30).map(stripTerminalSequences).join("\n")).toContain("changed content");
  message.prepare(30, false);
  expect(message.render(30)[0]).not.toBe("");
});
test("adds one separator only for a visible block and renders native content once per preparation", () => {
  let renders = 0;
  let content = ["first", "", "second"];
  const native: Component = { render: () => { renders++; return content; }, invalidate() {} };
  const message = new CompactMessage(native, () => "12:34:56", theme, () => 0, () => true);
  expect(message.prepare(30, true)).toBe(true);
  expect(message.render(30)).toHaveLength(4);
  expect(message.render(30)[0]).toBe("");
  expect(renders).toBe(1);
  content = [];
  native.invalidate();
  expect(message.prepare(30, true)).toBe(false);
  expect(message.render(30)).toEqual([]);
  expect(renders).toBe(2);
});

test("does not strip image placement rows or append a clock to an image protocol", () => {
  const image = "\x1b_Ga=T,i=1;AAAA\x1b\\";
  const content = ["", "", image, ""];
  const native: Component = { render: () => content, invalidate() {} };
  const message = new CompactMessage(native, () => "12:34:56", theme, () => 0, () => true);
  const lines = message.render(30);
  expect(stripTerminalSequences(lines[0]).trim()).toBe("12:34:56");
  expect(lines.slice(1)).toEqual(content);
});

test("keeps wide text intact across resizing and never overwrites it with the clock", () => {
  const source = "界界界界 Привет длинная строка";
  const message = new CompactMessage(new Text(source, 0, 1), () => "12:34:56", theme, () => 1, () => true);
  for (const width of [24, 60, 24]) {
    const lines = message.render(width).map(stripTerminalSequences);
    expect(lines[0]).toMatch(/ 12:34:56$/);
    expect(lines.slice(1).join("")).not.toContain("12:34:56");
    expect(lines.map((line, index) => index === 0 ? line.replace(/\s+12:34:56$/, "") : line)
      .join("").replace(/\s/g, "")).toBe(source.replace(/\s/g, ""));
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width - 1);
  }
});

test("hiding clocks restores the text width without restoring message padding", () => {
  let show = true;
  const message = new CompactMessage(new Text("abcdefghij", 0, 1), () => "12:34:56", theme, () => 0, () => show);
  expect(message.render(16)).toHaveLength(2);
  show = false;
  expect(message.render(16).map(stripTerminalSequences)).toEqual(["abcdefghij".padEnd(16)]);
});

test("maps mouse rows and width back to native content after trimming its edges", () => {
  let received: TuiMouseEvent | undefined;
  const native: Component = {
    render: width => ["", "text".padEnd(width), "", "second".padEnd(width), ""],
    invalidate() {},
    handleMouse: event => { received = event; return { handled: true }; },
  };
  const message = new CompactMessage(native, () => "12:34:56", theme, () => 1, () => true);
  message.prepare(30, true);
  expect(message.render(30)).toHaveLength(4);
  const event = { x: 2, y: 3, width: 30, height: 4, screenX: 2, screenY: 100 } as TuiMouseEvent;
  expect(message.handleMouse(event)).toMatchObject({ handled: true });
  expect(message.handleMouse(event)?.target).toMatchObject({ originX: 0, originY: 97, width: 20, height: 5 });
  expect(received).toMatchObject({ x: 2, y: 3, width: 20, height: 5 });
  received = undefined;
  expect(message.handleMouse({ ...event, x: 25 })).toBeUndefined();
  expect(received).toBeUndefined();
});
