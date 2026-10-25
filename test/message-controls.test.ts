import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { CompactMessage } from "../src/timestamps.js";
import { searchHitRow } from "../src/search-highlight.js";

import { Container, Text } from "@earendil-works/pi-tui";
import { NativeDocument } from "../src/native.js";
import { TranscriptTimestamps } from "../src/timestamps.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
const theme = { fg: (_: string, text: string) => text, style: (text: string) => text } as unknown as Theme;
const pointer = (x: number, y: number): TuiMouseEvent => ({
  type: "click", button: "left", x, y, screenX: x, screenY: y,
  width: 30, height: 10, shift: false, alt: false, ctrl: false,
});

test("keeps the copy control a composed grapheme inside its two-cell slot", () => {
  const message = new CompactMessage({ render: () => ["body"], invalidate() {} },
    () => "12:34:56", () => theme, () => 0, () => true, () => {});
  try {
    message.prepare(30, true);
    const row = stripTerminalSequences(message.render(30).at(-1)!);
    const graphemes = [...new Intl.Segmenter().segment(row.trimStart())].map(part => part.segment);
    expect(graphemes).toHaveLength(2);
    expect(graphemes[0].codePointAt(0)).toBe(0x29c9);
    const markers = [...graphemes[0]].slice(1);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.every(marker => /\p{Default_Ignorable_Code_Point}/u.test(marker))).toBe(true);
    expect(visibleWidth(graphemes[0])).toBe(1);
    expect(graphemes[1]).toBe(" ");
    expect(visibleWidth(row)).toBe(30);
  } finally { message.dispose(); }
});
test("hides the footer immediately without hiding time or disabling keyboard copies", () => {
  class UserMessageComponent extends Text {}
  const user = new UserMessageComponent("USER SOURCE", 0, 0);
  const history = new Container();
  history.addChild(user);
  const root = new Container();
  root.addChild(new Container()); root.addChild(new Container()); root.addChild(history);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [{
    type: "message", id: "user", parentId: null, timestamp: "2001-10-09T12:34:56Z",
    message: { role: "user", content: "USER SOURCE", timestamp: Date.parse("2001-10-09T12:34:56Z") },
  }], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  let show = true;
  const copied: (string | undefined)[] = [];
  const document = new NativeDocument(root, "chat", timestamps, () => theme, () => 0, () => true,
    () => {}, true, undefined, text => copied.push(text), () => show);
  try {
    expect(document.render(30).join("\n")).toContain("⧉");
    show = false;
    document.invalidate();
    const hidden = document.render(30).map(stripTerminalSequences);
    expect(hidden).toHaveLength(2);
    expect(hidden[0]).toMatch(/^ \d{2}:\d{2}:\d{2}$/);
    expect(hidden.join("\n")).not.toContain("⧉");
    const choices = document.copyBlocks();
    expect(choices).toHaveLength(1);
    choices[0].copy();
    expect(copied).toEqual(["USER SOURCE"]);
    show = true;
    document.invalidate();
    expect(document.render(30).at(-1)?.trim()).toBe("⧉\u034f");
  } finally { document.dispose(); }
});
test.each([true, false])("leaves untimed blocks undecorated even when clocks are %s", show => {
  let label = "";
  let copies = 0;
  const events: TuiMouseEvent[] = [];
  const native: Component = {
    render: () => ["", "Package updates are available.", ""], invalidate() {},
    handleMouse: event => { events.push(event); return { handled: true }; },
  };
  const message = new CompactMessage(native, () => label, () => theme, () => 0, () => show, () => { copies++; });
  try {
    message.prepare(30, true);
    expect(message.render(30)).toEqual(["", "Package updates are available."]);
    expect(message.searchClock()).toBeUndefined();
    message.handleMouse(pointer(28, 1));
    expect(events.at(-1)).toMatchObject({ y: 1, width: 30, height: 3 });
    message.handleMouse(pointer(28, 2));
    expect(copies).toBe(0);
    label = "12:34:56";
    message.prepare(30, true);
    expect(message.render(30).at(-1)?.trim()).toBe("⧉\u034f");
    label = "";
    message.prepare(30, true);
    expect(message.render(30)).toEqual(["", "Package updates are available."]);
    expect(message.searchClock()).toBeUndefined();
    message.handleMouse(pointer(28, 2));
    expect(copies).toBe(0);
  } finally { message.dispose(); }
});
test.each([true, false])("places time above and the copy icon below without a side control gutter (clock %s)", show => {
  let nativeWidth = 0;
  let copies = 0;
  const events: TuiMouseEvent[] = [];
  const native: Component = {
    render: width => { nativeWidth = width; return ["", "a".repeat(width), "body", ""]; },
    invalidate() {}, handleMouse: event => { events.push(event); return { handled: true }; },
  };
  const message = new CompactMessage(native, () => "12:34:56", () => theme, () => 1, () => show, () => { copies++; });
  try {
    message.prepare(30, true);
    const rows = message.render(30).map(stripTerminalSequences);
    const header = show ? [" 12:34:56"] : [];
    expect(nativeWidth).toBe(29);
    expect(rows).toEqual(["", ...header, "a".repeat(29), "body", " ".repeat(27) + "⧉\u034f "]);
    const contentRow = 1 + header.length;
    message.handleMouse(pointer(28, contentRow));
    expect(events.at(-1)).toMatchObject({ x: 28, y: 1, width: 29, height: 4 });
    const count = events.length;
    if (show) message.handleMouse(pointer(0, 1));
    for (let x = 27; x < 29; x++) message.handleMouse(pointer(x, rows.length - 1));
    message.handleMouse(pointer(26, rows.length - 1));
    message.handleMouse(pointer(29, rows.length - 1));
    expect(copies).toBe(2);
    expect(events).toHaveLength(count);
  } finally { message.dispose(); }
});

test("does not create header or footer rows for invisible blocks", () => {
  const message = new CompactMessage({ render: () => ["", " "], invalidate() {} },
    () => "12:34:56", () => theme, () => 0, () => true, () => {});
  try {
    expect(message.prepare(30, true)).toBe(false);
    expect(message.render(30)).toEqual([]);
    expect(message.searchClock()).toBeUndefined();
  } finally { message.dispose(); }
});

test("keeps image protocol rows intact between the header and footer", () => {
  const image = "\x1b_Ga=T;AAAA\x1b\\";
  const content = ["", image, ""];
  const message = new CompactMessage({ render: () => content, invalidate() {} },
    () => "12:34:56", () => theme, () => 0, () => true, () => {});
  try {
    const rows = message.render(30);
    expect(rows[0]).toBe(" 12:34:56");
    expect(rows.slice(1, -1)).toEqual(content);
    expect(rows.at(-1)?.trim()).toBe("⧉\u034f");
  } finally { message.dispose(); }
});

test.each([true, false])("search ignores the footer icon (clock %s)", show => {
  const native: Component = { render: () => ["body"], invalidate() {} };
  const message = new CompactMessage(native, () => "12:34:56", () => theme, () => 0, () => show, () => {});
  try {
    const rows = message.render(30);
    const hit = { entry: { source: native, label: "User", text: "⧉" }, line: 0, text: "⧉" };
    expect(searchHitRow(rows, hit, message.searchClock())).toBeUndefined();
    expect(searchHitRow(rows, { ...hit, text: "body", entry: { ...hit.entry, text: "body" } }, message.searchClock())).toBe(show ? 1 : 0);
  } finally { message.dispose(); }
});
