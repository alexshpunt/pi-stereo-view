import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { NativeContentIndex } from "../src/content.ts";
import { NativeDocument } from "../src/native.ts";
import { NestedCalls } from "../src/nested-calls.ts";
import { timestampLabel, TOOL_START_ENTRY, TranscriptTimestamps } from "../src/timestamps.ts";

class ToolExecutionComponent extends Text {
  args: { path: string };
  isPartial = false;
  result: { content: { type: string; text: string }[]; isError: boolean };
  constructor(readonly toolCallId: string, readonly toolName: string, value: string) {
    super(value, 0, 0);
    this.args = { path: toolCallId };
    this.result = { content: [{ type: "text", text: value }], isError: false };
  }
  setExpanded(): void {}
}
class CustomEntryComponent extends Container {
  entry = { data: { parentToolCallId: "root" } };
  customComponent = new Container();
  constructor() { super(); this.addChild(this.customComponent); }
}
const theme = { fg: (_color: string, value: string) => value, style: (value: string) => value } as unknown as Theme;

test.each([false, true])("ungrouped cards retain linked panels, live output, search and copy (compact: %s)", compact => {
  vi.useFakeTimers();
  let group = false;
  const calls = new NestedCalls();
  const parent = new ToolExecutionComponent("root", "codemode", "PARENT-FIXTURE");
  parent.isPartial = true;
  const adjacent = ["a", "b"].map(id => new ToolExecutionComponent(id, "bash", "BODY-" + id));
  const children = ["root/1", "root/2"].map(id => new ToolExecutionComponent(id, "bash", "CHILD-" + id));
  const panel = new CustomEntryComponent();
  panel.customComponent.children = [new Text("PANEL-HEADING", 0, 0), ...children];
  for (const child of children) {
    calls.start({ parentToolCallId: "root", toolCallId: child.toolCallId, toolName: child.toolName, args: child.args });
    calls.end({ toolCallId: child.toolCallId, isError: false });
  }
  const history = new Container(); history.children = [...adjacent, parent, panel];
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const index = new NativeContentIndex(source, calls, () => group);
  const time = Date.UTC(2025, 0, 1, 3, 4, 5);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [{
    type: "custom", customType: TOOL_START_ENTRY, data: { toolCallId: "root", time },
  }] } as unknown as ExtensionContext["sessionManager"]);
  let copied: string | undefined;
  const changed = vi.fn();
  const document = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => true,
    undefined, true, index, text => { copied = text; }, () => false, () => compact,
    undefined, undefined, undefined, { enabled: () => true, delay: () => 1000, changed });
  const render = (width = 100) => { document.beginFrame(); return document.render(width).map(stripTerminalSequences); };
  const click = (row: number, lines: string[], width = 100) => {
    expect(row).toBeGreaterThanOrEqual(0);
    const x = lines[row].search(/[▸▾]/u) + 1;
    const event: TuiMouseEvent = { type: "click", button: "left", x, y: row, screenX: x, screenY: row,
      width, height: lines.length, shift: false, alt: false, ctrl: false };
    document.handleMouse({ ...event, type: "press" }); document.handleMouse(event);
  };
  const original = () => {
    for (const width of [40, 100]) {
      let lines = render(width);
      for (let call = 0; call < 3; call++) {
        const row = lines.findIndex(line => /●\s+▸/u.test(line));
        if (row < 0) break;
        click(row, lines, width); lines = render(width);
      }
      const body = lines.join("\n");
      for (const marker of ["BODY-a", "BODY-b", "PARENT-FIXTURE", "PANEL-HEADING", "CHILD-root/1", "CHILD-root/2"])
        expect(lines.filter(line => line.includes(marker))).toHaveLength(1);
      expect(body).toContain(timestampLabel(time));
      expect(body).not.toContain("bash ×2");
      expect(body).not.toContain("codemode output");
      expect(index.entries("activity").map(entry => entry.component)).toEqual([...adjacent, parent, panel]);
    }
  };
  try {
    const initial = render().join("\n");
    expect(initial).toContain("PARENT-FIXTURE");
    if (compact) {
      expect(initial).not.toContain("BODY-a");
      expect(initial).not.toContain("BODY-b");
    }
    original();
    group = true;
    expect(index.contains(panel)).toBe(false);
    expect(index.entries("activity").map(entry => entry.component)).toEqual([...adjacent, parent, ...panel.customComponent.children]);
    const grouped = render().join("\n");
    expect(grouped).toContain("bash ×2");
    if (!compact) expect(grouped).toContain("codemode output");
    else click(render().findIndex(line => line.includes("bash ×2")), render());
    parent.isPartial = false; render();
    expect(vi.getTimerCount()).toBe(compact ? 1 : 0);
    group = false;
    // Switching inside the verified frame must restore the original linked identity.
    expect(index.contains(panel)).toBe(true);
    original();
    expect(vi.getTimerCount()).toBe(compact ? 1 : 0);

    parent.isPartial = true; parent.setText("PARTIAL-FIXTURE");
    expect(render().join("\n")).toContain("PARTIAL-FIXTURE");
    parent.isPartial = false; parent.result.isError = true; parent.setText("ERROR-FIXTURE");
    expect(render().join("\n")).toContain("ERROR-FIXTURE");
    vi.advanceTimersByTime(2000);
    expect(changed).toHaveBeenCalledTimes(compact ? 1 : 0);
    const collapsed = render();
    expect(collapsed.join("\n")).not.toContain("×2");
    expect(collapsed.join("\n")).not.toContain("codemode output");
    if (compact) {
      expect(collapsed.join("\n")).not.toContain("ERROR-FIXTURE");
      expect(collapsed.join("\n")).not.toContain("PANEL-HEADING");
      click(collapsed.findIndex(line => /●\s+▸\s+codemode/u.test(line)), collapsed);
    }
    const expanded = render();
    expect(expanded.join("\n")).toContain("ERROR-FIXTURE");
    expect(expanded.join("\n")).toContain("PANEL-HEADING");
    expect(expanded.filter(line => line.includes(timestampLabel(time)))).toHaveLength(compact ? 1 : 2);

    children[1].result.content[0].text += "\nSAVED-NEEDLE";
    const saved = document.searchEntries().find(entry => entry.source === panel)!;
    expect(saved.text).toContain("SAVED-NEEDLE");
    const hit = { entry: saved, line: saved.text.split("\n").indexOf("SAVED-NEEDLE"), text: "SAVED-NEEDLE" };
    expect(document.reveal(hit)).toBe(true);
    render();
    expect(document.searchRow(hit)).toBeUndefined();
    document.showSearchExcerpt(hit);
    const lines = render();
    expect(document.searchRow(hit)).toBe(lines.findIndex(line => line.includes("Search match:")));
    document.clearSearch();
    expect(render().join("\n")).not.toContain("Search match:");

    document.copyBlocks().find(block => block.label.includes("codemode"))!.copy();
    for (const marker of ['"path": "root"', "PARENT-FIXTURE", "CHILD-root/1", "SAVED-NEEDLE"]) expect(copied).toContain(marker);
    expect(history.children).toEqual([...adjacent, parent, panel]);
    group = true;
    if (compact) expect(render().find(line => line.includes("bash ×2"))).toContain("▾");
  } finally { document.dispose(); vi.useRealTimers(); }
});

test("late execution metadata updates projection without replacing history components", () => {
  const calls = new NestedCalls();
  const parent = new ToolExecutionComponent("root", "caller", "PARENT-PARTS-FIXTURE");
  const first = new ToolExecutionComponent("root/1", "read", "FIRST-PARTS-FIXTURE");
  const second = new ToolExecutionComponent("root/2", "bash", "SECOND-PARTS-FIXTURE");
  const panel = new CustomEntryComponent(); panel.customComponent.children = [first, second];
  const history = new Container(); history.children = [parent, panel];
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const index = new NativeContentIndex(source, calls);
  expect(index.entries("activity").map(entry => entry.source)).toEqual([parent, panel]);
  for (const tool of [first, second]) calls.start({ toolCallId: tool.toolCallId, parentToolCallId: "root", toolName: tool.toolName, args: tool.args });
  expect(index.entries("activity").map(entry => entry.source)).toEqual([parent, first, second]);
  calls.restore([]);
  expect(index.entries("activity").map(entry => entry.source)).toEqual([parent, panel]);
  expect(history.children).toEqual([parent, panel]);
});
test("each original native result opens independently inside a mixed linked container", () => {
  const calls = new NestedCalls();
  const parent = new ToolExecutionComponent("root", "caller", "PARENT-PARTS-FIXTURE");
  const tools = ["read", "read", "bash", "search"].map((name, index) => {
    const id = `root/${index + 1}`;
    calls.start({ parentToolCallId: "root", toolCallId: id, toolName: name, args: { path: id } });
    return new ToolExecutionComponent(id, name, `RESULT-PARTS-FIXTURE-${index + 1}`);
  });
  const panel = new CustomEntryComponent();
  const warning = new Text("WARNING-PARTS-FIXTURE", 0, 0);
  panel.customComponent.children = [...tools, warning];
  const originalChildren = [...panel.customComponent.children];
  const history = new Container(); history.children = [parent, panel];
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const index = new NativeContentIndex(source, calls);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => false,
    undefined, true, index, undefined, () => false, () => true);
  const render = () => { document.beginFrame(); return document.render(120).map(stripTerminalSequences); };
  const click = (row: number) => {
    const lines = render();
    expect(row).toBeGreaterThanOrEqual(0);
    const x = lines[row].search(/[▸▾]/u) + 1;
    expect(x).toBeGreaterThan(0);
    const event: TuiMouseEvent = { type: "click", button: "left", x, y: row, screenX: x, screenY: row,
      width: 120, height: lines.length, shift: false, alt: false, ctrl: false };
    document.handleMouse({ ...event, type: "press" }); document.handleMouse(event);
  };
  const header = (value: string) => render().findIndex(line => /●\s+[▸▾]/u.test(line) && line.includes(value));
  try {
    click(header("caller"));
    expect(render().join("\n")).not.toContain("RESULT-PARTS-FIXTURE");
    click(header("×2"));
    for (const id of ["root/1", "root/2", "root/3", "root/4"]) expect(header(id)).toBeGreaterThanOrEqual(0);
    expect(render().join("\n")).not.toContain("RESULT-PARTS-FIXTURE");
    for (const [i, tool] of tools.entries()) {
      click(header(tool.toolCallId));
      expect(render().filter(line => line.includes(`RESULT-PARTS-FIXTURE-${i + 1}`))).toHaveLength(1);
      for (const other of tools.filter(candidate => candidate !== tool)) expect(render().join("\n")).not.toContain(other.result.content[0].text);
      click(header(tool.toolCallId));
      expect(render().join("\n")).not.toContain("RESULT-PARTS-FIXTURE");
      click(header(tool.toolCallId));
      expect(render().filter(line => line.includes(tool.result.content[0].text))).toHaveLength(1);
      click(header(tool.toolCallId));
    }
    expect(index.entries("activity").map(entry => entry.source)).toEqual([parent, ...tools, warning]);
    expect(index.entries("activity").slice(1).every(entry => entry.owner === parent)).toBe(true);
    const second = document.searchEntries().find(entry => entry.source === tools[1])!;
    const hit = { entry: second, line: 0, text: tools[1].result.content[0].text };
    expect(document.reveal(hit)).toBe(true);
    const lines = render();
    expect(document.searchRow(hit)).toBe(lines.findIndex(line => line.includes(hit.text)));
    expect(lines.join("\n")).not.toContain(tools[0].result.content[0].text);
    const copied = index.copy(index.entries("activity")[0], 120)!;
    for (const tool of tools) expect(copied.split(tool.result.content[0].text)).toHaveLength(2);
    expect(copied.split("WARNING-PARTS-FIXTURE")).toHaveLength(2);
    expect(panel.customComponent.children).toEqual(originalChildren);
    document.clearSearch();
    expect(render().join("\n")).not.toContain("RESULT-PARTS-FIXTURE");
    const late = new ToolExecutionComponent("root/5", "bash", "LATE-PARTS-FIXTURE");
    calls.start({ parentToolCallId: "root", toolCallId: late.toolCallId, toolName: "bash", args: late.args });
    panel.customComponent.addChild(late);
    expect(index.entries("activity").some(entry => entry.source === late)).toBe(true);
    expect(header("root/5")).toBeGreaterThanOrEqual(0);
    const references = (component: Component): Component[] => [component, ...((component as Container).children ?? []).flatMap(references)];
    click(header("root/5")); render();
    expect(references(document).filter(component => component === late)).toHaveLength(1);
  } finally { document.dispose(); }
});
