import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ContentEntry, ToolSummary } from "../src/content.ts";
import { toolGroups } from "../src/tool-groups.ts";
import { ToolStreaming } from "../src/tool-streaming.ts";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const call = (status: { value: ToolSummary["status"] }, name = "read"): ContentEntry => {
  const source = {} as Component;
  return { source, owner: source, component: source, kind: "tool", spacing: [], compact: false,
    search: () => ({ label: name, text: "" }), tool: () => ({ name, args: {}, status: status.value }) } as ContentEntry;
};

test("a call stays live for the delay after it finishes, then collapses and asks for a frame", () => {
  const changed = vi.fn();
  const streaming = new ToolStreaming(() => 5000, changed);
  const status = { value: "running" as ToolSummary["status"] };
  const entry = call(status);
  streaming.observe([entry]);
  expect(streaming.isLive(entry.source)).toBe(true);
  status.value = "success";
  streaming.observe([entry]);
  vi.advanceTimersByTime(4900);
  expect(changed).not.toHaveBeenCalled();
  streaming.observe([entry]);
  expect(streaming.isLive(entry.source)).toBe(true);
  vi.advanceTimersByTime(200);
  expect(changed).toHaveBeenCalledTimes(1);
  streaming.observe([entry]);
  expect(streaming.isLive(entry.source)).toBe(false);
  streaming.dispose();
});

test("calls that are already finished on first sight were never live", () => {
  const streaming = new ToolStreaming(() => 5000, vi.fn());
  const entry = call({ value: "success" });
  streaming.observe([entry]);
  expect(streaming.isLive(entry.source)).toBe(false);
  streaming.observe([entry]);
  expect(streaming.isLive(entry.source)).toBe(false);
});

test("concurrent calls collapse on their own timers", () => {
  const streaming = new ToolStreaming(() => 5000, vi.fn());
  const first = { value: "running" as ToolSummary["status"] };
  const second = { value: "running" as ToolSummary["status"] };
  const a = call(first), b = call(second);
  streaming.observe([a, b]);
  first.value = "success";
  streaming.observe([a, b]);
  vi.advanceTimersByTime(3000);
  second.value = "success";
  streaming.observe([a, b]);
  vi.advanceTimersByTime(2100);
  streaming.observe([a, b]);
  expect([streaming.isLive(a.source), streaming.isLive(b.source)]).toEqual([false, true]);
  vi.advanceTimersByTime(3000);
  streaming.observe([a, b]);
  expect(streaming.isLive(b.source)).toBe(false);
});

test("a released call does not become live again", () => {
  const streaming = new ToolStreaming(() => 5000, vi.fn());
  const entry = call({ value: "running" });
  streaming.observe([entry]);
  streaming.release(entry.source);
  streaming.observe([entry]);
  expect(streaming.isLive(entry.source)).toBe(false);
});

test("live calls neither join nor split a group; collapsed neighbours merge", () => {
  const present = (name: string) => ({ name, key: name });
  const status = { value: "success" as ToolSummary["status"] };
  const [a, b, c] = [call(status), call(status), call(status)];
  const live = new Set([b.source]);
  const groups = toolGroups([a, b, c], present, source => live.has(source));
  expect(groups.has(b.source)).toBe(false);
  expect(groups.get(a.source)!.calls).toHaveLength(1);
  expect(groups.get(c.source)!.calls).toHaveLength(1);
  live.clear();
  expect(toolGroups([a, b, c], present, source => live.has(source)).get(a.source)!.calls).toHaveLength(3);
});
