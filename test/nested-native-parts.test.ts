import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.js";
import { NativeDocument } from "../src/native.js";
import { NestedCalls } from "../src/nested-calls.js";
import { TranscriptTimestamps } from "../src/timestamps.js";

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
