import { Container, Spacer, Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.js";

class ToolExecutionComponent extends Text {
  toolName = "write";
  toolCallId = "native-tool-owner";
  args = { path: "file" };
  result = { content: [{ type: "text", text: "SAVED TOOL RESULT" }] };
  setExpanded(): void {}
}
class BashExecutionComponent extends Text {
  command = "printf shell";
  outputLines = ["SAVED SHELL RESULT"];
}
class CustomEntryComponent extends Text {
  constructor(text: string, readonly entry: { data: { parentToolCallId: string } }) { super(text, 0, 0); }
}
class Markdown extends Text {}
class MouseRegion extends Container {}
class AssistantMessageComponent extends Container {
  contentContainer = new Container();
  hasToolCalls = false;
  lastMessage = { content: [{ type: "text", text: "DIALOGUE" }, { type: "thinking", thinking: "REASONING" }] };
  revealed = false;
  private nativeChildren: Component[] = [];
  constructor() {
    super();
    this.addChild(this.contentContainer);
    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(new Markdown("DIALOGUE", 0, 0));
    this.contentContainer.addChild(new Spacer(1));
    const thinking = new MouseRegion();
    thinking.addChild(new Text("REASONING", 0, 0));
    this.contentContainer.addChild(thinking);
    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(new Text("GENERATION FAILED", 0, 0));
    this.nativeChildren = [...this.contentContainer.children];
  }
  override invalidate(): void {
    super.invalidate();
    // Like the native assistant, invalidation rebuilds its complete content.
    this.contentContainer.children = [...this.nativeChildren];
  }
  setHideThinkingBlock(hidden: boolean): void { this.revealed = !hidden; }
}

function setup(...children: Component[]): { history: Container; index: NativeContentIndex } {
  const source = new Container();
  source.addChild(new Container());
  source.addChild(new Container());
  const history = new Container();
  for (const child of children) history.addChild(child);
  source.addChild(history);
  return { history, index: new NativeContentIndex(source) };
}
const visible = (component: Container | Text): string => component.render(80).map(stripTerminalSequences).join("\n");

test("only positive execution identities go to Activity; wording and status updates do not classify content", () => {
  const spacing = new Spacer(1);
  const unknown = new Text("thinking tool error warning", 0, 0);
  const tool = new ToolExecutionComponent("VISIBLE TOOL", 0, 0);
  const shell = new BashExecutionComponent("VISIBLE SHELL", 0, 0);
  const { history, index } = setup(spacing, unknown, tool, shell);
  const system = index.entries("chat").find(entry => entry.source === unknown)!;
  expect(system.kind).toBe("system");
  expect(system.spacing).toEqual([spacing]);
  expect(index.entries("activity").map(entry => entry.kind)).toEqual(["tool", "shell"]);
  expect(index.entries("activity").map(entry => entry.search(80).text)).toEqual([
    'write\n{\n  "path": "file"\n}\nSAVED TOOL RESULT', "printf shell\nSAVED SHELL RESULT",
  ]);
  unknown.setText("Unrelated system wording");
  expect(index.entries("chat").find(entry => entry.source === unknown)).toBe(system);
  expect(system.search(80).text.trimEnd()).toBe("Unrelated system wording");
  history.removeChild(tool);
  expect(index.contains(tool)).toBe(false);
  expect(index.entries("activity").map(entry => entry.source)).toEqual([shell]);
});

test("assistant content metadata separates thinking from dialogue and generation diagnostics for render and search", () => {
  const assistant = new AssistantMessageComponent();
  const { index } = setup(assistant);
  const chat = index.entries("chat").find(entry => entry.source === assistant)!;
  const activity = index.entries("activity")[0];
  expect(visible(chat.component as Container)).toContain("DIALOGUE");
  expect(visible(chat.component as Container)).toContain("GENERATION FAILED");
  expect(visible(chat.component as Container)).not.toContain("REASONING");
  expect(visible(activity.component as Container)).toContain("REASONING");
  expect(visible(activity.component as Container)).not.toContain("GENERATION FAILED");
  expect(chat.search(80).text).toContain("GENERATION FAILED");
  expect(activity.search(80).text).toBe("REASONING");
  activity.search(80).reveal?.();
  expect(assistant.revealed).toBe(true);
  expect(assistant.contentContainer.children).toHaveLength(6);
});

test("a reused assistant owner rebuilds both projections when its semantic content changes", () => {
  const assistant = new AssistantMessageComponent();
  const { index } = setup(assistant);
  const first = index.entries("chat").find(entry => entry.source === assistant)!;
  assistant.lastMessage.content = [{ type: "text", text: "NEW DIALOGUE" }];
  assistant.contentContainer.clear();
  assistant.contentContainer.addChild(new Markdown("NEW DIALOGUE", 0, 0));
  const next = index.entries("chat").find(entry => entry.source === assistant)!;
  expect(next.component).toBe(first.component);
  expect(visible(next.component as Container)).toContain("NEW DIALOGUE");
  expect(next.search(80).text).toBe("NEW DIALOGUE");
  expect(index.entries("activity")).toEqual([]);
});

test("an execution-like component name without execution metadata stays in Conversation", () => {
  const custom = new ToolExecutionComponent("CUSTOM CONTENT", 0, 0);
  Reflect.deleteProperty(custom, "toolName");
  const { index } = setup(custom);
  expect(index.entries("activity")).toEqual([]);
  const entry = index.entries("chat").find(entry => entry.source === custom)!;
  expect(entry.kind).toBe("system");
  expect(entry.search(80).text.trimEnd()).toBe("CUSTOM CONTENT");
});

test("invalidating a projected assistant does not restore the other pane into its content", () => {
  const assistant = new AssistantMessageComponent();
  const original = [...assistant.contentContainer.children];
  const { index } = setup(assistant);
  const chat = index.entries("chat").find(entry => entry.source === assistant)!;
  chat.component.invalidate();
  const refreshed = index.entries("chat").find(entry => entry.source === assistant)!;
  expect(visible(refreshed.component as Container)).not.toContain("REASONING");
  expect(visible(index.entries("activity")[0].component as Container)).not.toContain("DIALOGUE");
  expect(assistant.contentContainer.children).toEqual(original);
});

test("late output stays directly after its owner without changing native history order", () => {
  const first = new ToolExecutionComponent("FIRST TOOL", 0, 0);
  first.toolCallId = "first";
  const second = new ToolExecutionComponent("SECOND TOOL", 0, 0);
  second.toolCallId = "second";
  const shell = new BashExecutionComponent("SHELL", 0, 0);
  const firstOutput = new CustomEntryComponent("FIRST OUTPUT", { data: { parentToolCallId: first.toolCallId } });
  const secondOutput = new CustomEntryComponent("SECOND OUTPUT", { data: { parentToolCallId: second.toolCallId } });
  const update = new CustomEntryComponent("LATER FIRST OUTPUT", { data: { parentToolCallId: first.toolCallId } });
  const { history, index } = setup(first, second, shell);
  expect(index.entries("activity").map(entry => entry.source)).toEqual([first, second, shell]);
  history.addChild(secondOutput);
  history.addChild(firstOutput);
  history.addChild(update);
  const nativeOrder = [...history.children];
  expect(index.entries("activity").map(entry => entry.source)).toEqual([
    first, firstOutput, update, second, secondOutput, shell,
  ]);
  expect(index.entries("activity").map(entry => entry.search(80).text)).toEqual([
    expect.stringContaining("SAVED TOOL RESULT"), expect.stringContaining("FIRST OUTPUT"),
    expect.stringContaining("LATER FIRST OUTPUT"), expect.stringContaining("SAVED TOOL RESULT"),
    expect.stringContaining("SECOND OUTPUT"), expect.stringContaining("SAVED SHELL RESULT"),
  ]);
  expect(history.children).toEqual(nativeOrder);
  // A resumed history rebuild derives the same grouping from saved entry metadata.
  expect(setup(...nativeOrder).index.entries("activity").map(entry => entry.source)).toEqual([
    first, firstOutput, update, second, secondOutput, shell,
  ]);
  // A branch without the old owner must not retain its grouping or search membership.
  history.removeChild(first);
  expect(index.entries("activity").map(entry => entry.source)).toEqual([second, secondOutput, shell]);
  expect(index.contains(firstOutput, "activity")).toBe(false);
  expect(index.contains(firstOutput, "chat")).toBe(true);
});

class CustomMessageComponent extends Text {
  constructor(text: string, readonly message: { details: { parentToolCallId: string } }) { super(text, 0, 0); }
}

test("late custom messages use the same execution grouping as custom entries", () => {
  const first = new ToolExecutionComponent("FIRST TOOL", 0, 0);
  const second = new ToolExecutionComponent("SECOND TOOL", 0, 0);
  second.toolCallId = "second";
  const output = new CustomMessageComponent("MESSAGE OUTPUT", { details: { parentToolCallId: first.toolCallId } });
  const { history, index } = setup(first, second, output);
  expect(index.entries("activity").map(entry => entry.source)).toEqual([first, output, second]);
  expect(history.children).toEqual([first, second, output]);
});

test("custom output follows a known execution owner, while an unowned custom entry stays in Conversation", () => {
  const tool = new ToolExecutionComponent("TOOL", 0, 0);
  const output = new CustomEntryComponent("LINKED OUTPUT", { data: { parentToolCallId: tool.toolCallId } });
  const orphan = new CustomEntryComponent("UNKNOWN OUTPUT", { data: { parentToolCallId: "missing-owner" } });
  const { history, index } = setup(tool, output, orphan);
  expect(index.entries("activity").map(entry => entry.source)).toEqual([tool, output]);
  expect(index.entries("chat").filter(entry => entry.compact).map(entry => entry.source)).toEqual([orphan]);
  const linked = index.entries("activity").find(entry => entry.source === output)!;
  expect(linked.search(80).text).toContain("LINKED OUTPUT");
  expect(linked.search(80).label).toBe("write");
  expect(linked.owner).toBe(tool);
  orphan.entry.data.parentToolCallId = tool.toolCallId;
  expect(index.entries("activity").map(entry => entry.source)).toEqual([tool, output, orphan]);
  expect(index.contains(orphan, "chat")).toBe(false);
  history.removeChild(tool);
  expect(index.entries("activity")).toEqual([]);
  expect(index.entries("chat").filter(entry => entry.compact).map(entry => entry.source)).toEqual([output, orphan]);
  expect(index.contains(output, "activity")).toBe(false);
});

test("projects deferred native thinking and text after each streaming update without mixing panes", () => {
  // Pi-Bolt defers rebuilding native children until its assistant is rendered.
  class AssistantMessageComponent extends Container {
    contentContainer = new Container();
    hasToolCalls = false;
    contentIsStale = true;
    lastMessage: { content: { type: string; text?: string; thinking?: string }[] } = { content: [] };
    constructor() { super(); this.addChild(this.contentContainer); }
    buildContent(message: typeof this.lastMessage): void {
      this.contentIsStale = false;
      this.contentContainer.clear();
      for (const block of message.content) {
        if (block.type === "text" && block.text?.trim()) this.contentContainer.addChild(new Markdown(block.text, 0, 0));
        if (block.type === "thinking" && block.thinking?.trim()) {
          const region = new MouseRegion();
          region.addChild(new Text(block.thinking, 0, 0));
          this.contentContainer.addChild(region);
        }
      }
    }
    override render(width: number): string[] {
      if (this.contentIsStale) this.buildContent(this.lastMessage);
      return super.render(width);
    }
    setHideThinkingBlock(): void {}
  }
  const assistant = new AssistantMessageComponent();
  const { index } = setup(assistant);
  expect(index.entries("activity")).toEqual([]);
  for (let turn = 1; turn <= 2; turn++) {
    assistant.lastMessage = { content: [{ type: "thinking", thinking: `THINKING ${turn}` }] };
    assistant.contentIsStale = true;
    const thinking = index.entries("activity")[0];
    expect(visible(thinking.component as Container)).toContain(`THINKING ${turn}`);
    expect(index.entries("chat").some(entry => entry.source === assistant)).toBe(false);
    // The provider can mutate a partial message in place between frames.
    assistant.lastMessage.content.push({ type: "text", text: `ANSWER ${turn}` });
    assistant.contentIsStale = true;
    const chat = index.entries("chat").find(entry => entry.source === assistant)!;
    const activity = index.entries("activity")[0];
    expect(visible(chat.component as Container)).toContain(`ANSWER ${turn}`);
    expect(visible(chat.component as Container)).not.toContain("THINKING");
    expect(visible(activity.component as Container)).toContain(`THINKING ${turn}`);
    expect(visible(activity.component as Container)).not.toContain("ANSWER");
    expect(visible(assistant)).toContain(`THINKING ${turn}`);
    expect(visible(assistant)).toContain(`ANSWER ${turn}`);
    expect(assistant.contentContainer.children).toHaveLength(2);
  }
});

test("rejects deferred assistant content without a native builder instead of silently misrouting it", () => {
  const assistant = new AssistantMessageComponent();
  Object.assign(assistant, { contentIsStale: true });
  expect(() => setup(assistant).index.entries("chat")).toThrow("deferred assistant content is not supported");
});