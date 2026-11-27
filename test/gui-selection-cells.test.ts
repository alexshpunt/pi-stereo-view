import { expect, test } from "vitest";
import { guiSelectionCells } from "../src/gui-selection-cells.ts";
// @ts-expect-error The mod is plain JavaScript without TypeScript declarations.
import { createSelection } from "../herdr/mods/stereo-view/selection.js";

test("keeps terminal cell boundaries for styled graphemes and trailing spaces", () => {
  const row = guiSelectionCells("\x1b[31mA界e\u0301\x1b[0m  ");
  expect(row.cells).toEqual([
    { text: "A", start: 0, end: 1 },
    { text: "界", start: 1, end: 3 },
    { text: "e\u0301", start: 3, end: 4 },
    { text: " ", start: 4, end: 5 },
    { text: " ", start: 5, end: 6 },
  ]);
});

test("joins path punctuation and keeps spaces and other punctuation selectable", () => {
  const row = guiSelectionCells("hi /tmp/a-b.txt @ test");
  expect(row.words).toEqual([
    { start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 15 },
    { start: 15, end: 16 }, { start: 16, end: 17 }, { start: 17, end: 18 }, { start: 18, end: 22 },
  ]);
});

test("strips hyperlink escapes while keeping emoji and empty rows", () => {
  const row = guiSelectionCells("\x1b]8;;https://example.com\x07👩‍💻\x1b]8;;\x07!");
  expect(row.cells).toEqual([{ text: "👩‍💻", start: 0, end: 2 }, { text: "!", start: 2, end: 3 }]);
  expect(guiSelectionCells("\x1b[0m")).toEqual({ cells: [], words: [] });
  expect(guiSelectionCells("x\x1b_Ga=T,f=100;YWJj\x1b\\y").cells.map(cell => cell.text).join("")).toBe("xy");
});

test("GUI word selection copies the complete styled path", () => {
  const rows = [guiSelectionCells("open \x1b[31m/tmp/界-b.txt\x1b[0m now")];
  const selection = createSelection((row: number) => rows[row]);
  selection.start({ row: 0, col: 10 }, "word");
  expect(selection.text()).toBe("/tmp/界-b.txt");
});
