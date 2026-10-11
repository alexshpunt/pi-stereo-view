import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { highlightSearchRows } from "../src/search-highlight.js";
import type { SearchHit } from "../src/search.js";

const source: Component = { render: () => [], invalidate() {} };
const hit = (text: string, ranges: { start: number; end: number }[], line = 0, saved = text): SearchHit =>
  ({ entry: { source, label: "User", text: saved }, line, text, ranges });
const colors = (highlighted: string[]): Theme => ({
  style: (text: string) => { highlighted.push(text); return "\x1b[30;43m" + text + "\x1b[39;49m"; },
}) as unknown as Theme;
const checkText = (before: string[], after: string[]): void => {
  expect(after.map(stripTerminalSequences)).toEqual(before.map(stripTerminalSequences));
  expect(after.map(visibleWidth)).toEqual(before.map(visibleWidth));
};

test("highlights actual positive regex and Boolean spans, not the query's syntax or scattered letters", () => {
  const rows = ["s e a r c h then SEARCH INPUT ready"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit(rows[0], [{ start: 16, end: 29 }, { start: 30, end: 35 }]), colors(highlighted));
  expect(highlighted.join("")).toBe("SEARCH INPUTready");
  expect(after[0].startsWith("s e a r c h then ")).toBe(true);
  checkText(rows, after);
});
test("highlights every literal punctuation span and keeps offsets after case folding", () => {
  const rows = ["İ then a/b and A/B"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit(rows[0], [{ start: 8, end: 9 }, { start: 16, end: 17 }]), colors(highlighted));
  expect(highlighted.join("")).toBe("//");
  checkText(rows, after);
});
test("highlights across wrapped native rows without touching clocks, styles or OSC markers", () => {
  const marker = "\x1b]133;A\x07";
  const rows = [marker + "\x1b[32mdeployment\x1b[0m       12:34:56", "\x1b[34mruntime ready\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("deployment runtime ready", [{ start: 0, end: 18 }]), colors(highlighted), { row: 0, column: 10 });
  expect(highlighted.join("")).toBe("deploymentruntime");
  expect(after.join("").split(marker)).toHaveLength(2);
  expect(after[0]).toContain("       12:34:56");
  expect(after[0]).toContain("\x1b[0m\x1b[32m");
  checkText(rows, after);
});
test("uses saved occurrence identity, including earlier substring collisions", () => {
  const rows = ["worker ready ready", "ready", "", "ready"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("ready", [{ start: 0, end: 5 }], 3, rows.join("\n")), colors(highlighted));
  expect(after.slice(0, 3)).toEqual(rows.slice(0, 3));
  expect(highlighted.join("")).toBe("ready");
  checkText(rows, after);
});
test("keeps real saved timestamps searchable and excludes only the actual clock gutter", () => {
  const rows = ["header      12:34:56", "finished at 12:34:56"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit(rows[1], [{ start: 12, end: 20 }], 1, "header\n" + rows[1]), colors(highlighted), { row: 0, column: 6 });
  expect(after[0]).toBe(rows[0]);
  expect(highlighted.join("")).toBe("12:34:56");
  checkText(rows, after);
});
test("keeps Russian, wide characters, combining graphemes and emoji intact", () => {
  const rows = ["\x1b[35m界界 Запуск e\u0301 ✅\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("界界 Запуск e\u0301 ✅", [{ start: 0, end: 14 }]), colors(highlighted));
  expect(highlighted.join("")).toBe("界界 Запуск e\u0301 ✅");
  checkText(rows, after);
});
test("maps saved Markdown and preserves native hyperlinks byte for byte", () => {
  const open = "\x1b]8;;https://example.test\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  const rows = ["\x1b[1m" + open + "worker ready" + close + "\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("**worker ready**", [{ start: 2, end: 14 }]), colors(highlighted));
  expect(highlighted.join("")).toBe("worker ready");
  expect(after[0].split(open)).toHaveLength(2);
  expect(after[0].split(close)).toHaveLength(2);
  checkText(rows, after);
});
test("restores native backgrounds and styles outside matching spans", () => {
  const rows = ["\x1b[44m\x1b[31mworker ready\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("worker ready", [{ start: 0, end: 6 }]), colors(highlighted));
  expect(after[0]).toContain("\x1b[0m\x1b[44m\x1b[31m ready\x1b[0m");
  checkText(rows, after);
});
test("does not split combining text when ANSI changes inside the grapheme", () => {
  const rows = ["e\x1b[31m\u0301 ready\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("e\u0301 ready", [{ start: 0, end: 2 }]), colors(highlighted));
  expect(highlighted.join("")).toBe("e\u0301");
  checkText(rows, after);
});
test("highlights whitespace-only regex spans and a combining mark as its whole native grapheme", () => {
  for (const [text, range, expected] of [
    ["worker  ready", { start: 6, end: 8 }, "  "],
    ["e\u0301 ready", { start: 1, end: 2 }, "e\u0301"],
  ] as const) {
    const highlighted: string[] = [];
    const rows = [text];
    const after = highlightSearchRows(rows, hit(text, [range]), colors(highlighted));
    expect(highlighted.join("")).toBe(expected);
    checkText(rows, after);
  }
});
test("empty spans, zero-width matches and unmapped excerpts leave rows alone", () => {
  const rows = ["native custom header"];
  for (const ranges of [[], [{ start: 0, end: 0 }]]) {
    expect(highlightSearchRows(rows, hit(rows[0], ranges), colors([]))).toBe(rows);
  }
  expect(highlightSearchRows(rows, hit("saved hidden text", [{ start: 0, end: 5 }]), colors([]))).toBe(rows);
});
test.each(["\x1b_Ga=T;AAAA\x1b\\", "\x1b]1337;File=AAAA\x07", "\x1bPqAAAA\x1b\\"])("does not touch native image placement %s", image => {
  const rows = ["worker ready", image];
  expect(highlightSearchRows(rows, hit("worker ready", [{ start: 0, end: 6 }]), colors([]))).toBe(rows);
});
