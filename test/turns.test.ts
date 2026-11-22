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

/** A turn's colors with the given layers under its marks, at the default mix. */
const layered = (turn: number, background: boolean, hover: boolean, terminal?: { r: number; g: number; b: number }) =>
  turnColor(theme, turn, terminal, DEFAULT_MIX, { background, hover })!;

test("neighbouring turns get different colors and blocks before the first turn get none", () => {
  expect(turnColor(theme, 0)).toBeUndefined();
  const colors = Array.from({ length: 16 }, (_, turn) => layered(turn + 1, true, false).fill);
  expect(new Set(colors).size).toBe(16);
  expect(turnColor(theme, 17)).toBe(turnColor(theme, 1));
  // Without a background or hover layer, a block keeps the terminal background.
  expect(turnColor(theme, 1)!.fill).toBeUndefined();
});

test("layers add up, so every mark stays visible over the layers under it", () => {
  const terminal = { r: 30, g: 30, b: 46 };
  const channels = (ansi: string): number[] => ansi.match(/[34]8;2;(\d+);(\d+);(\d+)m/)!.slice(1).map(Number);
  // How far a color has moved from the terminal background toward the turn's hue, as a share of the full hue.
  const full = turnColor(theme, 1, terminal, { clock: 100, stripe: 100, background: 100, hover: 100 })!;
  const reach = (ansi: string): number => {
    const [r, g, b] = channels(ansi);
    const [fr, fg, fb] = channels(backgroundAnsi(full.clock, "truecolor"));
    const axis = [fr - 30, fg - 30, fb - 46];
    const length = axis.reduce((sum, value) => sum + value * value, 0);
    return ([r - 30, g - 30, b - 46].reduce((sum, value, index) => sum + value * axis[index], 0) / length) * 100;
  };
  const clock = (color: ReturnType<typeof layered>): number => reach(backgroundAnsi(color.clock, "truecolor"));
  // Defaults: background 5%, hover 5%, clock 10%, stripe 8%.
  expect(reach(layered(1, true, false, terminal).fill!)).toBeCloseTo(5, -0.5);
  expect(reach(layered(1, false, true, terminal).fill!)).toBeCloseTo(5, -0.5);
  expect(reach(layered(1, true, true, terminal).fill!)).toBeCloseTo(10, -0.5);
  expect(clock(layered(1, false, false, terminal))).toBeCloseTo(10, -0.5);
  expect(clock(layered(1, true, false, terminal))).toBeCloseTo(15, -0.5);
  expect(clock(layered(1, true, true, terminal))).toBeCloseTo(20, -0.5);
  expect(reach(layered(1, true, true, terminal).stripe)).toBeCloseTo(18, -0.5);
  expect(reach(layered(1, true, true, terminal).line)).toBeCloseTo(18, -0.5);
  // A clock with the same share as the block under it is still darker than that block, never the same color.
  const even = turnColor(theme, 1, terminal, { clock: 15, stripe: 15, background: 15, hover: 15 }, { background: true, hover: true })!;
  expect(backgroundAnsi(even.clock, "truecolor")).not.toBe(even.fill);
  // Shares past the full hue stop there.
  expect(clock(turnColor(theme, 1, terminal, { clock: 90, stripe: 30, background: 60, hover: 60 }, { background: true, hover: true })!)).toBeCloseTo(100, -0.5);
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
    color: (turn, layers) => turnColor(theme, turn, undefined, DEFAULT_MIX, layers), hovered: () => state.hovered, hover: turn => state.reported.push(turn),
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
  // The first turn starts at the top and needs no rule; the second gets one in place of the blank row between blocks,
  // with no blank row on either side of it.
  expect(rules).toHaveLength(1);
  expect(plain[rules[0] - 1].trim()).not.toBe("");
  expect(plain[rules[0] + 1].trim()).not.toBe("");
  expect(plain.slice(rules[0]).join("\n")).toMatch(/^─+\n.*SECOND/);
  // Without the separator, the same blocks are one blank row apart: the rule replaces that row.
  state.marks = { ...state.marks, separator: false };
  document.beginFrame();
  expect(document.render(20).length).toBe(plain.length);
  state.marks = { ...state.marks, separator: true };
  expect(plain.slice(0, rules[0]).join("\n")).toContain("FIRST");
  state.marks = { ...state.marks, stripe: "block", background: true };
  document.beginFrame();
  const rows = document.render(20);
  const ruleRow = rows.findIndex(row => stripTerminalSequences(row).endsWith("─".repeat(19)));
  const rule = rows[ruleRow];
  // The stripe runs on through the rule in the turn's color, without the layers of the zone below.
  expect(rule.startsWith(layered(2, false, false).stripe)).toBe(true);
  expect(rule).toContain(layered(2, false, false).line);
  // The rule and the row above it stay as they are when the lower turn is hovered: neither its background nor hover reaches them,
  // not even through the stripe, while the row right below the rule already has the turn's layers.
  state.hovered = 2;
  document.beginFrame();
  const hovered = document.render(20);
  const fill = layered(2, true, true).fill!;
  expect(hovered[ruleRow - 1]).toBe(rows[ruleRow - 1]);
  expect(hovered[ruleRow]).toBe(rows[ruleRow]);
  expect(hovered[ruleRow + 1]).toContain(fill);
  expect(hovered[ruleRow + 1].startsWith(layered(2, true, true).stripe)).toBe(true);
  // Symmetric around the rule: the row above it closes the upper turn as the one below opens the lower turn.
  state.hovered = 1;
  document.beginFrame();
  const upper = document.render(20);
  expect(upper[ruleRow - 1]).toContain(layered(1, true, true).fill!);
  expect(upper[ruleRow - 1].startsWith(layered(1, true, true).stripe)).toBe(true);
  expect(upper[ruleRow]).toBe(rows[ruleRow]);
  expect(upper[ruleRow + 1]).toBe(rows[ruleRow + 1]);
  // The rows right above and below the rule belong to their turns; only the rule itself belongs to neither.
  state.reported.length = 0;
  for (const row of [ruleRow - 1, ruleRow, ruleRow + 1]) document.handleMouse(pointer("move", 5, row, 20));
  expect(state.reported).toEqual([1, 0, 2]);
});

test.each(["block", "line"] as const)("hovering a turn changes only the rows between its separators, with every mark on (%s stripe)", stripe => {
  for (const pane of ["chat", "activity"] as const) {
    const { document, state } = documentWith(pane, { clock: true, stripe, background: true, separator: true });
    document.beginFrame();
    const plain = document.render(30);
    const ruleRow = plain.findIndex(row => stripTerminalSequences(row).includes("─".repeat(20)));
    expect(ruleRow, pane).toBeGreaterThan(0);
    // The second turn's zone starts right below its rule; the first ends right above it.
    state.hovered = 2;
    document.beginFrame();
    const second = document.render(30);
    expect(second.slice(0, ruleRow + 1), pane).toEqual(plain.slice(0, ruleRow + 1));
    expect(second.slice(ruleRow + 1).every((row, index) => row !== plain[ruleRow + 1 + index]), pane).toBe(true);
    state.hovered = 1;
    document.beginFrame();
    const first = document.render(30);
    expect(first.slice(ruleRow), pane).toEqual(plain.slice(ruleRow));
    expect(first.slice(0, ruleRow).every((row, index) => row !== plain[index]), pane).toBe(true);
    state.hovered = undefined;
  }
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
  // Without turn backgrounds, the hovered turn gets the hover layer alone.
  expect(hovered[0].startsWith(layered(1, false, true).fill!)).toBe(true);
  expect(hovered.at(-1)!.includes("\x1b[48;2;")).toBe(false);
  state.hovered = undefined;
  state.marks = { ...state.marks, background: true };
  document.beginFrame();
  const filled = document.render(30);
  expect(filled[0].startsWith(layered(1, true, false).fill!)).toBe(true);
  expect(filled.at(-1)!.startsWith(layered(2, true, false).fill!)).toBe(true);
  // Over turn backgrounds, hover adds its layer on top of the background layer.
  state.hovered = 2;
  document.beginFrame();
  const both = document.render(30);
  expect(both[0].startsWith(layered(1, true, false).fill!)).toBe(true);
  expect(both.at(-1)!.startsWith(layered(2, true, true).fill!)).toBe(true);
  document.handleMouse(pointer("move", 2, 99, 30));
  expect(state.reported.at(-1)).toBe(0);
});

test("a clock takes its color over the layers of its block: the turn background and hover", () => {
  const { document, state, first, second } = documentWith("chat", { clock: true, background: true });
  const asked: { turn: number; background: boolean; hover: boolean }[] = [];
  const color = Reflect.get(document, "turns") as DocumentTurns;
  const original = color.color;
  color.color = (turn, layers) => { if (layers) asked.push({ turn, ...layers }); return original(turn, layers); };
  state.hovered = 2;
  document.beginFrame();
  document.render(30);
  const clockBackground = Reflect.get(document, "clockBackground") as (source: Component) => unknown;
  // The clocks of each turn are asked with that turn's layers.
  asked.length = 0;
  clockBackground.call(document, first);
  clockBackground.call(document, second);
  expect(asked).toEqual([{ turn: 1, background: true, hover: false }, { turn: 2, background: true, hover: true }]);
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
