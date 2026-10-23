import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.js";
import { NativeDocument } from "../src/native.js";
import { CompactMessage, TranscriptTimestamps } from "../src/timestamps.js";

class UserMessageComponent extends Container {
  constructor(readonly text: string) { super(); this.addChild(new Text(text, 0, 0)); }
}
class ToolExecutionComponent extends Text {
  toolCallId = "first";
  toolName = "read";
  args = { path: "пример.md" };
  result = { content: [{ type: "text", text: "FULL\nTOOL RESULT" }] };
}
class CustomMessageComponent extends Text {
  constructor(readonly message: { content: string; details: { parentToolCallId: string } }) { super(message.content, 0, 0); }
}
function setup(...components: Component[]) {
  const source = new Container();
  const history = new Container();
  components.forEach(component => history.addChild(component));
  source.addChild(new Container());
  source.addChild(new Container());
  source.addChild(history);
  return { source, history, index: new NativeContentIndex(source) };
}
const theme = { fg: (_color: string, value: string) => value, style: (value: string) => value } as unknown as Theme;
const pointer = (type: TuiMouseEvent["type"], x: number, y = 0): TuiMouseEvent => ({
  type, button: "left", x, y, screenX: x, screenY: y, width: 40, height: 4,
  shift: false, alt: false, ctrl: false,
});

test("copies full source Markdown without serializing other blocks", () => {
  const text = "**Привет**\n\n```ts\nconst x = 1;\n```\n";
  const user = new UserMessageComponent(text);
  const tool = new ToolExecutionComponent("short", 0, 0);
  let reads = 0;
  Object.defineProperty(tool, "args", { get: () => { reads++; return {}; } });
  const { index } = setup(user, tool);
  const entry = index.entries("chat").find(entry => entry.source === user)!;
  index.entries("activity");
  expect(reads).toBe(0);
  expect(index.copy(entry, 12)).toBe(text);
  expect(reads).toBe(0);
});

test("copies only a tool's linked results in arrival order and rereads current output", () => {
  const first = new ToolExecutionComponent("collapsed", 0, 0);
  const second = new ToolExecutionComponent("other tool", 0, 0);
  second.toolCallId = "second";
  const output = (content: string, id: string) => new CustomMessageComponent({ content, details: { parentToolCallId: id } });
  const unrelated = output("OTHER OUTPUT", "second");
  const late = output("LATE FIRST", "first");
  const last = output("LAST FIRST", "first");
  const { history, index } = setup(first, second, unrelated, late, last);
  const entries = index.entries("activity");
  const entry = entries.find(entry => entry.source === first)!;
  expect(index.copy(entry, 8)).toBe('read\n{\n  "path": "пример.md"\n}\nFULL\nTOOL RESULT\n\nLATE FIRST\n\nLAST FIRST');
  expect(index.copy(entries.find(entry => entry.source === late)!, 8)).toBe("LATE FIRST");
  first.result.content[0].text = "UPDATED RESULT";
  expect(index.copy(entry, 8)).toContain("UPDATED RESULT");
  history.removeChild(first);
  expect(index.copy(entry, 8)).toBeUndefined();
});

test.each([true, false])("copy hit testing preserves native selection with timestamps %s", show => {
  let copies = 0;
  const events: TuiMouseEvent[] = [];
  const native: Component = { render: () => ["", "**source**", "body", ""], invalidate() {},
    handleMouse: event => { events.push(event); return undefined; } };
  const block = new CompactMessage(native, () => "12:34:56", () => theme, () => 1, () => show, () => { copies++; });
  block.prepare(40, true);
  const rows = block.render(40).map(stripTerminalSequences);
  const bodyRow = show ? 2 : 1;
  const copyRow = bodyRow + 2;
  const x = rows[copyRow].indexOf("⧉");
  expect(x).toBe(37);
  expect(rows[copyRow].slice(x)).toBe("⧉ ");
  expect(rows[1]).toBe(show ? " 12:34:56" : "**source**");
  expect(rows[bodyRow]).toBe("**source**");
  for (const column of [x, x + 1]) {
    expect(block.handleMouse(pointer("press", column, copyRow))).toMatchObject({ capture: true });
    block.handleMouse(pointer("click", column, copyRow));
  }
  expect(copies).toBe(2);
  block.handleMouse(pointer("click", x, copyRow + 1));
  expect(copies).toBe(2);
  block.handleMouse(pointer("press", 1, bodyRow));
  expect(events.at(-1)).toMatchObject({ x: 1, y: 1, width: 39, height: 4 });
  expect(events).toHaveLength(1);
  block.dispose();
});

test("copies a native text renderer's source rather than its padding and wrapping", () => {
  class CustomEntryComponent extends Container {
    entry = { data: { parentToolCallId: "missing" } };
    customComponent: Text;
    constructor(readonly original: string) {
      super();
      this.customComponent = new Text(original, 1, 1);
      this.addChild(this.customComponent);
    }
  }
  const original = "Long custom output that wraps in a narrow panel\n  indented text\n";
  const custom = new CustomEntryComponent(original);
  const { index } = setup(custom);
  const entry = index.entries("chat").find(entry => entry.source === custom)!;
  expect(index.copy(entry, 12)).toBe(original);
});
test("a keyboard choice cannot copy from a replaced history document", () => {
  const user = new UserMessageComponent("old branch");
  const { source, index } = setup(user);
  const copied: (string | undefined)[] = [];
  const times = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "chat", times, () => theme, () => 0, () => false,
    () => {}, true, index, text => copied.push(text));
  const choice = document.copyBlocks()[0];
  document.dispose();
  choice.copy();
  expect(copied).toEqual([undefined]);
});
test("invisible blocks do not acquire a copy-only row", () => {
  const block = new CompactMessage({ render: () => [], invalidate() {} }, () => "12:34:56", () => theme,
    () => 0, () => true, () => { throw new Error("Invisible copy target"); });
  expect(block.prepare(40, false)).toBe(false);
  expect(block.render(40)).toEqual([]);
  expect(block.handleMouse(pointer("click", 30))).toBeUndefined();
  block.dispose();
});
