import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { GuiDocuments } from "../src/gui-documents.ts";
import { NativeDocument } from "../src/native.ts";
import { NativeContentIndex } from "../src/content.ts";
import type { DocumentTurns } from "../src/native.ts";
import { TranscriptTimestamps } from "../src/timestamps.ts";
test("loads every image in a viewport even when their payloads exceed the cache", () => {
  const lines = Array.from({ length: 5 }, (_, i) => {
    const bytes = Buffer.alloc(10 * 1024 * 1024, i);
    Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
    return `\x1b_Ga=T,f=100,c=1,r=1;${bytes.toString("base64")}\x1b\\`;
  });
  const document = { setViewport() {}, beginFrame() {}, render: () => lines, takeScrollShift: () => 0,
    handleMouse: () => undefined, dispose() {} };
  const gui = new GuiDocuments({ chat: document, activity: document });
  const page = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  expect(page.images).toHaveLength(5);
  for (const placement of page.images) {
    const payload = lines[placement.row]!.split(";")[1]!;
    expect(gui.imageChunk(placement.id, 16, 64)?.data).toBe(payload.slice(16, 80));
  }
});

/** A document that lays out more rows with every render, like history being measured at a new width. */
function measuringDocument(counts: number[], settling: (render: number) => boolean) {
  let renders = 0;
  const budgets: number[] = [];
  const document = {
    setViewport() {}, beginFrame() {}, takeScrollShift: () => 0, handleMouse: () => undefined, dispose() {},
    setLazyBudget: (milliseconds: number) => { budgets.push(milliseconds); },
    get settling() { return settling(renders); },
    render: () => {
      const count = counts[Math.min(renders++, counts.length - 1)]!;
      return Array.from({ length: count }, (_, row) => `row ${row} of ${count}`);
    },
  };
  return { document, budgets };
}

test("a following page shows the last rows of the render that produced it, even while the row count keeps changing", () => {
  // Every render changes the count: shrinking (the panel got wider) and growing (it got narrower).
  for (const counts of [[400, 300, 250, 220, 200], [100, 140, 190, 260, 340]]) {
    const { document } = measuringDocument(counts, () => false);
    const gui = new GuiDocuments({ chat: document, activity: document });
    const page = gui.page("chat", { width: 30, top: 0, height: 10, following: true });
    expect(page.lines).toHaveLength(10);
    expect(page.top).toBe(page.total - 10);
    expect(page.lines.at(-1)).toBe(`row ${page.total - 1} of ${page.total}`);
  }
});

test("a page reports that rows are still being measured and raises the measuring budget while the width changes", () => {
  const { document, budgets } = measuringDocument([200], render => render <= 2);
  const gui = new GuiDocuments({ chat: document, activity: document });
  const first = gui.page("chat", { width: 30, top: 0, height: 10, following: true });
  expect(first.settling).toBe(true);
  expect(budgets.at(-1)).toBeGreaterThan(4);
  // Still unmeasured: the next page at the same width keeps the larger budget.
  const second = gui.page("chat", { width: 30, top: 0, height: 10, following: true });
  expect(second.settling).toBeUndefined();
  expect(budgets.at(-1)).toBeGreaterThan(4);
  const settled = gui.page("chat", { width: 30, top: 0, height: 10, following: true });
  expect(settled.settling).toBeUndefined();
  expect(budgets.at(-1)).toBe(4);
  gui.page("chat", { width: 36, top: 0, height: 10, following: true });
  expect(budgets.at(-1)).toBeGreaterThan(4);
});

test("a panel made wider still gets measured rows in its last lines when the history is long", () => {
  const { gui, history } = setup();
  for (let i = 0; i < 600; i++) history.addChild(new UserMessageComponent(`message ${i} ${"lorem ipsum ".repeat(12)}`, 0, 0));
  const narrow = gui.page("chat", { width: 20, top: 0, height: 30, following: true });
  expect(narrow.lines.join("\n")).toContain("message 599");
  for (const width of [90, 25, 140, 30]) {
    const page = gui.page("chat", { width, top: 0, height: 30, following: true });
    expect(page.lines).toHaveLength(30);
    expect(page.lines.filter(line => line.trim() === "").length).toBeLessThanOrEqual(2);
    expect(page.lines.join("\n")).toContain("message 599");
  }
});

class UserMessageComponent extends Text {
  events: TuiMouseEvent[] = [];
  handleMouse(event: TuiMouseEvent) {
    this.events.push(event);
    return { handled: true, capture: event.type === "press" };
  }
}

function setup(turns?: DocumentTurns) {
  const item = new UserMessageComponent("hello", 0, 0);
  const history = new Container(); history.addChild(item);
  const source = new Container(); source.addChild(new Container()); source.addChild(new Container()); source.addChild(history);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const theme = { fg: (_name: string, value: string) => value } as Theme;
  const chat = new NativeDocument(source, "chat", timestamps, () => theme, () => 0, () => false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, turns);
  const activity = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => false);
  const gui = new GuiDocuments({ chat, activity }, () => timestamps.beginFrame());
  return { gui, item, history };
}

test("following requests include the latest rows even when output grows before the reply", () => {
  const { gui, history } = setup();
  for (let i = 0; i < 20; i++) history.addChild(new UserMessageComponent(`message ${i}`, 0, 0));
  const page = gui.page("chat", { width: 30, top: 0, height: 5, following: true });
  expect(page.top).toBe(page.total - page.height);
  expect(page.lines.join("\n")).toContain("message 19");
});

test("exposes a jump to the target row in the GUI pane's own geometry", () => {
  const { gui, history } = setup();
  for (let i = 0; i < 15; i++) history.addChild(new UserMessageComponent(`message ${i}`, 0, 0));
  const target = new UserMessageComponent("jump destination", 0, 0);
  history.addChild(target);
  gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  gui.requestJump("chat", target);
  const page = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  expect(page.jump?.top).toBeGreaterThan(0);
  const destination = gui.page("chat", { width: 30, top: page.jump!.top, height: 5, following: false });
  expect(destination.lines.join("\n")).toContain("jump destination");
  expect(destination.jump).toEqual(page.jump);
});

test("clicking Go to moves to the corresponding activity block", () => {
  class ToolExecutionComponent extends Text {
    args = {}; result = { content: [], isError: false }; isPartial = false;
    toolCallId = "call"; toolName = "read";
    setExpanded() {}
  }
  const first = new UserMessageComponent("first", 0, 0);
  const tool = new ToolExecutionComponent("activity target", 0, 0);
  const history = new Container(); history.addChild(first); history.addChild(tool);
  const source = new Container(); source.addChild(new Container()); source.addChild(new Container()); source.addChild(history);
  const index = new NativeContentIndex(source);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const theme = { fg: (_name: string, value: string) => value, style: (value: string) => value } as unknown as Theme;
  timestamps.label = () => "12:34";
  let gui: GuiDocuments;
  const turns: DocumentTurns = { clock: () => false, stripe: () => "off", background: () => false,
    separator: () => false, mix: () => ({}) as never, color: () => undefined, hovered: () => undefined,
    hover: () => {}, goTo: () => "clock", jump: (pane, source) => {
      const target = index.counterpart(source, pane);
      if (target) gui.requestJump(pane === "chat" ? "activity" : "chat", target);
    } };
  const make = (pane: "chat" | "activity") => new NativeDocument(source, pane, timestamps, () => theme, () => 0, () => true,
    () => {}, false, index, undefined, () => true, undefined, undefined, undefined, () => "text", undefined, turns);
  gui = new GuiDocuments({ chat: make("chat"), activity: make("activity") }, () => timestamps.beginFrame());
  const frame = gui.page("chat", { width: 40, top: 0, height: 20, following: false });
  const row = frame.lines.findIndex(line => line.includes("12:34"));
  const col = 2;
  expect(row).toBeGreaterThanOrEqual(0);
  expect(gui.mouse("chat", frame.frame, { type: "press", button: "left", x: col, y: row })).toBe(true);
  expect(gui.mouse("chat", frame.frame, { type: "release", button: "left", x: col, y: row })).toBe(true);
  const target = gui.page("activity", { width: 40, top: 0, height: 20, following: true });
  expect(target.jump).toBeDefined();
  expect(gui.page("activity", { width: 40, top: target.jump!.top, height: 20, following: false }).lines.join("\n")).toContain("activity target");
});

test("projects native documents into bounded independent row viewports", () => {
  const { gui } = setup();
  const chat = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  expect(chat.lines.join("\n")).toContain("hello");
  const row = chat.lines.findIndex(line => line.includes("hello"));
  expect(chat.selection[row].cells.map(cell => cell.text).join("")).toContain("hello");
  expect(chat.lines.length).toBeLessThanOrEqual(5);
  const activity = gui.page("activity", { width: 20, top: 0, height: 3, following: false });
  expect(activity.lines.join("\n")).not.toContain("hello");
  expect(() => gui.page("chat", { width: 1000, top: 0, height: 5, following: false })).toThrow();
  expect(() => gui.page("chat", { width: 30, top: 0, height: 1000, following: false })).toThrow();
  gui.dispose();
});

test("routes a complete click to the rendered native component and rejects stale frames", () => {
  const { gui, item } = setup();
  const frame = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  const row = frame.lines.findIndex(line => line.includes("hello"));
  expect(row).toBeGreaterThanOrEqual(0);
  expect(gui.mouse("chat", frame.frame, { type: "press", button: "left", x: 0, y: row })).toBe(true);
  expect(gui.mouse("chat", frame.frame, { type: "release", button: "left", x: 0, y: row, clickCount: 2 })).toBe(true);
  expect(item.events.map(event => event.type)).toEqual(["press", "release", "click"]);
  expect(item.events[2]?.clickCount).toBe(2);
  expect(gui.mouse("chat", frame.frame, { type: "press", button: "left", x: 0, y: row })).toBe(false);
  const old = frame.frame;
  gui.page("chat", { width: 30, top: 1, height: 5, following: false });
  expect(gui.mouse("chat", old, { type: "press", button: "left", x: 0, y: row })).toBe(false);
  expect(item.events).toHaveLength(3);
  gui.dispose();
});

test("cancelled captured release never synthesizes a click", () => {
  const { gui, item } = setup();
  const frame = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  const row = frame.lines.findIndex(line => line.includes("hello"));
  expect(gui.mouse("chat", frame.frame, { type: "press", button: "left", x: 0, y: row })).toBe(true);
  expect(gui.mouse("chat", frame.frame, { type: "release", button: "left", x: 0, y: row, cancel: true })).toBe(true);
  expect(item.events.map(event => event.type)).toEqual(["press", "release"]);
  gui.dispose();
});

test("pointer leaving the pane clears its hover without a press", () => {
  const hovered: number[] = [];
  const turns: DocumentTurns = { clock: () => false, stripe: () => "off", background: () => false,
    separator: () => false, mix: () => ({}) as never, color: () => undefined, hovered: () => undefined,
    hover: turn => hovered.push(turn), goTo: () => "off", jump: () => {} };
  const { gui, item } = setup(turns);
  const frame = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  const row = frame.lines.findIndex(line => line.includes("hello"));
  expect(gui.mouse("chat", frame.frame, { type: "move", button: "none", x: 0, y: row })).toBe(true);
  expect(gui.mouse("chat", frame.frame, { type: "move", button: "none", x: -1, y: -1 })).toBe(true);
  expect(gui.mouse("chat", frame.frame, { type: "move", button: "none", x: -2, y: -1 })).toBe(false);
  expect(item.events.map(event => event.type)).toEqual(["move"]);
  expect(hovered).toEqual([1, 0]);
});

test("releasing a captured pointer outside a pane ends the gesture without clicking", () => {
  const { gui, item } = setup();
  const frame = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  const row = frame.lines.findIndex(line => line.includes("hello"));
  expect(gui.mouse("chat", frame.frame, { type: "press", button: "left", x: 0, y: row })).toBe(true);
  expect(gui.mouse("chat", frame.frame, { type: "release", button: "left", x: -1, y: row })).toBe(true);
  expect(item.events.map(event => event.type)).toEqual(["press", "release"]);
  gui.dispose();
});
