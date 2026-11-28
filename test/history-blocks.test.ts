import { expect, test } from "vitest";
// @ts-expect-error The mod has no TypeScript declarations.
import { blockAround, buttonRow, columnsFit, footerControls, leadingMarker, MIN_COLUMN_CELLS, padsToEnd } from "../herdr/mods/stereo-view/history-blocks.js";

test("finds the controls of a footer row in both button styles", () => {
  expect(footerControls("                [Go to] [Copy]")).toEqual({ goTo: { column: 16, width: 7 }, copy: { column: 24, width: 6 } });
  expect(footerControls("        [Copy]")).toEqual({ copy: { column: 8, width: 6 } });
  // Icon style: the glyph is followed by a zero-width joiner that takes no cell.
  expect(footerControls("      [ ⇄ ] [ ⧉\u034f ]")).toEqual({ goTo: { column: 6, width: 5 }, copy: { column: 12, width: 5 } });
  expect(footerControls("[ ⧉\u034f ]")).toEqual({ copy: { column: 0, width: 5 } });
});

test("a row that holds anything besides the controls is not a footer", () => {
  expect(footerControls("see [Copy] for details")).toBeNull();
  expect(footerControls("[Copy] [Copy] [Copy]")).toBeNull();
  expect(footerControls("array[0]")).toBeNull();
  expect(footerControls("")).toBeNull();
  expect(footerControls("   ")).toBeNull();
  expect(footerControls(undefined as unknown as string)).toBeNull();
});

test("a block runs from the row after the previous footer to its own footer", () => {
  const footers = new Map<number, any>([[3, { copy: { column: 0, width: 6 } }], [9, { copy: { column: 0, width: 6 } }]]);
  const loaded = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const at = (index: number) => loaded.has(index) ? footers.get(index) ?? null : undefined;
  expect(blockAround(5, at)).toMatchObject({ start: 4, end: 9 });
  expect(blockAround(4, at)).toMatchObject({ start: 4, end: 9 });
  expect(blockAround(9, at), "the footer belongs to its block").toMatchObject({ start: 4, end: 9 });
  expect(blockAround(1, at), "the first block starts at the top").toMatchObject({ start: 0, end: 3 });
  expect(blockAround(10, at), "a block whose footer is not loaded is unknown").toBeNull();
  expect(blockAround(-1, at)).toBeNull();
});

test("a block's start is where the loaded rows begin when no footer is above", () => {
  const footers = new Map<number, any>([[8, { copy: { column: 0, width: 6 } }]]);
  const at = (index: number) => index >= 5 && index <= 8 ? footers.get(index) ?? null : undefined;
  expect(blockAround(6, at)).toMatchObject({ start: 5, end: 8 });
});

test("the buttons sit on the block's first visible row, never outside the block", () => {
  const block = { start: 10, end: 60 };
  expect(buttonRow(block, 0)).toBe(10);
  expect(buttonRow(block, 25)).toBe(25);
  expect(buttonRow(block, 200)).toBe(60);
});

test("a run's background runs on only when it ends in padding and is more than one cell", () => {
  expect(padsToEnd({ text: "  hello  " })).toBe(true);
  expect(padsToEnd({ text: "        " })).toBe(true);
  expect(padsToEnd({ text: "hello" })).toBe(false);
  expect(padsToEnd({ text: " " }), "a one-cell marker").toBe(false);
  expect(padsToEnd({ text: "" })).toBe(false);
  expect(padsToEnd(undefined)).toBe(false);
});

test("a row's leading marker is a one-cell run with a background", () => {
  const bar = { text: " ", bg: { ansi: 5 } };
  expect(leadingMarker([bar, { text: "text" }])).toBe(bar);
  expect(leadingMarker([{ text: " " }, bar]), "a blank without a background").toBeUndefined();
  expect(leadingMarker([{ text: "ab", bg: "#000000" }])).toBeUndefined();
  expect(leadingMarker([])).toBeUndefined();
});

test("two columns fit when each holds the minimum number of cells", () => {
  const cell = 7, chrome = 24, divider = 5;
  const minimum = 2 * (MIN_COLUMN_CELLS * cell + chrome) + divider;
  expect(columnsFit(minimum, cell, chrome, divider)).toBe(true);
  expect(columnsFit(minimum - 1, cell, chrome, divider)).toBe(false);
  expect(columnsFit(355, cell, chrome, divider), "a narrow pane").toBe(false);
  expect(columnsFit(1450, cell, chrome, divider), "a wide pane").toBe(true);
});
