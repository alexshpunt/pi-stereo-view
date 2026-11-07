import { SessionManager, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown as NativeMarkdown, Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { CompactTool } from "../src/compact-tools.js";
import { timestampLabel, TOOL_START_ENTRY, TranscriptTimestamps } from "../src/timestamps.js";
import { ToolIndent } from "../src/tool-indent.js";
import { NativeDocument } from "../src/native.js";
import type { ToolSummary } from "../src/content.js";

const theme = { fg: (_color: string, text: string) => text, style: (text: string) => text } as unknown as Theme;
class ToolExecutionComponent extends Text {
  constructor(readonly toolCallId: string) { super("", 0, 0); }
}
const assistant = (id: string, timestamp: number): AssistantMessage => ({
  role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "true" } }], timestamp,
  api: "openai-responses", provider: "openai", model: "fixture", stopReason: "toolUse",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test("a streamed call header follows arguments that change in place, then its final state", () => {
  const args = { command: "BEFORE-FIXTURE" };
  let status: ToolSummary["status"] = "running";
  const row = new CompactTool(() => ({ name: "bash", args, status }), () => theme);
  expect(row.render(60)[0]).toContain("BEFORE-FIXTURE");
  args.command = "AFTER-FIXTURE";
  expect(row.render(60)[0]).toContain("AFTER-FIXTURE");
  status = "success";
  const done = row.render(60)[0];
  expect(done).toContain("AFTER-FIXTURE");
  expect(row.render(12)[0].length).toBeLessThan(done.length);
});

test("hierarchy guides follow changed native rows", () => {
  const body = new Text("FIRST-FIXTURE", 0, 0);
  const indent = new ToolIndent(body, 1, true, () => theme);
  expect(indent.render(40).join("\n")).toContain("FIRST-FIXTURE");
  body.setText("SECOND-FIXTURE");
  const lines = indent.render(40);
  expect(lines.join("\n")).toContain("SECOND-FIXTURE");
  expect(lines.join("\n")).not.toContain("FIRST-FIXTURE");
});

test("tool clocks follow new start records and branch changes in a real session", () => {
  const session = SessionManager.inMemory("/tmp");
  const saved = Date.parse("2026-01-01T10:00:00Z");
  const started = Date.parse("2026-01-01T10:05:07Z");
  const call = session.appendMessage(assistant("one", saved));
  const tool: Component = new ToolExecutionComponent("one");
  const timestamps = new TranscriptTimestamps(session as unknown as ExtensionContext["sessionManager"]);
  const label = (): string => {
    timestamps.beginFrame();
    timestamps.prepare([tool]);
    return stripTerminalSequences(timestamps.label(tool));
  };
  expect(label()).toBe("~" + timestampLabel(saved));
  expect(label()).toBe("~" + timestampLabel(saved));
  session.appendCustomEntry(TOOL_START_ENTRY, { toolCallId: "one", time: started });
  expect(label()).toBe(timestampLabel(started));
  session.branch(call);
  expect(label()).toBe("~" + timestampLabel(saved));
});

// Content routing identifies native Markdown by its class name.
const CountedMarkdown = class Markdown extends NativeMarkdown {
  renders = 0;
  override render(width: number): string[] { this.renders++; return super.render(width); }
};
type CountedMarkdown = InstanceType<typeof CountedMarkdown>;
class AssistantMessageComponent extends Container {
  contentContainer = new Container();
  hasToolCalls = false;
  lastMessage: { content: { type: string; text: string }[] };
  constructor(value: string) {
    super();
    this.addChild(this.contentContainer);
    this.lastMessage = { content: [{ type: "text", text: value }] };
    this.contentContainer.addChild(new CountedMarkdown(value, 0, 0, markdownTheme));
  }
  /** Pi replaces the content children on every streamed delta. */
  stream(value: string): void {
    this.lastMessage = { content: [{ type: "text", text: value }] };
    this.contentContainer.clear();
    this.contentContainer.addChild(new CountedMarkdown(value, 0, 0, markdownTheme));
  }
  setHideThinkingBlock(): void {}
}
const identity = (text: string): string => text;
const markdownTheme = { heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity, codeBlockBorder: identity,
  quote: identity, quoteBorder: identity, hr: identity, listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity };

test("streaming one answer does not re-render the rest of the conversation", () => {
  const earlier = new AssistantMessageComponent("EARLIER-FIXTURE");
  const streamed = new AssistantMessageComponent("STREAM-1");
  const history = new Container();
  history.children = [earlier, streamed];
  const source = new Container();
  source.children = [new Container(), new Container(), history];
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "chat", timestamps, () => theme, () => 0, () => false);
  const frame = (): string => { document.beginFrame(); timestamps.beginFrame(); return document.render(60).map(stripTerminalSequences).join("\n"); };
  expect(frame()).toContain("EARLIER-FIXTURE");
  const first = earlier.contentContainer.children[0] as CountedMarkdown;
  const renders = first.renders;
  for (const value of ["STREAM-2", "STREAM-3"]) {
    streamed.stream(value);
    const lines = frame();
    expect(lines).toContain(value);
    expect(lines).toContain("EARLIER-FIXTURE");
  }
  expect(first.renders).toBe(renders);
});
