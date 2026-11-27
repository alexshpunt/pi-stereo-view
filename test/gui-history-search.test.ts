import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { GuiHistorySearch } from "../src/gui-search.ts";
import { NativeDocument } from "../src/native.ts";
import { TranscriptTimestamps } from "../src/timestamps.ts";

class UserMessageComponent extends Text {}
class CompactionSummaryMessageComponent extends Text {
  readonly message = { summary: "hidden important result" };
  setExpanded(expanded: boolean): void { this.setText(expanded ? this.message.summary : "[compact]"); }
}
const theme = { fg: (_name: string, value: string) => value, style: (value: string) => value } as unknown as Theme;
function documentFor(...blocks: Text[]) {
  const history = new Container(); for (const block of blocks) history.addChild(block);
  const root = new Container(); root.addChild(new Container()); root.addChild(new Container()); root.addChild(history);
  const times = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(root, "chat", times, () => theme, () => 0, () => false);
  document.render(60);
  return { document, history };
}

test("searches each panel independently, navigates matches and restores scroll state", async () => {
  const chat = documentFor(new UserMessageComponent("old ready", 0, 0), new UserMessageComponent("new READY", 0, 0));
  const activity = documentFor(new UserMessageComponent("independent ready", 0, 0));
  const search = new GuiHistorySearch({ chat: chat.document, activity: activity.document });
  try {
    search.open("chat", { top: 12, height: 1, following: false });
    let result = await search.query("chat", "ready");
    expect(result).toMatchObject({ open: true, count: 2, current: 1, following: false });
    expect(result.top).toBeGreaterThanOrEqual(0);
    const first = result.top;
    const resized = search.resize("chat", 5);
    expect(resized.top).toBe(Math.max(0, first! - 2));
    search.resize("chat", 1);
    result = search.step("chat", 1);
    expect(result.current).toBe(2);
    expect(result.top).not.toBe(first);
    expect(search.step("chat", 1).current).toBe(1);
    search.open("activity", { top: 4, height: 3, following: true });
    expect((await search.query("activity", "independent")).count).toBe(1);
    expect(search.state("chat").count).toBe(2);
    expect(search.close("chat")).toEqual({ top: 12, following: false });
    expect(search.close("activity")).toEqual({ top: 4, following: true });
  } finally { search.dispose(); chat.document.dispose(); activity.document.dispose(); }
});

test("finds saved content not currently visible and clears temporary search state", async () => {
  const compact = new CompactionSummaryMessageComponent("[compact]", 0, 0);
  const chat = documentFor(compact);
  const activity = documentFor();
  const search = new GuiHistorySearch({ chat: chat.document, activity: activity.document });
  try {
    expect(chat.document.render(60).join("\n")).not.toContain("hidden important result");
    search.open("chat", { top: 0, height: 3, following: false });
    expect((await search.query("chat", "important")).count).toBe(1);
    expect(chat.document.render(60).map(stripTerminalSequences).join("\n")).toContain("hidden important result");
    expect((await search.query("chat", "")).count).toBe(0);
    expect(search.close("chat")).toEqual({ top: 0, following: false });
  } finally { search.dispose(); chat.document.dispose(); activity.document.dispose(); }
});

test("invalid search queries report errors and later valid queries recover", async () => {
  const chat = documentFor(new UserMessageComponent("ready now", 0, 0));
  const activity = documentFor();
  const search = new GuiHistorySearch({ chat: chat.document, activity: activity.document });
  try {
    search.open("chat", { top: 2, height: 5, following: false });
    const invalid = await search.query("chat", "ready AND");
    expect(invalid.error).toBeTruthy();
    expect(invalid.count).toBe(0);
    const valid = await search.query("chat", "ready AND now");
    expect(valid.error).toBeUndefined();
    expect(valid.count).toBe(1);
    const badRegex = await search.query("chat", "regex:[");
    expect(badRegex.error).toBeTruthy();
    expect(badRegex.count).toBe(0);
    expect((await search.query("chat", "ready")).count).toBe(1);
  } finally { search.dispose(); chat.document.dispose(); activity.document.dispose(); }
});

test("refreshes an open search after its history changes", async () => {
  const chat = documentFor(new UserMessageComponent("ready now", 0, 0)), activity = documentFor();
  const search = new GuiHistorySearch({ chat: chat.document, activity: activity.document });
  try {
    search.open("chat", { top: 0, height: 4, following: false });
    expect((await search.query("chat", "ready")).count).toBe(1);
    chat.history.addChild(new UserMessageComponent("ready again", 0, 0));
    search.markDirty("chat");
    await search.refresh("chat");
    expect(search.state("chat").count).toBe(2);
  } finally { search.dispose(); chat.document.dispose(); activity.document.dispose(); }
});

test("newer searches cancel in-flight regex and history refresh drops removed results", async () => {
  const item = new UserMessageComponent("ready now", 0, 0);
  const chat = documentFor(item), activity = documentFor();
  const search = new GuiHistorySearch({ chat: chat.document, activity: activity.document });
  try {
    search.open("chat", { top: 0, height: 4, following: false });
    const stale = search.query("chat", "regex:ready(?= now)");
    const fresh = await search.query("chat", "now");
    await stale;
    expect(search.state("chat")).toMatchObject({ query: "now", count: 1, current: 1, pending: false });
    expect(fresh.count).toBe(1);
    chat.history.clear();
    search.markDirty("chat");
    expect((await search.query("chat", "now")).count).toBe(0);
    const cancelled = search.query("chat", "regex:ready");
    search.close("chat");
    await cancelled;
    expect(search.state("chat").open).toBe(false);
  } finally { search.dispose(); chat.document.dispose(); activity.document.dispose(); }
});
