import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.js";
import { NativeDocument } from "../src/native.js";
import { timestampLabel, TOOL_START_ENTRY, TranscriptTimestamps } from "../src/timestamps.js";

class ToolExecutionComponent extends Text {
  toolName = "fixture_tool";
  toolCallId: string;
  args: unknown;
  isPartial = true;
  result?: { content: { type: string; text: string }[]; isError: boolean };
  constructor(id: string, args: unknown) { super(`BODY-${id}`, 0, 0); this.toolCallId = id; this.args = args; }
  setExpanded(): void {}
}
class CustomEntryComponent extends Text {
  entry = { data: { parentToolCallId: "one" } };
}
class MouseRegion extends Container {}
class AssistantMessageComponent extends Container {
  contentContainer = new Container();
  hasToolCalls = true;
  lastMessage = { content: [{ type: "thinking", thinking: "REASONING-FIXTURE" }] };
  constructor() {
    super(); this.addChild(this.contentContainer);
    const thinking = new MouseRegion(); thinking.addChild(new Text("REASONING-FIXTURE", 0, 0));
    this.contentContainer.addChild(thinking);
  }
  setHideThinkingBlock(): void {}
}
const theme = { style: (text: string) => text, fg: (color: string, text: string) => `\x1b[${color === "success" ? 32 : color === "error" ? 31 : 33}m${text}\x1b[0m` } as unknown as Theme;
function setup(...components: Component[]) {
  const history = new Container(); history.children = components;
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const index = new NativeContentIndex(source);
  let compact = true;
  let copied: string | undefined;
  const starts = new Map<string, number>();
  let showTime = true;
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [...starts].map(([toolCallId, time]) => ({
    type: "custom", customType: TOOL_START_ENTRY, data: { toolCallId, time },
  })) } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => showTime,
    undefined, true, index, text => { copied = text; }, () => true, () => compact);
  const render = (width = 80) => { document.beginFrame(); return document.render(width).map(stripTerminalSequences); };
  const click = (y: number, width = 80, x = 5): void => {
    const event: TuiMouseEvent = { type: "click", button: "left", x, y, screenX: x, screenY: y,
      width, height: document.render(width).length, shift: false, alt: false, ctrl: false };
    document.handleMouse({ ...event, type: "press" });
    document.handleMouse(event);
  };
  return { history, index, document, render, click, starts, hideTime: () => { showTime = false; },
    toggle: () => { compact = !compact; }, copied: () => copied };
}

function complete(tool: ToolExecutionComponent, error = false): void {
  tool.isPartial = false;
  tool.result = { content: [{ type: "text", text: "RESULT-" + tool.toolCallId }], isError: error };
}

test("groups only equal states and exposes every failed call separately", () => {
  const calls = ["a", "b", "error-one", "error-two", "c", "d", "pending-one", "pending-two"]
    .map(id => new ToolExecutionComponent(id, { path: "ARG-" + id }));
  for (const call of calls.slice(0, 6)) complete(call, call.toolCallId.startsWith("error-"));
  const { render, click } = setup(...calls);
  const lines = render();
  expect(lines).toHaveLength(5);
  expect(lines[1]).toContain("ARG-error-one");
  expect(lines[2]).toContain("ARG-error-two");
  for (const call of [calls[0], calls[1], ...calls.slice(4)]) expect(lines.join("\n")).not.toContain("ARG-" + call.toolCallId);
  click(1);
  expect(render().join("\n")).toContain("BODY-error-one");
  expect(render().join("\n")).not.toContain("BODY-error-two");
});

test("state changes split open runs without hiding their members or selected original card", () => {
  const calls = ["one", "two", "three"].map(id => new ToolExecutionComponent(id, { path: "ARG-" + id }));
  const { render, click } = setup(...calls);
  render(); click(0);
  let lines = render();
  click(lines.findIndex(line => line.includes("ARG-three")));
  expect(render().join("\n")).toContain("BODY-three");
  complete(calls[0]);
  lines = render();
  expect(lines.join("\n")).toContain("ARG-one");
  expect(lines.join("\n")).toContain("ARG-two");
  expect(lines.join("\n")).toContain("BODY-three");
  complete(calls[1], true);
  expect(render().join("\n")).toContain("ARG-two");
  expect(render().join("\n")).toContain("BODY-three");
});

test("state changes do not reopen explicitly collapsed runs with remembered open cards", () => {
  const calls = ["one", "two", "three"].map(id => new ToolExecutionComponent(id, { path: "ARG-" + id }));
  const { render, click, history } = setup(...calls);
  render(); click(0);
  click(render().findIndex(line => line.includes("ARG-three")));
  render(); click(0);
  complete(calls[0]);
  let lines = render();
  expect(lines).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("ARG-three");
  expect(lines.join("\n")).not.toContain("BODY-three");
  click(1);
  expect(render().join("\n")).toContain("BODY-three");
  click(1);
  history.addChild(new ToolExecutionComponent("four", { path: "ARG-four" }));
  lines = render();
  expect(lines).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("BODY-three");
});
test("a collapsed suffix stays collapsed when completion merges it under a former head", () => {
  const calls = ["one", "two", "three"].map(id => new ToolExecutionComponent(id, { path: "ARG-" + id }));
  const { render, click } = setup(...calls);
  render(); click(0);
  click(render().findIndex(line => line.includes("ARG-two")));
  expect(render().join("\n")).toContain("BODY-two");
  complete(calls[0]);
  expect(render().join("\n")).toContain("BODY-two");
  click(1);
  expect(render().join("\n")).not.toContain("BODY-two");
  complete(calls[1]);
  const lines = render();
  expect(lines).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("ARG-two");
  expect(lines.join("\n")).not.toContain("BODY-two");
  click(0);
  expect(render().join("\n")).toContain("BODY-two");
});
test("an expanded singleton stays visible when an adjacent call creates its group", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { path: "SECOND-FIXTURE" });
  const { render, click, history } = setup(one);
  render(); click(0);
  expect(render().join("\n")).toContain("BODY-one");
  history.addChild(two);
  let lines = render();
  expect(lines.join("\n")).toContain("BODY-one");
  expect(lines.join("\n")).toContain("SECOND-FIXTURE");
  expect(lines.join("\n")).not.toContain("BODY-two");
  click(0);
  expect(render().join("\n")).not.toContain("BODY-one");
  click(0); lines = render();
  expect(lines.join("\n")).toContain("BODY-one");
  expect(lines.join("\n")).not.toContain("BODY-two");
});
test("adjacent calls form a group, with reasoning separating runs and each member still accessible", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { command: "SECOND-FIXTURE" });
  const three = new ToolExecutionComponent("three", { query: "THIRD-FIXTURE" });
  const { render, click } = setup(one, two, new AssistantMessageComponent(), three);
  let lines = render();
  expect(lines.filter(line => line.includes(one.toolName))).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("FIRST-FIXTURE");
  expect(lines.join("\n")).not.toContain("SECOND-FIXTURE");
  click(0);
  lines = render();
  expect(lines.filter(line => line.includes(one.toolName))).toHaveLength(4);
  const first = lines.findIndex(line => line.includes("FIRST-FIXTURE"));
  expect(lines[first + 1]).toContain("SECOND-FIXTURE");
  const reasoning = lines.findIndex(line => line.includes("REASONING-FIXTURE"));
  expect(reasoning).toBeGreaterThan(first + 1);
  expect(lines.findIndex(line => line.includes("THIRD-FIXTURE"))).toBeGreaterThan(reasoning);
  expect(lines.join("\n")).not.toContain("BODY-");
});

test("compact rows keep one left cell while calls stream and panels narrow", () => {
  const tool = new ToolExecutionComponent("gutter", { command: "GUTTER-FIXTURE " + "界".repeat(60) });
  const { render } = setup(tool);
  for (const final of [false, true]) {
    tool.isPartial = !final;
    tool.result = { content: [{ type: "text", text: "RESULT-FIXTURE" }], isError: false };
    for (const width of [0, 1, 2, 24, 40, 80]) {
      const lines = render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
      if (width === 0) expect(lines[0]).toBe("");
      else {
        expect(lines[0][0]).toBe(" ");
        if (width > 1) expect(lines[0][1]).not.toBe(" ");
      }
    }
  }
});
test("partial and final results update status and arguments on the same row", () => {
  const tool = new ToolExecutionComponent("one", { path: "BEFORE-FIXTURE" });
  const { document, render, index } = setup(tool);
  const pending = document.render(80)[0];
  tool.result = { content: [{ type: "text", text: "RESULT-FIXTURE" }], isError: false };
  const partial = document.render(80)[0];
  expect(partial).toBe(pending);
  tool.isPartial = false;
  const success = document.render(80)[0];
  expect(success).not.toBe(pending);
  tool.result.isError = true;
  const error = document.render(80)[0];
  expect(error).not.toBe(success);
  expect(error).not.toBe(pending);
  tool.args = { path: "AFTER-FIXTURE" };
  expect(render()).toHaveLength(1);
  expect(render()[0]).toContain("AFTER-FIXTURE");
  expect(index.entries("activity")).toHaveLength(1);
});

test("compact mode hides linked output but preserves full search, copy and normal rendering", () => {
  const tool = new ToolExecutionComponent("one", { path: "PATH-FIXTURE" });
  tool.result = { content: [{ type: "text", text: "SAVED-FIXTURE" }], isError: false };
  const linked = new CustomEntryComponent("LATE-FIXTURE", 0, 0);
  const { render, document, toggle, copied } = setup(tool, linked);
  expect(render()).toHaveLength(1);
  expect(render().join("\n")).not.toContain("LATE-FIXTURE");
  expect(document.searchEntries().map(entry => entry.text).join("\n")).toContain("SAVED-FIXTURE");
  expect(document.searchEntries().map(entry => entry.text).join("\n")).toContain("LATE-FIXTURE");
  document.copyBlocks()[0].copy();
  expect(copied()).toContain("SAVED-FIXTURE");
  expect(copied()).toContain("LATE-FIXTURE");
  toggle();
  expect(render().join("\n")).toContain("BODY-one");
  expect(render().join("\n")).toContain("LATE-FIXTURE");
  toggle(); expect(render()).toHaveLength(1);
});

test("query tools describe their query and scope; custom inputs use bounded previews", () => {
  const search = new ToolExecutionComponent("query", { path: ".", query: "QUERY-FIXTURE" });
  const custom = new ToolExecutionComponent("custom", { task: "CUSTOM-FIXTURE", payload: { secret: "BODY-FIXTURE" } });
  custom.toolName = "custom_fixture";
  const { render } = setup(search, custom);
  expect(render()[0]).toContain("QUERY-FIXTURE");
  expect(render()[1]).toContain("CUSTOM-FIXTURE");
  expect(render()[1]).not.toContain("BODY-FIXTURE");
});
test("narrow rows truncate wide and multiline arguments without extra rows or terminal escapes", () => {
  const tool = new ToolExecutionComponent("one", { path: "界".repeat(60) + "\n\x1b[31mSUFFIX-FIXTURE" });
  const { document } = setup(tool);
  for (const width of [1, 2, 8, 24, 50]) {
    const lines = document.render(width);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
    expect(stripTerminalSequences(lines[0])).not.toContain("\n");
    expect(stripTerminalSequences(lines[0])).not.toContain("SUFFIX-FIXTURE");
  }
});

class UserMessageComponent extends Text {}

test("visible Conversation content and different tool identities break Activity runs", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { path: "SECOND-FIXTURE" });
  const other = new ToolExecutionComponent("other", { path: "OTHER-FIXTURE" });
  other.toolName = "another_fixture_tool";
  const three = new ToolExecutionComponent("three", { path: "THIRD-FIXTURE" });
  const { render } = setup(one, new UserMessageComponent("USER-FIXTURE", 0, 0), two, other, three);
  const lines = render();
  expect(lines).toHaveLength(4);
  for (const value of ["FIRST-FIXTURE", "SECOND-FIXTURE", "OTHER-FIXTURE", "THIRD-FIXTURE"]) {
    expect(lines.filter(line => line.includes(value))).toHaveLength(1);
  }
});
test("search reveals a hidden member and maps result times to the native body, not its compact clock", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { path: "SECOND-FIXTURE" });
  const { render, document, starts } = setup(one, two);
  const time = Date.UTC(2025, 0, 1, 3, 4, 5);
  starts.set(one.toolCallId, time - 1000); starts.set(two.toolCallId, time);
  const saved = timestampLabel(time);
  two.setText("BODY-START-FIXTURE\n" + saved);
  two.result = { content: [{ type: "text", text: "BODY-START-FIXTURE\n" + saved }], isError: false };
  expect(render()).toHaveLength(1);
  const entry = document.searchEntries().find(entry => entry.source === two)!;
  const hit = { entry, text: saved, line: entry.text.split("\n").indexOf(saved) };
  expect(document.reveal(hit)).toBe(true);
  const lines = render();
  expect(lines.join("\n")).toContain("SECOND-FIXTURE");
  const bodyRow = lines.findIndex(line => line.trimEnd().endsWith(saved));
  expect(bodyRow).toBeGreaterThan(0);
  expect(document.searchRow(hit)).toBe(bodyRow);
  document.clearSearch();
  expect(render()).toHaveLength(1);
});
test("saved punctuation searches skip hierarchy guides on preceding native rows", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { path: "SECOND-FIXTURE" });
  const saved = "│";
  const body = "BEGIN-FIXTURE\n" + saved + "\nEND-FIXTURE";
  two.setText(body);
  two.result = { content: [{ type: "text", text: body }], isError: false };
  const { render, document } = setup(one, two);
  render();
  const entry = document.searchEntries().find(entry => entry.source === two)!;
  const hit = { entry, text: saved, line: entry.text.split("\n").indexOf(saved) };
  expect(hit.line).toBeGreaterThanOrEqual(0);
  expect(document.reveal(hit)).toBe(true);
  const lines = render();
  const first = lines.findIndex(line => line.includes("BEGIN-FIXTURE"));
  expect(first).toBeGreaterThan(0);
  expect(document.searchRow(hit)).toBe(first + 1);
});
test("compact clocks use the first original start for a group and each start for its members", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { path: "SECOND-FIXTURE" });
  const { render, click, starts, hideTime } = setup(one, two);
  const first = Date.UTC(2025, 0, 1, 3, 4, 5);
  const second = first + 17_000;
  starts.set(one.toolCallId, first); starts.set(two.toolCallId, second);
  expect(render()).toHaveLength(1);
  expect(render()[0]).toContain(timestampLabel(first));
  expect(render()[0]).not.toContain(timestampLabel(second));
  click(0);
  let lines = render();
  expect(lines.find(line => line.includes("FIRST-FIXTURE"))).toContain(timestampLabel(first));
  expect(lines.find(line => line.includes("SECOND-FIXTURE"))).toContain(timestampLabel(second));
  hideTime(); lines = render();
  expect(lines.join("\n")).not.toContain(timestampLabel(first));
  expect(lines.join("\n")).not.toContain(timestampLabel(second));
});

test("nested original cards negotiate their width and retain native pointer coordinates", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { path: "SECOND-FIXTURE" });
  const linked = new CustomEntryComponent("LATE-FIXTURE", 0, 0);
  let nativeWidth = 0;
  const paint = one.render.bind(one);
  one.render = width => { nativeWidth = width; return paint(width); };
  const points: { x: number; width: number }[] = [];
  (one as Component).handleMouse = event => {
    if (event.type === "click") points.push({ x: event.x, width: event.width });
    return { handled: true };
  };
  const { render, click } = setup(one, two, linked);
  render(); click(0);
  click(render().findIndex(line => line.includes("FIRST-FIXTURE")));
  const lines = render();
  expect(nativeWidth).toBeGreaterThan(0);
  expect(nativeWidth).toBeLessThan(80);
  const bodyRow = lines.findIndex(line => line.includes("BODY-one"));
  const bodyColumn = lines[bodyRow].indexOf("BODY-one");
  const linkedRow = lines.findIndex(line => line.includes("LATE-FIXTURE"));
  expect(lines[linkedRow].indexOf("LATE-FIXTURE")).toBe(bodyColumn);
  click(bodyRow, 80, bodyColumn + 3);
  expect(points).toEqual([{ x: 3, width: nativeWidth }]);
  click(bodyRow, 80, bodyColumn - 1);
  expect(points).toHaveLength(1);
  for (const width of [0, 1, 2, 3, 4, 8, 24, 40, 80]) {
    for (const line of render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});
test("group and member expansion are independent and survive new calls, resizing and closing the group", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { path: "SECOND-FIXTURE" });
  const linked = new CustomEntryComponent("LATE-FIXTURE", 0, 0);
  const { render, click, history } = setup(one, two, linked);
  expect(render()).toHaveLength(1);
  click(0); let lines = render();
  click(lines.findIndex(line => line.includes("FIRST-FIXTURE")));
  lines = render();
  expect(lines.join("\n")).toContain("BODY-one");
  expect(lines.join("\n")).toContain("LATE-FIXTURE");
  expect(lines.join("\n")).not.toContain("BODY-two");
  expect(render()[0]).toContain(String(2));
  history.addChild(new ToolExecutionComponent("three", { path: "THIRD-FIXTURE" }));
  expect(render()[0]).toContain(String(3));
  for (const width of [40, 80]) {
    const frame = render(width).join("\n");
    expect(frame).toContain("BODY-one"); expect(frame).toContain("THIRD-FIXTURE");
    expect(frame).not.toContain("BODY-two");
  }
  click(0); expect(render()).toHaveLength(1);
  click(0); expect(render().join("\n")).toContain("BODY-one");
  lines = render(); click(lines.findIndex(line => line.includes("FIRST-FIXTURE")));
  expect(render().join("\n")).not.toContain("BODY-one");
  expect(render().join("\n")).not.toContain("LATE-FIXTURE");
});