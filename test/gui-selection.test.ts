import { expect, test } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
// The mod is JavaScript, loaded directly by Herdr.
// @ts-expect-error The model does not have TypeScript declarations.
import { createSelection } from "../herdr/mods/stereo-view/selection.js";

// Pi can send these grapheme and word spans alongside rendered rows. The model
// consumes spans rather than approximating terminal widths in Herdr's JS runtime.
function row(ansi: string) {
  const text = stripTerminalSequences(ansi);
  let column = 0;
  const cells = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(({ segment }) => {
    const start = column;
    column += visibleWidth(segment);
    return { text: segment, start, end: column };
  });
  const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)].map(({ segment, index }) => ({
    start: visibleWidth(text.slice(0, index)), end: visibleWidth(text.slice(0, index + segment.length)),
  }));
  return { cells, words };
}

test("copies the same text for a reversed multiline character selection", () => {
  const rows = [row("\x1b[31mAlpha 界e\u0301\x1b[0m"), row("two words")];
  const select = createSelection((i: number) => rows[i]);
  select.start({ row: 1, col: 2 }, "character");
  select.extend({ row: 0, col: 6 });
  expect(select.text()).toBe("界e\u0301\ntwo");
  expect(select.bounds()).toEqual({ start: { row: 0, col: 6 }, end: { row: 1, col: 3 } });
});

test("selects whole graphemes when either endpoint touches a wide cell", () => {
  const rows = [row("x界e\u0301y")];
  const select = createSelection((i: number) => rows[i]);
  select.start({ row: 0, col: 2 }, "character");
  select.extend({ row: 0, col: 3 });
  expect(select.text()).toBe("界e\u0301");
  expect(select.columns(0)).toEqual({ start: 1, end: 4 });
});

test("copies a joined emoji as one complete grapheme", () => {
  const rows = [row("a👨‍👩‍👧‍👦z")];
  const select = createSelection((i: number) => rows[i]);
  select.start({ row: 0, col: 0 }, "character");
  select.extend({ row: 0, col: 2 });
  expect(select.text()).toBe("a👨‍👩‍👧‍👦");
});

test("extends word and line selections to whole supplied boundaries", () => {
  const rows = [row("hello world"), row("last line")];
  const select = createSelection((i: number) => rows[i]);
  select.start({ row: 0, col: 2 }, "word");
  expect(select.text()).toBe("hello");
  select.extend({ row: 1, col: 1 });
  expect(select.text()).toBe("hello world\nlast");
  select.start({ row: 1, col: 2 }, "line");
  select.extend({ row: 0, col: 4 });
  expect(select.text()).toBe("hello world\nlast line");
});

test("falls back to character dragging if the initial point has no word", () => {
  const rows = [row("abc")];
  const select = createSelection((i: number) => rows[i]);
  select.start({ row: 0, col: 4 }, "word");
  select.extend({ row: 0, col: 1 });
  expect(select.text()).toBe("bc");
});

test("does not select a click and reports missing rows instead of copying partial text", () => {
  const rows = [row("first"), undefined, row("last")];
  const select = createSelection((i: number) => rows[i]);
  select.start({ row: 0, col: 1 }, "character");
  expect(select.text()).toBeUndefined();
  select.extend({ row: 2, col: 1 });
  expect(select.text()).toBeUndefined();
  select.clear();
  expect(select.bounds()).toBeUndefined();
});
