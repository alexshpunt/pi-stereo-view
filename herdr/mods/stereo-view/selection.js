// The Pi bridge supplies these spans with the same grapheme/word segmentation
// and terminal-cell widths as its renderer. Herdr's JS runtime does not expose
// Pi's Unicode width implementation.
//
// A row is { cells: [{text, start, end}], words: [{start, end}] }, where the
// cell text is plain (without terminal sequences) and ends are exclusive.
// Words should already include Pi's joined path punctuation. Rows are looked up
// by absolute document row; an unavailable row is undefined.

/** @typedef {{row: number, col: number}} Point */
/** @typedef {{text: string, start: number, end: number}} Cell */
/** @typedef {{cells: Cell[], words: {start: number, end: number}[]}} Row */

/** @param {Point} a @param {Point} b */
function compare(a, b) { return a.row - b.row || a.col - b.col; }

/** @param {Row | undefined} row */
function width(row) { return row?.cells.length ? row.cells[row.cells.length - 1].end : 0; }

/** @param {Row | undefined} row @param {number} col */
function cellAt(row, col) { return row?.cells.find(cell => cell.start <= col && col < cell.end); }

/** @param {(index: number) => Row | undefined} getRow */
export function createSelection(getRow) {
  /** @type {Point | undefined} */ let anchor;
  /** @type {Point | undefined} */ let focus;
  /** @type {"character" | "word" | "line"} */ let mode = "character";
  /** @type {{start: Point, end: Point} | undefined} */ let initial;

  /** @param {Point} point */
  function unit(point) {
    const row = getRow(point.row);
    if (!row) return undefined;
    if (mode === "line") return { start: { row: point.row, col: 0 }, end: { row: point.row, col: width(row) } };
    const span = row.words.find(word => point.col >= word.start && point.col < word.end);
    return span ? { start: { row: point.row, col: span.start }, end: { row: point.row, col: span.end } } : undefined;
  }

  function bounds() {
    if (!anchor || !focus || compare(anchor, focus) === 0) return undefined;
    const [start, end] = compare(anchor, focus) < 0 ? [anchor, focus] : [focus, anchor];
    if (mode !== "character") return { start: { ...start }, end: { ...end } };
    const first = getRow(start.row);
    const last = getRow(end.row);
    if (!first || !last) return undefined;
    return {
      start: { row: start.row, col: cellAt(first, start.col)?.start ?? Math.min(start.col, width(first)) },
      end: { row: end.row, col: cellAt(last, end.col)?.end ?? Math.min(end.col + 1, width(last)) },
    };
  }

  /** @param {number} index */
  function columns(index) {
    const selection = bounds();
    const row = getRow(index);
    if (!selection || !row || index < selection.start.row || index > selection.end.row) return undefined;
    return { start: index === selection.start.row ? selection.start.col : 0,
      end: index === selection.end.row ? selection.end.col : width(row) };
  }

  return {
    /** @param {Point} point @param {"character" | "word" | "line"} granularity */
    start(point, granularity) {
      anchor = { ...point }; focus = { ...point }; mode = granularity; initial = undefined;
      if (mode !== "character") {
        const range = unit(point);
        if (range) { initial = range; anchor = range.start; focus = range.end; }
        else mode = "character";
      }
    },
    /** @param {Point} point */
    extend(point) {
      if (!anchor) return;
      if (mode === "character" || !initial) { focus = { ...point }; return; }
      const range = unit(point);
      if (!range) return;
      if (compare(range.start, initial.start) < 0) { anchor = initial.end; focus = range.start; }
      else { anchor = initial.start; focus = range.end; }
    },
    clear() { anchor = undefined; focus = undefined; initial = undefined; },
    bounds,
    columns,
    text() {
      const range = bounds();
      if (!range) return undefined;
      const result = [];
      for (let index = range.start.row; index <= range.end.row; index++) {
        const row = getRow(index);
        if (!row) return undefined;
        const start = index === range.start.row ? range.start.col : 0;
        const end = index === range.end.row ? range.end.col : width(row);
        result.push(row.cells.filter(cell => cell.end > start && cell.start < end).map(cell => cell.text).join("").trimEnd());
      }
      const text = result.join("\n");
      return text || undefined;
    },
  };
}
