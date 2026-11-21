import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, Container, rgbColor, stripTerminalSequences, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { turnColor, decorateLine, decorateLines, DEFAULT_MIX, pointerMotionAvailable } from "../src/turns.ts";
import { NativeContentIndex } from "../src/content.ts";
import { CompactTool } from "../src/compact-tools.ts";
import { NativeDocument, type DocumentTurns } from "../src/native.ts";
import type { TurnStripe, GoTo } from "../src/preferences.ts";
import { CompactMessage, TranscriptTimestamps } from "../src/timestamps.ts";

class UserMessageComponent extends Text {
  constructor(text: string) { super(text, 0, 0); }
}
class CustomMessageComponent extends Text {
  message = { content: "BACKGROUND RESULT" };
}
class ToolExecutionComponent extends Text {
  args = {};
  result = { content: [], isError: false };
  isPartial = false;
  constructor(readonly toolCallId: string, readonly toolName = "read") { super(toolName + " " + toolCallId, 0, 0); }
  setExpanded(): void {}
}
class Markdown extends Text {}
class AssistantMessageComponent extends Container {
  contentContainer = new Container();
  hasToolCalls = true;
  lastMessage: { content: { type: string; text?: string }[] };
  constructor(text: string) {
    super();
    this.lastMessage = { content: [{ type: "text", text }] };
    this.addChild(this.contentContainer);
    this.contentContainer.addChild(new Markdown(text, 0, 0));
  }
  setHideThinkingBlock(): void {}
}

const BG = "\x1b[48;2;1;2;3m";
const theme = {
  fg: (_color: string, text: string) => text,
  style: (text: string, style: { bg?: unknown }) => style.bg ? "\x1b[48;2;9;9;9m" + text + "\x1b[49m" : text,
  colors: { userMessageBg: rgbColor(52, 53, 65) },
  appearance: "dark",
  getColorMode: () => "truecolor",
} as unknown as Theme;

function history(...children: Component[]): { source: Container; index: NativeContentIndex } {
  const source = new Container();
  source.addChild(new Container());
  source.addChild(new Container());
  const chat = new Container();
  for (const child of children) chat.addChild(child);
  source.addChild(chat);
  return { source, index: new NativeContentIndex(source) };
}

const pointer = (type: TuiMouseEvent["type"], x: number, y: number, width = 40): TuiMouseEvent =>
  ({ type, button: type === "move" ? "none" : "left", x, y, width, height: 20, screenX: x, screenY: y } as unknown as TuiMouseEvent);

test("turns start at user and custom messages; consecutive messages without work share one", () => {
  const welcome = new Text("WELCOME", 0, 0);
  const first = new UserMessageComponent("FIRST");
  const reply = new AssistantMessageComponent("ON IT");
  const call = new ToolExecutionComponent("call-1");
  const queued = new UserMessageComponent("QUEUED");
  const custom = new CustomMessageComponent("RESULT", 0, 0);
  const second = new ToolExecutionComponent("call-2");
  const { index } = history(welcome, first, reply, call, queued, custom, second);
  expect([welcome, first, reply, call, queued, custom, second].map(block => index.turn(block))).toEqual([0, 1, 1, 1, 2, 2, 2]);
});

test("Go to finds the same point of history in the other panel", () => {
  const first = new UserMessageComponent("FIRST");
  const call = new ToolExecutionComponent("call-1");
  const reply = new AssistantMessageComponent("DONE");
  const later = new ToolExecutionComponent("call-2");
  const second = new UserMessageComponent("SECOND");
  const { index } = history(first, call, reply, later, second);
  // From Activity: the last Conversation block before it.
  expect(index.counterpart(call, "activity")).toBe(first);
  expect(index.counterpart(later, "activity")).toBe(reply);
  // From Conversation: the first Activity block after it, or the nearest one before when nothing follows.
  expect(index.counterpart(first, "chat")).toBe(call);
  expect(index.counterpart(reply, "chat")).toBe(later);
  expect(index.counterpart(second, "chat")).toBe(later);
});

test("tinting keeps native backgrounds, restores the turn color after every reset and keeps shell zones first", () => {
  const native = "plain \x1b[48;5;236mnative\x1b[0m after \x1b[38;5;0mfg\x1b[39m \x1b[48;2;1;1;1;1mx\x1b[49m end";
  expect(decorateLine(native, BG)).toBe(BG + "plain \x1b[48;5;236mnative\x1b[0m" + BG +
    " after \x1b[38;5;0mfg\x1b[39m \x1b[48;2;1;1;1;1mx\x1b[49m" + BG + " end");
  const zone = "\x1b]133;A\x07";
  expect(decorateLine(zone + "prompt", BG, "|")).toBe(zone + "|" + BG + "prompt");
  const image = "\x1b_Ga=T;data\x1b\\";
  expect(decorateLine(image, BG)).toBe(image);
  const rows = ["a", "b"];
  expect(decorateLines(rows, BG)).toBe(decorateLines(rows, BG));
  expect(decorateLines(rows, undefined)).toBe(rows);
  // A renderer that mutates and returns the same array must not get stale rows.
  rows[1] = "changed";
  expect(decorateLines(rows, BG)).toEqual([BG + "a", BG + "changed"]);
});

test("neighbouring turns get different colors and blocks before the first turn get none", () => {
  expect(turnColor(theme, 0)).toBeUndefined();
  const colors = Array.from({ length: 16 }, (_, turn) => turnColor(theme, turn + 1)!.fill);
  expect(new Set(colors).size).toBe(16);
  expect(turnColor(theme, 17)).toBe(turnColor(theme, 1));
});

test("default turn backgrounds stay a faint shift from the terminal background", () => {
  const terminal = { r: 30, g: 30, b: 46 };
  const channels = (ansi: string): number[] => ansi.match(/48;2;(\d+);(\d+);(\d+)m/)!.slice(1).map(Number);
  for (let turn = 1; turn <= 16; turn++) {
    const color = turnColor(theme, turn, terminal)!;
    // By default backgrounds take 8% of the way from the background to a full hue, hover and clocks 15%.
    for (const [ansi, limit] of [[color.fill, 21], [color.hover, 39], [backgroundAnsi(color.clock, "truecolor"), 39]] as const) {
      const shift = Math.max(...channels(ansi).map((value, index) => Math.abs(value - [30, 30, 46][index])));
      expect(shift, ansi).toBeLessThanOrEqual(limit);
      expect(shift, ansi).toBeGreaterThan(0);
    }
  }
});

test("each mark mixes its own share of the turn hue, and a new mix rebuilds the palette", () => {
  const terminal = { r: 30, g: 30, b: 46 };
  const channels = (ansi: string): number[] => ansi.match(/[34]8;2;(\d+);(\d+);(\d+)m/)!.slice(1).map(Number);
  const shift = (ansi: string): number => Math.max(...channels(ansi).map((value, index) => Math.abs(value - [30, 30, 46][index])));
  const full = turnColor(theme, 1, terminal, { clock: 100, stripe: 100, background: 100, hover: 100 })!;
  const half = turnColor(theme, 1, terminal, { clock: 50, stripe: 50, background: 20, hover: 40 })!;
  expect(shift(half.line)).toBeCloseTo(shift(full.line) / 2, -1);
  expect(shift(backgroundAnsi(half.clock, "truecolor"))).toBeCloseTo(shift(full.fill) / 2, -1);
  expect(shift(half.fill)).toBeCloseTo(shift(full.fill) / 5, -1);
  expect(shift(half.hover)).toBeCloseTo(shift(full.hover) * 2 / 5, -1);
});

test("hover is unavailable in terminal multiplexers and without Pi's mouse support", () => {
  expect(pointerMotionAvailable(undefined, { TERM: "xterm-256color" })).toBe(true);
  for (const env of [{ TMUX: "/tmp/tmux" }, { ZELLIJ: "0" }, { STY: "1.pts" }, { TERM: "screen-256color" }, { TERM: "tmux-256color" }]) {
    expect(pointerMotionAvailable(undefined, env)).toBe(false);
  }
  expect(pointerMotionAvailable({ mouseEnabled: false } as never, { TERM: "xterm" })).toBe(false);
});

interface Marks { clock: boolean; stripe: TurnStripe; background: boolean; separator: boolean }

function documentWith(pane: "chat" | "activity", marks: Partial<Marks>, goTo: GoTo = "clock") {
  const first = new UserMessageComponent("FIRST");
  const call = new ToolExecutionComponent("call-1");
  const second = new UserMessageComponent("SECOND");
  const later = new ToolExecutionComponent("call-2");
  const { source, index } = history(first, call, second, later);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const state = {
    marks: { clock: false, stripe: "off", background: false, separator: false, ...marks } as Marks,
    hovered: undefined as number | undefined, reported: [] as number[], jumps: [] as Component[], goTo,
  };
  const turns: DocumentTurns = {
    clock: () => state.marks.clock, stripe: () => state.marks.stripe, background: () => state.marks.background, separator: () => state.marks.separator,
    mix: () => DEFAULT_MIX,
    color: turn => turnColor(theme, turn), hovered: () => state.hovered, hover: turn => state.reported.push(turn),
    goTo: () => state.goTo, jump: (_from, block) => state.jumps.push(block),
  };
  const document = new NativeDocument(source, pane, timestamps, () => theme, () => 0, () => false, () => {}, true, index,
    undefined, () => true, undefined, undefined, undefined, () => "text", undefined, turns);
  return { document, state, first, call, second, later };
}

test("a block stripe keeps native rows beside it and translates the pointer", () => {
  const { document, state } = documentWith("chat", { stripe: "block" });
  document.beginFrame();
  const rows = document.render(20);
  const stripes = rows.filter(row => row.startsWith("\x1b[48;2;")).length;
  expect(stripes).toBe(rows.length);
  expect(rows.map(stripTerminalSequences).map(row => row.slice(1)).join("\n")).toMatch(/FIRST[\s\S]*SECOND/);
  expect(turnColor(theme, 1)!.stripe).not.toBe(turnColor(theme, 2)!.stripe);
  expect(rows[0].startsWith(turnColor(theme, 1)!.stripe)).toBe(true);
  expect(rows.at(-1)!.startsWith(turnColor(theme, 2)!.stripe)).toBe(true);
  // Native rows render one column narrower, beside the stripe.
  document.handleMouse(pointer("move", 0, 0, 20));
  expect(state.reported).toEqual([1]);
});

test("a line stripe draws a thin line in the turn's color beside every row", () => {
  const { document } = documentWith("chat", { stripe: "line" });
  document.beginFrame();
  const rows = document.render(20);
  expect(rows.every(row => stripTerminalSequences(row).startsWith("│"))).toBe(true);
  expect(rows[0].startsWith(turnColor(theme, 1)!.line)).toBe(true);
  expect(rows.at(-1)!.startsWith(turnColor(theme, 2)!.line)).toBe(true);
});

test("a separator rule marks where each later turn starts, combined with other marks", () => {
  const { document, state } = documentWith("chat", { separator: true });
  document.beginFrame();
  const plain = document.render(20).map(stripTerminalSequences);
  const rules = plain.flatMap((row, index) => row === "─".repeat(20) ? [index] : []);
  // The first turn starts at the top and needs no rule; the second gets one, between blank rows, above its message.
  expect(rules).toHaveLength(1);
  expect(plain[rules[0] - 1].trim()).toBe("");
  expect(plain.slice(rules[0]).join("\n")).toMatch(/^─+\n\s*\n[\s\S]*SECOND/);
  expect(plain.slice(0, rules[0]).join("\n")).toContain("FIRST");
  state.marks = { ...state.marks, stripe: "block", background: true };
  document.beginFrame();
  const rows = document.render(20);
  const rule = rows.find(row => stripTerminalSequences(row).endsWith("─".repeat(19)))!;
  expect(rule.startsWith(turnColor(theme, 2)!.stripe)).toBe(true);
  expect(rule).toContain(turnColor(theme, 2)!.line);
});

test("turn backgrounds tint default cells of each turn and hover tints the turn under the pointer", () => {
  const { document, state } = documentWith("activity", {});
  document.beginFrame();
  const plain = document.render(30);
  expect(plain.some(row => row.includes("\x1b[48;2;"))).toBe(false);
  document.handleMouse(pointer("move", 2, 0, 30));
  expect(state.reported).toEqual([1]);
  state.hovered = 1;
  document.beginFrame();
  const hovered = document.render(30);
  // Hover tints the turn under the pointer with its own strength, with or without turn backgrounds.
  expect(hovered[0].startsWith(turnColor(theme, 1)!.hover)).toBe(true);
  expect(hovered.at(-1)!.includes(turnColor(theme, 2)!.hover)).toBe(false);
  state.hovered = undefined;
  state.marks = { ...state.marks, background: true };
  document.beginFrame();
  const filled = document.render(30);
  expect(filled[0].startsWith(turnColor(theme, 1)!.fill)).toBe(true);
  expect(filled.at(-1)!.startsWith(turnColor(theme, 2)!.fill)).toBe(true);
  // Over turn backgrounds, the hovered turn takes the hover tint in place of its background.
  state.hovered = 2;
  document.beginFrame();
  const both = document.render(30);
  expect(both[0].startsWith(turnColor(theme, 1)!.fill)).toBe(true);
  expect(both.at(-1)!.startsWith(turnColor(theme, 2)!.hover)).toBe(true);
  document.handleMouse(pointer("move", 2, 99, 30));
  expect(state.reported.at(-1)).toBe(0);
});

test("a timed block opens the other panel from its clock or its Go to button", () => {
  let goTo: GoTo = "clock";
  let jumps = 0;
  const native: Component = { render: () => ["body"], invalidate() {} };
  const block = new CompactMessage(native, () => "12:34:56", () => theme, () => 0, () => true, () => {}, () => true, () => "text",
    undefined, () => rgbColor(1, 2, 3), { clock: () => goTo === "clock" || goTo === "both", button: () => goTo !== "clock" && goTo !== "off", go: () => { jumps++; } });
  try {
    expect(block.render(40)[0]).toContain("\x1b[48;2;9;9;9m12:34:56");
    expect(block.handleMouse(pointer("press", 3, 0))).toMatchObject({ capture: true });
    block.handleMouse(pointer("release", 3, 0));
    block.handleMouse(pointer("click", 3, 0));
    expect(jumps).toBe(1);
    goTo = "button";
    block.invalidate();
    const rows = block.render(40).map(stripTerminalSequences);
    expect(rows.at(-1)).toBe(" ".repeat(26) + "[Go to] [Copy]");
    block.handleMouse(pointer("click", 3, 0));
    expect(jumps).toBe(1);
    block.handleMouse(pointer("press", 27, rows.length - 1));
    block.handleMouse(pointer("click", 27, rows.length - 1));
    expect(jumps).toBe(2);
  } finally { block.dispose(); }
});

test("a compact row's clock opens the other panel; the rest of the row still toggles it", () => {
  let toggles = 0;
  let jumps = 0;
  const row = new CompactTool(() => ({ name: "read", args: { path: "file" }, status: "success" }), () => theme, {
    clock: () => "12:34:56", clockBackground: () => rgbColor(1, 2, 3), clockAction: () => () => { jumps++; },
    expanded: () => false, toggle: () => { toggles++; },
  });
  expect(row.render(40)[0]).toContain("\x1b[48;2;9;9;9m12:34:56");
  row.handleMouse(pointer("press", 2, 0));
  row.handleMouse(pointer("click", 2, 0));
  row.handleMouse(pointer("press", 20, 0));
  row.handleMouse(pointer("click", 20, 0));
  expect({ jumps, toggles }).toEqual({ jumps: 1, toggles: 1 });
});

test("locating a block measures the whole panel", () => {
  const { document, second, later } = documentWith("chat", {});
  document.beginFrame();
  const rows = document.render(30).map(stripTerminalSequences);
  expect(rows[document.locate(second)!]).toContain("SECOND");
  expect(document.locate(later)).toBeUndefined();
});

test("locating a block outside a frame reads clock colors without classifying the history per row", async () => {
  const calls = Array.from({ length: 40 }, (_, call) => new ToolExecutionComponent("call-" + call));
  const { source, index } = history(new UserMessageComponent("FIRST"), ...calls);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const turns: DocumentTurns = {
    clock: () => true, stripe: () => "off", background: () => false, separator: () => false, mix: () => DEFAULT_MIX,
    color: turn => turnColor(theme, turn), hovered: () => undefined, hover: () => {},
    goTo: () => "clock", jump: () => {},
  };
  const document = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => false, () => {}, true, index,
    undefined, () => true, () => ({ compact: true, group: false }), undefined, undefined, () => "text", undefined, turns);
  document.beginFrame();
  document.render(40);
  // The frame's shared verification ends in the next microtask; a click arrives after it.
  await Promise.resolve();
  const entries = index.entries.bind(index);
  let reads = 0;
  index.entries = pane => { reads++; return entries(pane); };
  expect(document.locate(calls[30])).toBeDefined();
  // Every read outside a frame verifies the whole history, so the count must not grow with the number of rows.
  expect(reads).toBeLessThan(10);
});
