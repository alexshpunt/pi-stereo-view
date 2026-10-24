import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeDocument } from "../src/native.js";
import { TranscriptTimestamps } from "../src/timestamps.js";
import type { SearchHit } from "../src/search.js";

class UserMessageComponent extends Text {}

class ThemedText extends Text {
  stale = false;
  renders = 0;
  private pendingText?: string;
  update(text: string): void { this.pendingText = text; this.invalidate(); }
  override invalidate(): void { super.invalidate(); this.stale = true; }
  override render(width: number): string[] {
    if (this.stale && this.pendingText !== undefined) super.setText(this.pendingText);
    this.stale = false;
    this.renders++;
    return super.render(width);
  }
}

test("keeps all native system text in Conversation without classifying its wording", () => {
  const notice = new ThemedText("\x1b[2mSession compacted 2 times\x1b[22m", 1, 0);
  const status = new ThemedText("Tool output: expanded", 1, 0);
  const history = new Container();
  history.addChild(notice);
  history.addChild(status);
  const source = new Container();
  source.addChild(new Container());
  source.addChild(new Container());
  source.addChild(history);
  const timestamps = new TranscriptTimestamps({
    buildContextEntries: () => [], getBranch: () => [],
  } as unknown as ExtensionContext["sessionManager"]);
  const chat = new NativeDocument(source, "chat", timestamps, () => colors, () => 0, () => false);
  const activity = new NativeDocument(source, "activity", timestamps, () => colors, () => 0, () => false);
  try {
    expect(chat.render(60).map(stripTerminalSequences).join("\n")).toContain("Session compacted 2 times");
    expect(activity.render(60).map(stripTerminalSequences).join("\n")).not.toContain("Session compacted");
    expect(chat.render(60).map(stripTerminalSequences).join("\n")).toContain("Tool output: expanded");
    expect(chat.searchEntries().map(entry => entry.text.trim())).toEqual(["Session compacted 2 times", "Tool output: expanded"]);
    expect(activity.searchEntries()).toEqual([]);
    const renders = notice.renders;
    chat.beginFrame();
    activity.beginFrame();
    chat.render(60);
    activity.render(60);
    expect(notice.renders, "Warm status classification must not rerender native text").toBe(renders);
    notice.update("Tool output: collapsed");
    chat.invalidate();
    activity.invalidate();
    expect(chat.render(60).map(stripTerminalSequences).join("\n")).toContain("Tool output: collapsed");
    expect(activity.render(60).map(stripTerminalSequences).join("\n")).not.toContain("Tool output:");
  } finally {
    chat.dispose();
    activity.dispose();
  }
});

class CompactionSummaryMessageComponent extends Text {
  readonly message = { summary: "COMPACTION CONTEXT" };
  setExpanded(expanded: boolean): void { this.setText(expanded ? this.message.summary : "[compaction]"); }
}

test("routes compaction painting and saved summary search only to Conversation", () => {
  const compact = new CompactionSummaryMessageComponent("[compaction]", 0, 0);
  const history = new Container();
  history.addChild(compact);
  const source = new Container();
  source.addChild(new Container());
  source.addChild(new Container());
  source.addChild(history);
  const timestamps = new TranscriptTimestamps({
    buildContextEntries: () => [], getBranch: () => [],
  } as unknown as ExtensionContext["sessionManager"]);
  const chat = new NativeDocument(source, "chat", timestamps, () => colors, () => 0, () => false);
  const activity = new NativeDocument(source, "activity", timestamps, () => colors, () => 0, () => false);
  try {
    expect(chat.render(60).map(stripTerminalSequences).join("\n")).toContain("[compaction]");
    expect(activity.render(60).map(stripTerminalSequences).join("\n")).not.toContain("[compaction]");
    const entries = chat.searchEntries();
    expect(entries.map(entry => entry.text)).toEqual(["COMPACTION CONTEXT"]);
    expect(activity.searchEntries()).toEqual([]);
    const hit = { entry: entries[0], line: 0, text: entries[0].text, ranges: [{ start: 0, end: 10 }] };
    expect(chat.reveal(hit, "COMPACTION")).toBe(true);
    expect(chat.render(60).map(stripTerminalSequences).join("\n")).toContain("COMPACTION CONTEXT");
  } finally {
    chat.dispose();
    activity.dispose();
  }
});
const colors = {
  fg: (_name: string, value: string) => value,
  style: (value: string) => "\x1b[30;43m" + value + "\x1b[39;49m",
} as unknown as Theme;

const setup = (text: string, showTimestamps: boolean): { document: NativeDocument; hit: (line: number) => SearchHit } => {
  const user = new UserMessageComponent(text, 0, 0);
  const history = new Container();
  history.addChild(user);
  const source = new Container();
  source.addChild(new Container());
  source.addChild(new Container());
  source.addChild(history);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [{
    type: "message", id: "user", parentId: null, timestamp: "2001-10-09T12:34:56Z",
    message: { role: "user", content: text, timestamp: Date.parse("2001-10-09T12:34:56Z") },
  }], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "chat", timestamps, () => colors, () => 0, () => showTimestamps);
  return { document, hit: line => ({ entry: { source: user, label: "User", text }, line, text: text.split("\n")[line] }) };
};

test("navigates and highlights the standalone occurrence after preceding substring collisions", () => {
  const { document, hit } = setup("worker ready ready\nready", false);
  document.render(50);
  const selected = { ...hit(1), ranges: [{ start: 0, end: 5 }] };
  expect(document.reveal(selected, "ready")).toBe(true);
  expect(document.searchRow(selected), "Async result navigation must not depend on the next paint").toBe(1);
  const rows = document.render(50);
  expect(document.searchRow(selected)).toBe(1);
  expect(rows[0]).not.toContain("\x1b[30;43m");
  expect(rows[1]).toContain("\x1b[30;43m");
  expect(rows.slice(0, 2).map(stripTerminalSequences).map(line => line.trim())).toEqual(["worker ready ready", "ready"]);
  document.dispose();
});

test.each([false, true])("keeps genuine saved timestamps searchable with display clocks %s", showTimestamps => {
  const { document, hit } = setup("first line\nfinished at 12:34:56", showTimestamps);
  const selected = { ...hit(1), ranges: [{ start: 12, end: 20 }] };
  document.reveal(selected, "12:34:56");
  const rows = document.render(50);
  const savedRow = showTimestamps ? 2 : 1;
  expect(document.searchRow(selected)).toBe(savedRow);
  expect(rows[savedRow]).toContain("\x1b[30;43m1");
  expect(stripTerminalSequences(rows[savedRow]).trim()).toBe("finished at 12:34:56");
  if (showTimestamps) {
    expect(rows[0]).not.toContain("\x1b[30;43m");
    expect(stripTerminalSequences(rows[0])).toMatch(/^ \d{2}:\d{2}:\d{2}$/);
  }
  document.dispose();
});
