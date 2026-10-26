import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.js";
import { NativeDocument } from "../src/native.js";
import { TranscriptTimestamps } from "../src/timestamps.js";

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
const theme = { fg: (color: string, text: string) => `\x1b[${color === "success" ? 32 : color === "error" ? 31 : 33}m${text}\x1b[0m` } as Theme;
function setup(...components: Component[]) {
  const history = new Container(); history.children = components;
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const index = new NativeContentIndex(source);
  let compact = true;
  let copied: string | undefined;
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => true,
    undefined, true, index, text => { copied = text; }, () => true, () => compact);
  const render = (width = 80) => { document.beginFrame(); return document.render(width).map(stripTerminalSequences); };
  return { history, index, document, render, toggle: () => { compact = !compact; }, copied: () => copied };
}

test("every consecutive call gets one row, with reasoning separating dense groups", () => {
  const one = new ToolExecutionComponent("one", { path: "FIRST-FIXTURE" });
  const two = new ToolExecutionComponent("two", { command: "SECOND-FIXTURE" });
  const three = new ToolExecutionComponent("three", { query: "THIRD-FIXTURE" });
  const { render } = setup(one, two, new AssistantMessageComponent(), three);
  const lines = render();
  expect(lines.filter(line => line.includes(one.toolName))).toHaveLength(3);
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
