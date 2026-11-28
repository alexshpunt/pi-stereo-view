// LPT-1943: text geometry shared by selection and find in tree panels (pure, no GPUI).
//
// Design. The GUI draws wrapped rows (`wrapRows`), but selection and search must outlive a re-wrap (resize), an
// expansion and streaming. So a position in the text is never a row/column: it is `{ id, part, off }`, a UTF-16
// offset into one body part ("t", "a" or "o") of one item. Rows and columns exist only while drawing and hit-testing:
//   rowSpans(text, cols)    source offsets [start, end) of every wrapped row, in the same order `wrapRows` yields
//                           them (the tests compare both); a soft wrap eats one space, so ends are exclusive.
//   caretAt / cellsBetween  columns <-> offsets inside one row, by terminal cells (tab = 4, wide CJK = 2, marks = 0).
//   wordRange / lineRange   what a double and a triple click select.
//   SpanCache               rowSpans per item and width, computed lazily for items that carry a mark or a click.
// A drawn mark is `{ c0, c1, kind }` (cells, end exclusive; kind "sel" | "hit" | "cur"). `marks[part][row]` is a list
// of them; the panel draws each as an absolute rectangle under the row's text (monospace font, `c * cellWidth`).
// Which rows of an item are text is fixed by PARTS and HEAD_ROWS and must match `renderItem` in tree-panel.js.
import { cellWidth, wrapLine } from "./wrap.js";

/** Body parts an item kind draws, in drawing order. Kinds not listed ("rows") have no selectable text here. */
export const PARTS = { user: ["t"], md: ["t"], think: ["t"], tool: ["a", "o"], bash: ["a", "o"] };
/** Rows drawn above the first text row of an item (padding, "thinking", the tool name); they hold no body text. */
export const HEAD_ROWS = { user: 1, md: 0, think: 1, tool: 1, bash: 1 };

/** The parts of an item that its body holds, in drawing order. Empty for items without selectable text. */
export function presentParts(item, body) {
  const keys = PARTS[item.k];
  if (!keys || !body) return [];
  return keys.filter(key => typeof body[key] === "string");
}

/** Order of a part inside its item. */
export const partRank = key => (key === "o" ? 1 : 0);

/** Width in cells of the char at `i` and its length in UTF-16 units. */
function charCells(text, i) {
  const c = text.charCodeAt(i);
  if (c === 9) return [4, 1];
  if (c < 0x300) return [c === 0 || c < 0x20 || (c >= 0x7f && c < 0xa0) ? 0 : 1, 1];
  const point = text.codePointAt(i);
  return [cellWidth(point), point > 0xffff ? 2 : 1];
}

/** Cells from offset `s` to offset `e` of `text`. */
export function cellsBetween(text, s, e) {
  let width = 0;
  for (let i = s; i < e;) { const [w, len] = charCells(text, i); width += w; i += len; }
  return width;
}

/**
 * Source offsets of every wrapped row of `text` at `cols`: an Int32Array `[s0, e0, s1, e1, ...]`.
 * Row k of `wrapRows(text, cols)` is `text.slice(s_k, e_k)` with tabs shown as four spaces.
 */
export function rowSpans(text, cols) {
  const width = Math.max(1, cols | 0);
  const out = [];
  const rows = [];
  let from = 0;
  for (;;) {
    let at = text.indexOf("\n", from);
    if (at < 0) at = text.length;
    let end = at;
    if (end > from && text.charCodeAt(end - 1) === 13) end--;
    const raw = text.slice(from, end);
    const tabs = raw.includes("\t");
    const line = tabs ? raw.replaceAll("\t", "    ") : raw;
    rows.length = 0;
    wrapLine(line, width, rows);
    // Offset of every normalized index, only when tabs shifted them.
    let map = null;
    if (tabs) {
      map = new Int32Array(line.length + 1);
      let n = 0;
      for (let i = 0; i < raw.length; i++) {
        if (raw.charCodeAt(i) === 9) for (let k = 0; k < 4; k++) map[n++] = from + i;
        else map[n++] = from + i;
      }
      map[n] = from + raw.length;
    }
    let pos = 0;
    for (let k = 0; k < rows.length; k++) {
      const length = rows[k].length;
      const s = map ? map[pos] : from + pos;
      out.push(s, length === 0 ? s : map ? map[pos + length - 1] + 1 : from + pos + length);
      pos += length;
      // A soft wrap swallows the one space it broke at.
      if (k < rows.length - 1 && line.charCodeAt(pos) === 32) pos++;
    }
    if (at >= text.length) break;
    from = at + 1;
  }
  return Int32Array.from(out);
}

/** Index of the last row whose start is <= `off` (0 when none). */
export function rowOfOffset(spans, off) {
  let lo = 0, hi = spans.length / 2 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[2 * mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * The caret under a pointer at fractional column `col` of the row [s, e): the nearer side of the char under it, and
 * that char's offset (`ch`; `e` when the pointer is past the end of the row).
 */
export function caretAt(text, s, e, col) {
  let acc = 0;
  for (let i = s; i < e;) {
    const [w, len] = charCells(text, i);
    if (col < acc + w) return { off: col - acc < w / 2 ? i : i + len, ch: i };
    acc += w; i += len;
  }
  return { off: e, ch: e };
}

const WORD = /[\p{L}\p{N}_\-./\\~]/u;
const classOf = c => (c === "\n" ? 3 : /\s/.test(c) ? 0 : WORD.test(c) ? 1 : 2);

/** [start, end) of the word, space run or punctuation run around char `ch`; empty at the end of a line. */
export function wordRange(text, ch) {
  if (ch < 0 || ch >= text.length || text[ch] === "\n") return [Math.max(0, Math.min(ch, text.length)), Math.max(0, Math.min(ch, text.length))];
  const kind = classOf(text[ch]);
  let s = ch, e = ch + 1;
  while (s > 0 && classOf(text[s - 1]) === kind) s--;
  while (e < text.length && classOf(text[e]) === kind) e++;
  // "see foo.ts." selects foo.ts: sentence punctuation at the end is not part of a word.
  if (kind === 1) while (e - s > 1 && ".,:;".includes(text[e - 1])) e--;
  return [s, e];
}

/** [start, end) of the logical line (between newlines) around offset `ch`, without its newline. */
export function lineRange(text, ch) {
  const at = Math.max(0, Math.min(ch, text.length));
  const s = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
  let e = text.indexOf("\n", at);
  if (e < 0) e = text.length;
  if (e > s && text.charCodeAt(e - 1) === 13) e--;
  return [s, e];
}

/** rowSpans per item, body and width: built when an item first needs them, dropped when it changes. */
export class SpanCache {
  constructor(limit = 256) { this.limit = limit; this.items = new Map(); }

  /** Spans of `body[key]` at `cols`. */
  get(item, body, key, cols) {
    let entry = this.items.get(item.id);
    if (!entry || entry.body !== body || entry.cols !== cols) {
      if (this.items.size >= this.limit) this.items.clear();
      entry = { body, cols, parts: {} };
      this.items.set(item.id, entry);
    }
    return entry.parts[key] ??= rowSpans(body[key], cols);
  }
}

/** Marks of two sources joined row by row (`a` first, so `b` is drawn over it). */
export function mergeMarks(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const out = { ...a };
  for (const key of Object.keys(b)) {
    const left = a[key], right = b[key];
    if (!left) { out[key] = right; continue; }
    const rows = new Array(Math.max(left.length, right.length));
    for (let i = 0; i < rows.length; i++) rows[i] = left[i] && right[i] ? left[i].concat(right[i]) : left[i] ?? right[i];
    out[key] = rows;
  }
  return out;
}
