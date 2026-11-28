// LPT-1943: find in a tree panel, local to the mod (Pi's old search stays for the non-tree panes).
//
// Design. `TreeSearch` scans the bodies the mod holds in 4 ms slices; this class adds what the find bar needs:
//   - the hit list is indexed by item as the slices finish, so drawing an item looks up its hits in O(1);
//   - a hit's `at` is an offset into `bodyText(body)`; `partOf` maps it back to (part, offset in the part), and
//     `locate` to (item, part, row, col) with the same spans the selection uses (rowSpans), so a hit highlights the
//     cells of the wrapped rows even when it crosses a soft wrap;
//   - the first full pass picks the first hit at or after the item on screen; Enter / Shift+Enter walk the hits
//     with wrap-around and queue a `jump` for the panel (view.toItem + handle.scroll_to_item, then the row);
//   - bodies change while streaming or after an expansion: `changed()` marks the results stale and, once the pane
//     was quiet for STALE_MS, a second search runs beside the shown one and replaces it when done, keeping the
//     current hit if it still exists, so hits never flicker and the view never jumps by itself.
// Only held (folded) text is searched; an item's hidden lines are not.
import { TreeSearch } from "./tree-search.js";
import { HEAD_ROWS, SpanCache, cellsBetween, presentParts, rowOfOffset } from "./tree-text.js";

const STALE_MS = 250;

export class TreeFind {
  constructor(view, spans = new SpanCache()) {
    this.view = view;
    this.model = view.model;
    this.spans = spans;
    this.open = false;
    this.query = "";
    this.reset(new TreeSearch(this.model));
    this.fresh = null;
    this.stale = false;
    this.changedAt = 0;
    /** The hit to bring on screen at the next frame: `{ index, id, key, row, rowInItem, col }`. */
    this.jump = null;
  }

  reset(search) {
    this.search = search;
    this.byItem = new Map();
    this.indexed = 0;
    this.current = -1;
  }

  /** The find bar opened. */
  begin() { this.open = true; }
  /** The find bar closed: marks disappear, results are dropped. */
  close() { this.open = false; this.query = ""; this.fresh = null; this.stale = false; this.jump = null; this.reset(new TreeSearch(this.model)); }

  /** A new query (the bar debounces typing): search from the first item. */
  setQuery(text) {
    this.query = text;
    this.fresh = null;
    this.stale = false;
    this.jump = null;
    const search = new TreeSearch(this.model);
    search.start(text);
    this.reset(search);
  }

  /** Bodies changed (streaming, expansion, a splice): results are rebuilt after a quiet moment. */
  changed(now = Date.now()) { if (this.open && this.query) { this.stale = true; this.changedAt = now; } }

  /** Whether a frame should keep stepping: a pass is running or a rebuild is waiting. */
  get busy() { return this.open && !!this.query && (!this.search.done || !!this.fresh || this.stale); }

  /** Scan for at most `budgetMs`; returns true when the shown results changed. */
  step(budgetMs = 4, now = Date.now()) {
    if (!this.open || !this.query) return false;
    if (this.stale && !this.fresh && now - this.changedAt >= STALE_MS) {
      this.fresh = new TreeSearch(this.model);
      this.fresh.start(this.query);
      this.stale = false;
    }
    const target = this.fresh ?? this.search;
    if (target.done) return false;
    target.step(budgetMs);
    if (target === this.fresh) {
      if (!target.done) return false;
      this.swap(target);
      return true;
    }
    this.index();
    if (target.done && this.current < 0 && target.hits.length) this.pickFirst();
    return true;
  }

  /** Add the new hits to the per-item index. */
  index() {
    const hits = this.search.hits;
    for (; this.indexed < hits.length; this.indexed++) {
      const hit = hits[this.indexed];
      const list = this.byItem.get(hit.id);
      if (list) list.push(hit); else this.byItem.set(hit.id, [hit]);
    }
  }

  /** The finished rebuild replaces the shown results; the current hit stays where it was when it can. */
  swap(search) {
    const old = this.search.hits[this.current];
    this.fresh = null;
    this.reset(search);
    this.index();
    if (!old || !search.hits.length) return;
    const oldIndex = this.model.indexOf(old.id);
    let best = -1, distance = Infinity;
    search.hits.forEach((hit, i) => {
      const gap = hit.id === old.id ? Math.abs(hit.at - old.at) : 1e9 + Math.abs(this.model.indexOf(hit.id) - oldIndex);
      if (gap < distance) { distance = gap; best = i; }
    });
    this.current = best;
  }

  /** The first pass is done: select the first hit at or after the item on screen. */
  pickFirst() {
    const from = this.view.anchor.index;
    const hits = this.search.hits;
    let at = hits.findIndex(hit => this.model.indexOf(hit.id) >= from);
    if (at < 0) at = 0;
    this.current = at;
    this.jump = this.target(hits[at]);
  }

  /** Enter (1) or Shift+Enter (-1): the next or previous hit, wrapping around. Returns whether there is one. */
  move(direction) {
    const count = this.search.hits.length;
    if (!count) return false;
    this.current = this.current < 0 ? (direction > 0 ? 0 : count - 1) : (this.current + direction + count) % count;
    this.jump = this.target(this.search.hits[this.current]);
    return true;
  }

  /** Take the pending jump (the panel scrolls to it once). */
  takeJump() { const jump = this.jump; this.jump = null; return jump; }

  /** `{ open, query, count, current, pending, error }`: what the find bar shows. */
  state() {
    const count = this.search.hits.length;
    return {
      open: this.open, query: this.query, count, current: this.current >= 0 ? this.current + 1 : 0,
      pending: !!this.query && !this.search.done,
      error: this.query && this.search.done && !count ? "No results" : undefined,
    };
  }

  /** Part and offset in the part of a hit; `at` counts in `bodyText(body)`. */
  partOf(body, at) {
    if (typeof body.t === "string") return { key: "t", off: at };
    const a = typeof body.a === "string" ? body.a : "";
    if (a && at < a.length) return { key: "a", off: at };
    if (typeof body.o === "string") return { key: "o", off: a ? at - a.length - 1 : at };
    return a ? { key: "a", off: Math.min(at, a.length) } : null;
  }

  /** Where a hit is drawn: item index, part, row of the part, row inside the item and column. Null when it is gone. */
  target(hit) {
    const { layout } = this.view;
    const index = this.model.indexOf(hit.id);
    if (index < 0) return null;
    const item = this.model.items[index];
    const body = this.model.bodies.get(item.id);
    const place = body && this.partOf(body, hit.at);
    if (!place || place.off < 0) return null;
    const rows = layout.rowsOf(item, body);
    const spans = this.spans.get(item, body, place.key, layout.cols);
    const row = rowOfOffset(spans, place.off);
    let before = HEAD_ROWS[item.k] ?? 0;
    for (const key of presentParts(item, body)) { if (key === place.key) break; before += rows.parts[key].length; }
    return { index, id: item.id, key: place.key, row, rowInItem: before + row, col: cellsBetween(body[place.key], spans[2 * row], Math.min(place.off, spans[2 * row + 1])) };
  }

  /** Highlight of item `index` as `{ [part]: (Mark[] | undefined)[] }`, or null when it has no hit. */
  marks(index, item, body, rows) {
    if (!this.open || !this.query) return null;
    const hits = this.byItem.get(item.id);
    if (!hits) return null;
    const length = this.search.query.length;
    const current = this.search.hits[this.current];
    let out = null;
    for (const hit of hits) {
      const place = this.partOf(body, hit.at);
      if (!place || place.off < 0) continue;
      const text = body[place.key];
      const lines = rows.parts[place.key];
      const spans = this.spans.get(item, body, place.key, this.view.layout.cols);
      const end = place.off + length;
      const kind = hit === current ? "cur" : "hit";
      for (let k = rowOfOffset(spans, place.off); k < lines.length && spans[2 * k] < end; k++) {
        const s = spans[2 * k], e = spans[2 * k + 1];
        const lo = Math.max(place.off, s), hi = Math.min(end, e);
        if (lo >= hi) continue;
        const marked = ((out ??= {})[place.key] ??= new Array(lines.length));
        (marked[k] ??= []).push({ c0: cellsBetween(text, s, lo), c1: cellsBetween(text, s, hi), kind });
      }
    }
    return out;
  }
}
