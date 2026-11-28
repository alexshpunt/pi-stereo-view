// LPT-1943: text selection across the items of a tree panel (pure; the panel only feeds it pointer positions).
//
// Design. A selection is two points `{ id, part, off, ch }`: an item id, a body part ("t" | "a" | "o"; null for an
// item without text, such as Pi-rows) and a UTF-16 offset into that part (`ch` is the char under the pointer, used by
// word and line mode). Offsets into source text survive scrolling, a re-wrap on resize, expansion (the folded body is
// a prefix of the full one) and streaming (ids are stable); they are clamped to what the body holds *now*, and the
// selection is dropped when an endpoint's item is removed. Selection data never goes over the wire: the mod holds
// every (folded) body, so copying is synchronous and gives exactly what is drawn.
//   pointAt(row, col)   pane row (from the scroll offset) and fractional cell column -> a point (caret rounded to the
//                       nearer side of a char); rows above the text snap to its start, below it to its end.
//   start / extend      press (character, word or line mode: double and triple click) and drag.
//   range()/text()      normalized endpoints; the text between them (parts of an item joined by "\n", items by a blank
//                       line, soft wraps are not newlines; folded items give only the lines shown).
//   marks(...)          per part, per wrapped row: the cell range to highlight, for the item being drawn.
// Per-frame cost: range() is two index lookups; marks() touches only items between the endpoints that are drawn.
import { HEAD_ROWS, SpanCache, caretAt, cellsBetween, lineRange, partRank, presentParts, wordRange } from "./tree-text.js";

const EMPTY = [0, 0];

export class TreeSelection {
  /** @param view TreeView (model + layout); @param spans shared SpanCache */
  constructor(view, spans = new SpanCache()) {
    this.view = view;
    this.spans = spans;
    this.anchor = null;
    this.focus = null;
    this.mode = "char";
    this.initial = null;
  }

  /** A point for pane row `row` (0 = first row of the first item) and fractional cell column `col`. */
  pointAt(row, col) {
    const { layout } = this.view;
    if (!layout.count) return null;
    if (row >= layout.totalRows) return this.edge(layout.count - 1, true);
    const { index, offset } = layout.locate(Math.max(0, row));
    return this.pointIn(index, offset, col);
  }

  /** Start (or end) of the text of item `index`. */
  edge(index, atEnd) {
    const { model } = this.view;
    const item = model.items[index];
    const body = model.bodies.get(item.id);
    const keys = presentParts(item, body);
    if (!keys.length) return { id: item.id, part: null, off: 0, ch: 0 };
    const key = atEnd ? keys[keys.length - 1] : keys[0];
    const off = atEnd ? body[key].length : 0;
    return { id: item.id, part: key, off, ch: off };
  }

  /** The point in row `offset` of item `index`. */
  pointIn(index, offset, col) {
    const { model, layout } = this.view;
    const item = model.items[index];
    const body = model.bodies.get(item.id);
    const keys = presentParts(item, body);
    if (!keys.length) return { id: item.id, part: null, off: 0, ch: 0 };
    let r = offset - (HEAD_ROWS[item.k] ?? 0);
    if (r < 0) return this.edge(index, false);
    const rows = layout.rowsOf(item, body);
    for (const key of keys) {
      const count = rows.parts[key].length;
      if (r < count) {
        const spans = this.spans.get(item, body, key, layout.cols);
        const caret = caretAt(body[key], spans[2 * r], spans[2 * r + 1], col);
        return { id: item.id, part: key, off: caret.off, ch: caret.ch };
      }
      r -= count;
    }
    return this.edge(index, true);
  }

  /** Order of two points in the pane. */
  compare(a, b) {
    const { model } = this.view;
    const ia = model.indexOf(a.id), ib = model.indexOf(b.id);
    return ia - ib || partRank(a.part) - partRank(b.part) || a.off - b.off;
  }

  /** A point clamped to the text its item holds now, or null when the item is gone. */
  clamp(point) {
    const { model } = this.view;
    if (model.indexOf(point.id) < 0) return null;
    const text = model.bodies.get(point.id)?.[point.part];
    const off = typeof text === "string" ? Math.min(point.off, text.length) : 0;
    return { ...point, off };
  }

  /** The text of a point's part, or undefined. */
  textOf(point) {
    const text = this.view.model.bodies.get(point.id)?.[point.part];
    return typeof text === "string" ? text : undefined;
  }

  /** The word or line around `point` (the unit of the click that started the gesture), or null. */
  unit(point) {
    const text = point.part ? this.textOf(point) : undefined;
    if (text === undefined) return null;
    const [s, e] = this.mode === "word" ? wordRange(text, point.ch) : lineRange(text, point.ch);
    return { start: { ...point, off: s, ch: s }, end: { ...point, off: e, ch: e } };
  }

  /** Press at `point`. `mode` is "char", "word" (double click) or "line" (triple click). */
  start(point, mode = "char") {
    this.mode = mode;
    this.initial = null;
    this.anchor = point;
    this.focus = point;
    if (mode === "char") return;
    const unit = this.unit(point);
    if (unit) { this.initial = unit; this.anchor = unit.start; this.focus = unit.end; } else this.mode = "char";
  }

  /** Drag (or shift-click) to `point`: character mode follows it, word and line mode grow by whole units. */
  extend(point) {
    if (!this.anchor) return;
    const unit = this.initial ? this.unit(point) : null;
    if (!unit) { this.focus = point; return; }
    if (this.compare(unit.start, this.initial.start) < 0) { this.anchor = this.initial.end; this.focus = unit.start; }
    else { this.anchor = this.initial.start; this.focus = unit.end; }
  }

  clear() { this.anchor = null; this.focus = null; this.initial = null; }

  /** Whether `point` is where the focus already is (a drag over the same char needs no redraw). */
  atFocus(point) { return !!this.focus && this.focus.id === point.id && this.focus.part === point.part && this.focus.off === point.off; }

  /** `{ start, end, si, ei }` (points in order, item indexes), or undefined when nothing is selected. */
  range() {
    if (!this.anchor) return undefined;
    const a = this.clamp(this.anchor), b = this.clamp(this.focus);
    if (!a || !b) { this.clear(); return undefined; }
    const order = this.compare(a, b);
    if (order === 0) return undefined;
    const [start, end] = order < 0 ? [a, b] : [b, a];
    const { model } = this.view;
    return { start, end, si: model.indexOf(start.id), ei: model.indexOf(end.id) };
  }

  /** The selected part of `key` (length `length`) in item `index`, as [from, to). */
  interval(range, index, key, length) {
    const rank = partRank(key);
    let a = 0, b = length;
    if (index === range.si) {
      const start = partRank(range.start.part);
      if (rank < start) return EMPTY;
      if (rank === start) a = Math.min(range.start.off, length);
    }
    if (index === range.ei) {
      const end = partRank(range.end.part);
      if (rank > end) return EMPTY;
      if (rank === end) b = Math.min(range.end.off, length);
    }
    return [a, b];
  }

  /** The selected text, or undefined. */
  text() {
    const range = this.range();
    if (!range) return undefined;
    const { model } = this.view;
    const out = [];
    for (let i = range.si; i <= range.ei; i++) {
      const item = model.items[i];
      const body = model.bodies.get(item.id);
      const pieces = [];
      for (const key of presentParts(item, body)) {
        const [a, b] = this.interval(range, i, key, body[key].length);
        if (a < b) pieces.push(body[key].slice(a, b));
      }
      if (pieces.length) out.push(pieces.join("\n"));
    }
    return out.join("\n\n").replaceAll("\r\n", "\n") || undefined;
  }

  /**
   * Highlight of item `index` as `{ [part]: (Mark[] | undefined)[] }` per wrapped row, or null when the item is not
   * in the selection. `rows` is `layout.rowsOf(item, body)`.
   */
  marks(index, item, body, rows) {
    const range = this.range();
    if (!range || index < range.si || index > range.ei) return null;
    let out = null;
    for (const key of presentParts(item, body)) {
      const text = body[key];
      const [a, b] = this.interval(range, index, key, text.length);
      if (a >= b) continue;
      const lines = rows.parts[key];
      const spans = this.spans.get(item, body, key, this.view.layout.cols);
      let marked = null;
      for (let k = 0; k < lines.length; k++) {
        const s = spans[2 * k], e = spans[2 * k + 1];
        let c0, c1;
        if (s === e) {
          // An empty line inside the selection shows one cell, as the terminal does for the newline.
          if (a <= s && b > e) { c0 = 0; c1 = 1; } else continue;
        } else {
          const lo = Math.max(a, s), hi = Math.min(b, e);
          if (lo >= hi) continue;
          c0 = lo === s ? 0 : cellsBetween(text, s, lo);
          c1 = cellsBetween(text, s, hi);
        }
        (marked ??= new Array(lines.length))[k] = [{ c0, c1, kind: "sel" }];
      }
      if (marked) (out ??= {})[key] = marked;
    }
    return out;
  }
}
