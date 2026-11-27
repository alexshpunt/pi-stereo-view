import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.ts";
import { GuiContent } from "../src/gui-content.ts";

class ToolExecutionComponent extends Text {
  toolName = "read";
  toolCallId = "call-1";
  args = {};
  setExpanded(): void {}
}

function setup() {
  const root = new Container();
  root.addChild(new Container()); root.addChild(new Container());
  const history = new Container(); root.addChild(history);
  const chat = new Text("hello", 0, 0);
  const tool = new ToolExecutionComponent("tool output", 0, 0);
  history.addChild(chat); history.addChild(tool);
  return { history, chat, tool, content: new GuiContent(new NativeContentIndex(root)) };
}

test("pages use the existing classification and render only the requested entries", () => {
  const { content, tool } = setup();
  let renders = 0;
  const render = tool.render.bind(tool);
  tool.render = width => { renders++; return render(width); };
  const chat = content.page("chat", 2, 1, 40);
  expect(chat.total).toBe(3);
  expect(chat.entries[0].lines.map(stripTerminalSequences).join("")).toContain("hello");
  expect(renders).toBe(0);
  const activity = content.page("activity", 0, 1, 40);
  expect(activity.total).toBe(1);
  expect(activity.entries[0].lines.map(stripTerminalSequences).join("")).toContain("tool output");
  expect(renders).toBe(1);
});

test("live content changes and history changes appear on later pages", () => {
  const { history, chat, content } = setup();
  const before = content.page("chat", 2, 5, 40);
  chat.setText("updated");
  history.addChild(new Text("new", 0, 0));
  const after = content.page("chat", 2, 5, 40);
  expect(after.total).toBe(4);
  expect(after.entries[0].id).toBe(before.entries[0].id);
  expect(after.entries[0].lines.map(stripTerminalSequences).join("")).toContain("updated");
  expect(after.entries[1].lines.map(stripTerminalSequences).join("")).toContain("new");
  expect(content.page("chat", 3, 1, 40).entries[0].id).toBe(after.entries[1].id);
});
