import type { Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NestedCalls } from "../src/nested-calls.ts";
import { NestedTree, type NativeTreeBody } from "../src/nested-tree.ts";
import { NativeContentIndex, type ContentEntry } from "../src/content.ts";
import { NativeDocument } from "../src/native.ts";
import { TranscriptTimestamps } from "../src/timestamps.ts";

const theme = { fg: (_color: string, value: string) => value, style: (value: string) => value } as unknown as Theme;
const present = (name: string) => ({ name, key: name });
function body(component: Component, tool = false): NativeTreeBody {
  const entry: ContentEntry = { source: component, owner: component, component, kind: "tool", spacing: [], compact: true,
    tool: tool ? () => ({ name: "caller", args: {}, status: "success" }) : undefined,
    search: () => ({ label: "fixture", text: "fixture" }) };
  return { entry, component };
}
class ToolExecutionComponent extends Text {
  toolName = "leaf";
  args = {};
  isPartial = false;
  result = { content: [{ type: "text", text: "SAVED-PARENT-FIXTURE" }] };
  setExpanded(): void {}
  constructor(readonly toolCallId: string) { super("NATIVE-LEAF-FIXTURE", 0, 0); }
}
const render = (tree: NestedTree) => tree.render(100).map(stripTerminalSequences);
function click(tree: NestedTree, y: number, x = 12) {
  const event: TuiMouseEvent = { type: "click", button: "left", x, y, screenX: x, screenY: y,
    width: 100, height: tree.render(100).length, shift: false, alt: false, ctrl: false };
  tree.handleMouse({ ...event, type: "press" }); tree.handleMouse(event);
}
function setup() {
  const calls = new NestedCalls();
  for (const id of ["root/1", "root/2"]) calls.start({ toolCallId: id, parentToolCallId: "root", toolName: "replace", args: { path: id + ".txt" } });
  const panel = new Container();
  panel.addChild(new Text("SHARED-WARNING-FIXTURE", 0, 0));
  // A native renderer can combine multiple calls in a component carrying its last call's ID.
  panel.addChild(new ToolExecutionComponent("root/2"));
  const parent = body(new Text("PARENT-OUTPUT-FIXTURE", 0, 0), true);
  const output = body(panel);
  const tree = new NestedTree("root", calls, () => theme, present, () => true, () => {});
  tree.setBodies(parent, [output]);
  return { calls, panel, parent, output, tree };
}

test("opening a nested group exposes both calls and the original shared native panel once", () => {
  const { tree, panel } = setup();
  let lines = render(tree);
  expect(lines.filter(line => line.includes("replace") && line.includes("×2"))).toHaveLength(1);
  expect(lines.join("\n")).not.toContain("NATIVE-LEAF-FIXTURE");
  click(tree, lines.findIndex(line => line.includes("replace")));
  lines = render(tree);
  for (const id of ["root/1.txt", "root/2.txt"]) expect(lines.filter(line => line.includes(id))).toHaveLength(1);
  expect(lines.filter(line => line.includes("NATIVE-LEAF-FIXTURE"))).toHaveLength(1);
  expect(lines.filter(line => line.includes("SHARED-WARNING-FIXTURE"))).toHaveLength(1);
  const descendants = (node: Component): Component[] => [node, ...((node as Container).children ?? []).flatMap(descendants)];
  expect(descendants(tree).filter(node => node === panel)).toHaveLength(1);
  click(tree, lines.findIndex(line => line.includes("×2")));
  expect(render(tree).join("\n")).not.toContain("NATIVE-LEAF-FIXTURE");
});

test("closed groups hide opaque and cross-group panels until the caller output is opened", () => {
  const { tree, calls, parent } = setup();
  calls.start({ toolCallId: "root/3", parentToolCallId: "root", toolName: "read", args: { path: "THIRD-FIXTURE" } });
  const opaque = new Text("OPAQUE-FIXTURE", 0, 0);
  const mixed = new Container(); mixed.addChild(new ToolExecutionComponent("root/1")); mixed.addChild(new ToolExecutionComponent("root/3"));
  tree.setBodies(parent, [body(opaque), body(mixed)]);
  const folded = render(tree);
  expect(folded.join("\n")).not.toContain("OPAQUE-FIXTURE");
  expect(folded.join("\n")).not.toContain("NATIVE-LEAF-FIXTURE");
  expect(tree.positions.has(opaque)).toBe(false);
  click(tree, folded.length - 1);
  const lines = render(tree).join("\n");
  expect(lines).toContain("OPAQUE-FIXTURE");
  expect(lines.match(/NATIVE-LEAF-FIXTURE/g)).toHaveLength(2);
  expect(tree.positions.has(opaque)).toBe(true);
  expect(tree.positions.has(mixed)).toBe(true);
  click(tree, render(tree).findIndex(line => line.includes("caller")));
  expect(render(tree).join("\n")).not.toContain("OPAQUE-FIXTURE");
  tree.setBodies(parent, [body(opaque), body(mixed)], mixed);
  expect(render(tree).join("\n")).toContain("OPAQUE-FIXTURE");
  expect(tree.positions.has(mixed)).toBe(true);
});

test("saved deeper calls keep their hierarchy, and search reveals a closed native panel", () => {
  const { tree, calls, parent, output } = setup();
  calls.restore([{ type: "message", message: { role: "toolResult", toolCallId: "root", nestedCalls: { complete: true, calls: [
    { id: "root/1", name: "middle", status: "ok", arguments: { path: "MIDDLE-FIXTURE" } },
    { id: "root/1/1", name: "leaf", status: "error", arguments: { path: "DEEP-FIXTURE" } },
  ] } } }]);
  tree.setBodies(parent, [output]);
  let lines = render(tree);
  expect(lines.join("\n")).not.toContain("DEEP-FIXTURE");
  click(tree, lines.findIndex(line => line.includes("MIDDLE-FIXTURE")));
  lines = render(tree);
  expect(lines.find(line => line.includes("DEEP-FIXTURE"))!.indexOf("leaf")).toBeGreaterThan(lines.find(line => line.includes("MIDDLE-FIXTURE"))!.indexOf("middle"));
  // Match a panel's actual execution ID, then reveal it without changing native ownership.
  const deepPanel = new ToolExecutionComponent("root/1/1");
  tree.setBodies(parent, [body(deepPanel)], deepPanel);
  expect(render(tree).join("\n")).toContain("NATIVE-LEAF-FIXTURE");
  expect(tree.positions.has(deepPanel)).toBe(true);
  tree.setBodies(parent, [body(deepPanel)]);
  expect(render(tree).join("\n")).not.toContain("NATIVE-LEAF-FIXTURE");
});

test("changing branches drops live identities and never invents saved result panels", () => {
  const { calls } = setup();
  calls.end({ toolCallId: "root/1", isError: true });
  expect(calls.entries("root").map(call => call.status)).toEqual(["error", "running"]);
  calls.restore([{ type: "message", message: { role: "toolResult", toolCallId: "other", nestedCalls: { complete: false, calls: [
    { id: "other/1", name: "custom", status: "unfinished" },
  ] } } }]);
  expect(calls.entries("root")).toEqual([]);
  expect(calls.entries("other")[0].status).toBe("unknown");
  expect(calls.isIncomplete("other")).toBe(true);
});

test("late siblings preserve visible expansion without reopening an explicitly closed group", () => {
  const calls = new NestedCalls();
  calls.start({ parentToolCallId: "root", toolCallId: "root/1", toolName: "leaf", args: { path: "FIRST-FIXTURE" } });
  const panel = new ToolExecutionComponent("root/1");
  const tree = new NestedTree("root", calls, () => theme, present, () => true, () => {});
  tree.setBodies(body(new Text("PARENT-FIXTURE", 0, 0), true), [body(panel)]);
  render(tree); click(tree, 0);
  expect(render(tree).join("\n")).toContain("NATIVE-LEAF-FIXTURE");
  calls.start({ parentToolCallId: "root", toolCallId: "root/2", toolName: "leaf", args: { path: "SECOND-FIXTURE" } });
  expect(render(tree).join("\n")).toContain("NATIVE-LEAF-FIXTURE");
  click(tree, 0);
  calls.end({ toolCallId: "root/1", isError: true });
  calls.start({ parentToolCallId: "root", toolCallId: "root/3", toolName: "leaf", args: {} });
  expect(render(tree).join("\n")).not.toContain("NATIVE-LEAF-FIXTURE");
});

test.each([false, true])("search reveals nested output and maps its row without changing clipboard ownership (abbreviated: %s)", abbreviated => {
  const calls = new NestedCalls();
  for (const id of ["root/1", "root/2"]) calls.start({ parentToolCallId: "root", toolCallId: id, toolName: "leaf", args: { path: id + ".txt" } });
  const parent = new ToolExecutionComponent("root"); parent.toolName = "caller";
  class CustomEntryComponent extends Container {
    entry = { data: { parentToolCallId: "root" } };
    customComponent = new ToolExecutionComponent("root/2");
    constructor() { super(); this.addChild(this.customComponent); }
  }
  const panel = new CustomEntryComponent();
  if (abbreviated) {
    panel.customComponent.setText("SHORT-NATIVE-FIXTURE");
    panel.customComponent.result.content[0].text = "NATIVE-LEAF-FIXTURE";
  }
  const history = new Container(); history.children = [parent, panel];
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const index = new NativeContentIndex(source, calls);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => false,
    undefined, true, index, undefined, () => false, () => true);
  try {
    const initial = document.render(100).map(stripTerminalSequences).join("\n");
    expect(initial).not.toContain("NATIVE-LEAF-FIXTURE");
    const entry = document.searchEntries().find(entry => entry.source === panel)!;
    const hit = { entry, line: 0, text: "NATIVE-LEAF-FIXTURE" };
    expect(document.reveal(hit)).toBe(true);
    let lines = document.render(100).map(stripTerminalSequences);
    if (abbreviated) {
      expect(entry.text).toContain("NATIVE-LEAF-FIXTURE");
      expect(document.searchRow(hit)).toBeUndefined();
      document.showSearchExcerpt(hit);
      lines = document.render(100).map(stripTerminalSequences);
      expect(lines.some(line => line.includes("SHORT-NATIVE-FIXTURE"))).toBe(true);
    }
    expect(lines.filter(line => line.includes("NATIVE-LEAF-FIXTURE"))).toHaveLength(1);
    expect(document.searchRow(hit)).toBe(lines.findIndex(line => line.includes("NATIVE-LEAF-FIXTURE")));
    const parentEntry = index.entries("activity").find(entry => entry.source === parent)!;
    const copied = index.copy(parentEntry, 100)!;
    expect(copied).toContain("root/1.txt");
    expect(copied).toContain("root/2.txt");
    expect(copied).toContain("NATIVE-LEAF-FIXTURE");
    expect(index.entries("activity").map(entry => entry.source)).toEqual([parent, panel]);
  } finally { document.dispose(); }
});
