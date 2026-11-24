import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { CompactTool } from "../src/compact-tools.ts";
import { NestedCalls } from "../src/nested-calls.ts";
import { usageLabel } from "../src/recorded-metrics.ts";

const theme = { fg: (_: string, text: string) => text } as Theme;
const end = { toolCallId: "root/1", isError: false, durationMs: 43, result: { usage: { input: 789, cost: { total: 0.0023 } } } };
const saved = { role: "toolResult", toolCallId: "root", usage: { input: 789, cost: { total: 0.0023 } },
  nestedCalls: { complete: true, calls: [{ id: "root/1", name: "fixture", status: "ok", durationMs: 51 }] } };

test("nested calls keep individual live measurements and restore recorded measurements by ID", () => {
  const calls = new NestedCalls();
  calls.start({ parentToolCallId: "root", toolCallId: "root/1", toolName: "fixture", args: {} });
  calls.end(end);
  expect(calls.entries("root")[0]).toMatchObject({ durationMs: 43, usage: end.result.usage });
  calls.absorb(saved);
  expect(calls.entries("root")[0]).toMatchObject({ durationMs: 51, usage: end.result.usage });
  expect(calls.rootUsage("root")).toEqual({ usage: saved.usage, inclusive: true });
  calls.restore([{ type: "message", message: saved }]);
  expect(calls.entries("root")[0].durationMs).toBe(51);
  expect(calls.entries("root")[0].usage).toBeUndefined();
  expect(calls.rootUsage("root")).toEqual({ usage: saved.usage, inclusive: true });
});

test("tool duration and usage visibility change independently on an already rendered call", () => {
  let durations = false;
  let usage = false;
  const row = new CompactTool(() => ({ name: "fixture", args: { path: "fixture-path" }, status: "success",
    durationMs: 43, usage: { input: 789, output: 123, cost: { total: 0.0023 } } }), () => theme,
    { metrics: { durations: () => durations, usage: () => usage } });
  const render = () => row.render(21).map(stripTerminalSequences);
  expect(render().join("\n")).not.toMatch(/43|789|123|0\.0023/);
  durations = true;
  expect(render()[0]).toMatch(/fixture\s+43/);
  expect(row.render(12).join("\n")).toMatch(/43/);
  expect(render().join("\n")).not.toMatch(/789|123|0\.0023/);
  durations = false;
  usage = true;
  expect(render().join("\n")).not.toMatch(/43/);
  expect(render().join("\n")).toMatch(/789[\s\S]*123[\s\S]*0\.0023/);
  expect(render().every(line => visibleWidth(line) <= 21)).toBe(true);
});

test("empty response accounting does not hide measured zero fields on a metered response", () => {
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
  expect(usageLabel(empty, "response")).toBe("");
  expect(usageLabel({ ...empty, input: 789 }, "response")).toMatch(/789/);
  expect(usageLabel({ ...empty, input: 789 }, "response")).toMatch(/0.*\$0\.00/);
  expect(usageLabel(empty, "tool")).toMatch(/\$0\.00/);
});
