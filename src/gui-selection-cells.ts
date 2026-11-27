import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export interface GuiSelectionCell { text: string; start: number; end: number }
export interface GuiSelectionSpan { start: number; end: number }
export interface GuiSelectionRow { cells: GuiSelectionCell[]; words: GuiSelectionSpan[] }

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const joiners = new Set(["/", "-", "+", "\\", "~", "_", "."]);

/** Map the visible row to Pi's grapheme-cell and word-selection boundaries. */
export function guiSelectionCells(line: string): GuiSelectionRow {
  const text = stripTerminalSequences(line).replace(/\t/g, "    ");
  const cells: GuiSelectionCell[] = [];
  let column = 0;
  for (const { segment } of graphemes.segment(text)) {
    const end = column + visibleWidth(segment);
    cells.push({ text: segment, start: column, end });
    column = end;
  }

  const spans: Array<GuiSelectionSpan & { selectable: boolean; joiner: boolean }> = [];
  column = 0;
  for (const part of words.segment(text)) {
    const end = column + visibleWidth(part.segment);
    const joiner = joiners.has(part.segment);
    const selectable = part.isWordLike === true || joiner;
    const previous = spans[spans.length - 1];
    if (previous && previous.selectable && selectable && (previous.joiner || joiner)) {
      // Remember whether the final segment was a joiner: only adjacent segments join.
      previous.end = end;
      previous.joiner = joiner;
    } else spans.push({ start: column, end, selectable, joiner });
    column = end;
  }
  return { cells, words: spans.map(({ start, end }) => ({ start, end })) };
}
