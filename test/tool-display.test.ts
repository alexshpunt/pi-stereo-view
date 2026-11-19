import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { NativeContentIndex } from "../src/content.ts";
import { NativeDocument, type ToolDisplay } from "../src/native.ts";
import { NestedCalls } from "../src/nested-calls.ts";
import { timestampLabel, TOOL_START_ENTRY, TranscriptTimestamps } from "../src/timestamps.ts";

class ToolExecutionComponent extends Text {
  toolName = "fixture_tool";
  toolCallId: string;
  args: unknown;
  isPartial = false;
  result?: { content: { type: string; text: string }[]; isError: boolean } = { content: [], isError: false };
  constructor(id: string) { super(`BODY-${id}`, 0, 0); this.toolCallId = id; this.args = { path: "ARG-" + id }; }
  setExpanded(): void {}
}
class CustomEntryComponent extends Text {
  entry = { data: { parentToolCallId: "one" } };
}
const theme = { style: (text: string) => text, fg: (_color: string, text: string) => text } as unknown as Theme;
const first = Date.UTC(2025, 0, 1, 3, 4, 5);

function setup(display: ToolDisplay, ...components: Component[]) {
  return setupWith(new NestedCalls(), display, ...components);
}
function setupWith(calls: NestedCalls, display: ToolDisplay, ...components: Component[]) {
  const history = new Container(); history.children = components;
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => components
    .filter(component => component instanceof ToolExecutionComponent)
    .map((call, index) => ({ type: "custom", customType: TOOL_START_ENTRY, data: { toolCallId: call.toolCallId, time: first + index * 1000 } })),
  } as unknown as ExtensionContext["sessionManager"]);
  const changed = vi.fn();
  const document = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => true,
    undefined, true, new NativeContentIndex(source, calls), undefined, () => false, () => display, undefined, undefined, undefined,
    { enabled: () => true, delay: () => 1000, changed });
  const render = (width = 80) => { document.beginFrame(); return document.render(width).map(stripTerminalSequences); };
  const click = (y: number): void => {
    const lines = render();
    const event: TuiMouseEvent = { type: "click", button: "left", x: 3, y, screenX: 3, screenY: y,
      width: 80, height: lines.length, shift: false, alt: false, ctrl: false };
    document.handleMouse({ ...event, type: "press" });
    document.handleMouse(event);
  };
  return { history, document, render, click, changed, show: (next: ToolDisplay) => { display = next; } };
}
const calls = () => ["one", "two", "three"].map(id => new ToolExecutionComponent(id));
const count = (lines: string[], text: string) => lines.filter(line => line.includes(text)).length;

afterEach(() => { vi.useRealTimers(); });

test("without compact rows or groups, Activity shows every original card", () => {
  const { render } = setup({ compact: false, group: false }, ...calls(), new CustomEntryComponent("LATE-FIXTURE", 0, 0));
  const lines = render();
  for (const marker of ["BODY-one", "BODY-two", "BODY-three", "LATE-FIXTURE"]) expect(count(lines, marker)).toBe(1);
  expect(lines.join("\n")).not.toMatch(/[▸▾×]/u);
});

test("compact rows without grouping keep one row per call that opens its own card and linked output", () => {
  const { render, click } = setup({ compact: true, group: false }, ...calls(), new CustomEntryComponent("LATE-FIXTURE", 0, 0));
  let lines = render();
  expect(lines).toHaveLength(3);
  expect(lines.join("\n")).not.toContain("×");
  lines.forEach((line, index) => {
    expect(line).toContain("▸ fixture_tool ARG-" + ["one", "two", "three"][index]);
    expect(line).toContain(timestampLabel(first + index * 1000));
  });
  click(0);
  lines = render();
  expect(lines.join("\n")).toContain("BODY-one");
  expect(lines.join("\n")).toContain("LATE-FIXTURE");
  expect(lines.join("\n")).not.toContain("BODY-two");
  // The open card's clock stays on its row.
  expect(count(lines, timestampLabel(first))).toBe(1);
});

test("groups without compact rows open into the members' original cards", () => {
  const { render, click } = setup({ compact: false, group: true }, ...calls(), new CustomEntryComponent("LATE-FIXTURE", 0, 0));
  let lines = render();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("▸ fixture_tool ×3");
  expect(lines[0]).toContain(timestampLabel(first));
  click(0);
  lines = render();
  expect(lines[0]).toContain("▾ fixture_tool ×3");
  for (const marker of ["BODY-one", "BODY-two", "BODY-three", "LATE-FIXTURE"]) {
    const row = lines.find(line => line.includes(marker));
    expect(row).toMatch(/^ │ /u);
  }
  // The first card starts under the header; later cards and linked output keep their native separation inside the guide.
  expect(lines[1]).toContain(timestampLabel(first));
  const last = lines.findIndex(line => line.includes("LATE-FIXTURE"));
  for (const line of lines.slice(1, last + 1)) expect(line).toMatch(/^ │/u);
  for (let index = 1; index < 3; index++) expect(count(lines, timestampLabel(first + index * 1000))).toBe(1);
  expect(lines.join("\n")).not.toContain("ARG-one");
  click(0);
  expect(render()).toHaveLength(1);
});

test("a single call stays an original card when grouping has nothing to merge", () => {
  const one = new ToolExecutionComponent("one");
  const other = new ToolExecutionComponent("other");
  other.toolName = "another_tool";
  const { render } = setup({ compact: false, group: true }, one, other);
  const lines = render().join("\n");
  expect(lines).toContain("BODY-one");
  expect(lines).toContain("BODY-other");
  expect(lines).not.toMatch(/[▸▾×]/u);
});

test.each([false, true])("a nested call tree stands apart from the card above it (group: %s)", group => {
  const calls = new NestedCalls();
  const caller = new ToolExecutionComponent("caller");
  caller.toolName = "codemode";
  calls.start({ parentToolCallId: "caller", toolCallId: "caller/1", toolName: "bash", args: { command: "ls" } });
  const { render } = setupWith(calls, { compact: false, group }, new ToolExecutionComponent("one"), caller);
  const lines = render();
  const card = lines.findIndex(line => line.includes("BODY-one"));
  const tree = lines.findIndex(line => line.includes("bash ls"));
  expect(tree).toBeGreaterThan(card);
  expect(lines[tree - 1].trim()).toBe("");
});

test.each([[true, false], [false, true]])("search reveals a hidden call's card and clearing it hides the card again (compact: %s, group: %s)", (compact, group) => {
  const [one, two, three] = calls();
  two.result = { content: [{ type: "text", text: "BODY-two" }], isError: false };
  const { document, render } = setup({ compact, group }, one, two, three);
  const closed = render();
  expect(closed.join("\n")).not.toContain("BODY-two");
  const entry = document.searchEntries().find(entry => entry.source === two)!;
  const hit = { entry, text: "BODY-two", line: entry.text.split("\n").findIndex(line => line.includes("BODY-two")) };
  expect(document.reveal(hit)).toBe(true);
  const lines = render();
  const row = lines.findIndex(line => line.includes("BODY-two"));
  expect(row).toBeGreaterThan(0);
  expect(document.searchRow(hit)).toBe(row);
  // A compact match opens only its own call; a group opens into all its cards.
  if (compact) expect(lines.join("\n")).not.toContain("BODY-three");
  else expect(lines.join("\n")).toContain("BODY-three");
  document.clearSearch();
  expect(render()).toEqual(closed);
});

test("changing grouping or compacting keeps open groups and open calls", () => {
  const { render, click, show } = setup({ compact: true, group: true }, ...calls());
  click(0);
  click(render().findIndex(line => line.includes("ARG-one")));
  expect(render().join("\n")).toContain("BODY-one");
  show({ compact: true, group: false });
  let lines = render();
  expect(lines.join("\n")).not.toContain("×");
  expect(lines.join("\n")).toContain("BODY-one");
  expect(lines.join("\n")).not.toContain("BODY-two");
  show({ compact: false, group: true });
  lines = render();
  expect(lines[0]).toContain("▾ fixture_tool ×3");
  expect(lines.join("\n")).toContain("BODY-two");
  show({ compact: true, group: true });
  lines = render();
  expect(lines[0]).toContain("▾ fixture_tool ×3");
  expect(lines.join("\n")).toContain("BODY-one");
  expect(lines.join("\n")).not.toContain("BODY-two");
});

test.each([[true, false], [false, true], [true, true]])("a new call streams in full, then hides after the delay (compact: %s, group: %s)", (compact, group) => {
  vi.useFakeTimers();
  const [one, two, three] = calls();
  const { render, history, changed } = setup({ compact, group }, one, two);
  render();
  three.isPartial = true;
  history.addChild(three);
  let lines = render().join("\n");
  expect(lines).toContain("BODY-three");
  three.isPartial = false;
  render();
  vi.advanceTimersByTime(500);
  expect(render().join("\n")).toContain("BODY-three");
  vi.advanceTimersByTime(600);
  expect(changed).toHaveBeenCalledTimes(1);
  lines = render().join("\n");
  expect(lines).not.toContain("BODY-three");
  if (group) expect(lines).toContain("fixture_tool ×3");
  else expect(lines).toContain("ARG-three");
});

test("streaming does nothing while every original card is shown", () => {
  vi.useFakeTimers();
  const call = new ToolExecutionComponent("one");
  call.isPartial = true;
  const { render, changed } = setup({ compact: false, group: false }, call);
  render();
  call.isPartial = false;
  render();
  vi.advanceTimersByTime(2000);
  expect(changed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(render().join("\n")).toContain("BODY-one");
});
