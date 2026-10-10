import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { highlightSearchRows } from "../src/search-highlight.js";
import type { SearchHit } from "../src/search.js";

const source: Component = { render: () => [], invalidate() {} };
const hit = (text: string, line = 0, saved = text): SearchHit => ({ entry: { source, label: "User", text: saved }, line, text });
const colors = (highlighted: string[]): Theme => ({
  style: (text: string) => { highlighted.push(text); return "\x1b[30;43m" + text + "\x1b[39;49m"; },
}) as unknown as Theme;
const plain = (rows: string[]): string[] => rows.map(stripTerminalSequences);

test("highlights contiguous exact text rather than earlier scattered letters", () => {
  const rows = ["s e a r c h then SEARCH INPUT"];
  const highlighted: string[] = [];
  const exactHit = { ...hit(rows[0]), exact: true };
  const after = highlightSearchRows(rows, exactHit, "search input", colors(highlighted));
  expect(highlighted.join("")).toBe("SEARCH INPUT");
  expect(after[0].startsWith("s e a r c h then ")).toBe(true);
  expect(plain(after)).toEqual(rows);
});
test("highlights every literal occurrence in the selected line, including punctuation", () => {
  const rows = ["a/b and A/B"];
  const highlighted: string[] = [];
  highlightSearchRows(rows, { ...hit(rows[0]), exact: true }, "/", colors(highlighted));
  expect(highlighted.join("")).toBe("//");
});

test("keeps exact highlight offsets after a case fold expands an earlier character", () => {
  const rows = ["İ then SEARCH"];
  const highlighted: string[] = [];
  highlightSearchRows(rows, { ...hit(rows[0]), exact: true }, "search", colors(highlighted));
  expect(highlighted.join("")).toBe("SEARCH");
});
const checkText = (before: string[], after: string[]): void => {
  expect(plain(after)).toEqual(plain(before));
  expect(after.map(visibleWidth)).toEqual(before.map(visibleWidth));
};

test("highlights fuzzy tokens across wrapped native rows without touching the clock or OSC markers", () => {
  const marker = "\x1b]133;A\x07";
  const rows = [marker + "\x1b[32mdeployment\x1b[0m       12:34:56", "\x1b[34mruntime ready\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("deployment runtime ready"), "dply/rntm", colors(highlighted), { row: 0, column: 10 });
  checkText(rows, after);
  expect(highlighted.join("")).toBe("dplyrntm");
  expect(after.join("").split(marker)).toHaveLength(2);
  expect(after[0]).toContain("       12:34:56");
  expect(after[0]).toContain("\x1b[0m\x1b[32m");
});

test("uses saved occurrence identity to highlight only the second repeated line", () => {
  const rows = ["same result", "", "same result"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("same result", 2, "same result\n\nsame result"), "smrslt", colors(highlighted));
  expect(after.slice(0, 2)).toEqual(rows.slice(0, 2));
  expect(after[2]).not.toBe(rows[2]);
  expect(highlighted.join("")).toBe("smrslt");
  checkText(rows, after);
});

test("skips earlier substring occurrences when highlighting a standalone later line", () => {
  const rows = ["worker ready ready", "ready"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("ready", 1, rows.join("\n")), "rdy", colors(highlighted));
  expect(after[0]).toBe(rows[0]);
  expect(after[1]).not.toBe(rows[1]);
  expect(highlighted.join("")).toBe("rdy");
  checkText(rows, after);
});

test("highlights a genuine saved trailing timestamp without mistaking it for a clock", () => {
  const rows = ["finished at 12:34:56"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit(rows[0]), "12:34:56", colors(highlighted));
  expect(highlighted.join("")).toBe("12:34:56");
  checkText(rows, after);
});
test("excludes an actual clock gutter while keeping the same digits in saved text", () => {
  const rows = ["header      12:34:56", "finished at 12:34:56"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("finished at 12:34:56", 1, "header\nfinished at 12:34:56"),
    "12:34:56", colors(highlighted), { row: 0, column: 6 });
  expect(after[0]).toBe(rows[0]);
  expect(after[1]).not.toBe(rows[1]);
  expect(highlighted.join("")).toBe("12:34:56");
  checkText(rows, after);
});
test("keeps Russian, wide characters, combining graphemes and emoji intact", () => {
  const rows = ["\x1b[35m界界 Запуск e\u0301 ✅\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("界界 Запуск e\u0301 ✅"), "界/ЗПСК/é/✅", colors(highlighted));
  checkText(rows, after);
  expect(highlighted).toEqual(["界", "З", "п", "с", "к", "e\u0301", "✅"]);
});

test("maps saved Markdown text to formatted native text and leaves native hyperlinks untouched", () => {
  const open = "\x1b]8;;https://example.test\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  const rows = ["\x1b[1m" + open + "worker ready" + close + "\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("**worker ready**"), "wrkr rdy", colors(highlighted));
  checkText(rows, after);
  // Fuzzy tokens match independently, so their first matching r can overlap.
  expect(highlighted.join("")).toBe("wrkrdy");
  expect(after[0].split(open)).toHaveLength(2);
  expect(after[0].split(close)).toHaveLength(2);
});

test("restores a native background and style after each highlighted character", () => {
  const rows = ["\x1b[44m\x1b[31mworker ready\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("worker ready"), "wrk", colors(highlighted));
  checkText(rows, after);
  expect(after[0]).toContain("\x1b[0m\x1b[44m\x1b[31mer ready\x1b[0m");
});

test("does not separate combining text when an ANSI change occurs inside the grapheme", () => {
  const rows = ["e\x1b[31m\u0301 ready\x1b[0m"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit("e\u0301 ready"), "é", colors(highlighted));
  checkText(rows, after);
  expect(highlighted.join("")).toBe("e\u0301");
});
test("supports native numeric-letter token swapping without highlighting unrelated text", () => {
  const rows = ["12 worker ready"];
  const highlighted: string[] = [];
  const after = highlightSearchRows(rows, hit(rows[0]), "worker12", colors(highlighted));
  checkText(rows, after);
  expect(highlighted.join("")).toBe("12worker");
});

test("returns the original rows for empty, absent and unmapped matches", () => {
  const rows = ["native custom header"];
  for (const query of ["", " ", "missing"]) {
    expect(highlightSearchRows(rows, hit("native custom header"), query, colors([]))).toBe(rows);
  }
  expect(highlightSearchRows(rows, hit("saved hidden text"), "saved", colors([]))).toBe(rows);
});

test.each(["\x1b_Ga=T;AAAA\x1b\\", "\x1b]1337;File=AAAA\x07", "\x1bPqAAAA\x1b\\"])("does not touch native image placement %s", image => {
  const rows = ["worker ready", image];
  expect(highlightSearchRows(rows, hit("worker ready"), "worker", colors([]))).toBe(rows);
});
