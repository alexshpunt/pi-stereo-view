import { expect, test } from "vitest";
// The mod is JavaScript, loaded directly by Herdr.
// @ts-expect-error The parser does not have TypeScript declarations.
import { parseAnsi, plainAnsi } from "../herdr/mods/stereo-view/ansi.js";

test("hides Pi cursor markers while retaining the visible cursor cell", () => {
  expect(plainAnsi("> \x1b_pi:c\x07\x1b_pi:fc\x07 \x1b_pi:/fc\x07" )).toBe(">  ");
  expect(plainAnsi("a\x1b_private\x1b\\b")).toBe("ab");
});

test("preserves hyperlinks across color changes and closes them independently of style", () => {
  const input = "before \x1b]8;id=abc;https://example.com/a;b\x1b\\red\x1b[31m alert\x1b[0m normal\x1b]8;;\x07 after";
  const runs = parseAnsi(input);
  expect(runs.map((run: { text: string; link?: string }) => [run.text, run.link])).toEqual([
    ["before ", undefined], ["red", "https://example.com/a;b"],
    [" alert", "https://example.com/a;b"], [" normal", "https://example.com/a;b"], [" after", undefined],
  ]);
  expect(runs[2].fg).toEqual({ ansi: 1 });
  expect(runs[3].fg).toBeUndefined();
  expect(plainAnsi(input)).toBe("before red alert normal after");
});

test("does not display other OSC payloads or incomplete control strings", () => {
  const input = "one\x1b]0;window title\x07two\x1b]52;c;secret\x1b\\three\x1b]1;unfinished";
  expect(plainAnsi(input)).toBe("onetwothree");
});

test("does not join adjacent runs with different link destinations", () => {
  const input = "\x1b]8;;https://example.com/one\x07one\x1b]8;;https://example.com/two\x07two\x1b]8;;\x07end";
  expect(parseAnsi(input).map((run: { text: string; link?: string }) => [run.text, run.link])).toEqual([
    ["one", "https://example.com/one"], ["two", "https://example.com/two"], ["end", undefined],
  ]);
});
