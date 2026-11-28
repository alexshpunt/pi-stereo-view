// LPT-1943: scroll position, measuring and prefetch for one pane. `frame()` is what a GUI frame calls: it never
// waits for Pi, never allocates per row beyond the visible window, and spends at most `budgetMs` measuring.
import { TreeLayout } from "./tree-layout.js";

const BATCH_CHARS = 256 * 1024;
const BATCH_ITEMS = 48;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class TreeView {
  /** @param client TreeClient; @param viewport rows visible; @param cols text width in cells */
  constructor(client, { viewport = 40, cols = 100, budgetMs = 4, prefetchScreens = 3 } = {}) {
    this.client = client;
    this.model = client.model;
    this.layout = new TreeLayout(this.model);
    this.viewport = viewport;
    this.budgetMs = budgetMs;
    this.prefetchScreens = prefetchScreens;
    this.layout.cols = cols;
    /** The scroll position is an item and a row inside it: measuring other items never moves what is on screen. */
    this.anchor = { index: 0, offset: 0 };
    this.following = true;
    this.inFlight = false;
    this.requestedRows = new Set();
    this.dirtyAnchor = false;
  }

  get top() { return this.layout.prefix(this.anchor.index) + this.anchor.offset; }
  get maxTop() { return Math.max(0, this.layout.totalRows - this.viewport); }

  /** A snapshot or splice arrived (the client calls this from its `change` hook). */
  changed(change) {
    this.complete = false;
    this.exact = false;
    if (change.kind === "snapshot") {
      if (!change.last) return;
      this.layout.rebuild();
      if (this.following) this.toBottom(); else this.clampAnchor();
    } else if (change.kind === "delta") {
      const oldIndex = this.anchor.index;
      const anchorId = this.anchorId;
      this.layout.splice(change.at, change.removed, change.inserted);
      this.requestedRows.clear();
      const moved = anchorId ? this.model.indexOf(anchorId) : -1;
      if (this.following) this.toBottom();
      else if (moved >= 0) this.anchor.index = moved;
      else this.anchor.index = Math.min(oldIndex, Math.max(0, this.layout.count - 1));
    }
    this.pin();
  }

  pin() { this.anchorId = this.model.items[this.anchor.index]?.id; }
  clampAnchor() {
    this.anchor.index = Math.min(this.anchor.index, Math.max(0, this.layout.count - 1));
    this.pin();
  }

  setViewport(rows) { this.viewport = Math.max(1, rows | 0); if (this.following) this.toBottom(); }

  /** A new text width: estimates are recomputed, the item at the top stays at the top. */
  setCols(cols) {
    if (cols === this.layout.cols) return;
    const { index, offset } = this.anchor;
    const height = this.layout.heights[index] || 1;
    const fraction = height ? offset / height : 0;
    this.layout.rebuild(cols);
    this.exact = false;
    this.requestedRows.clear();
    this.anchor = { index, offset: Math.min(Math.floor(fraction * (this.layout.heights[index] || 1)), Math.max(0, (this.layout.heights[index] || 1) - 1)) };
  }

  scrollTo(row) {
    const top = Math.max(0, Math.min(this.maxTop, Math.round(row)));
    this.anchor = this.layout.locate(top);
    this.following = top >= this.maxTop;
    this.pin();
  }
  scrollBy(rows) { this.scrollTo(this.top + rows); }
  toTop() { this.scrollTo(0); }
  toBottom() { this.following = true; this.anchor = this.layout.locate(this.maxTop); this.pin(); }
  /** Jump to an item (Go to, search hit). */
  toItem(index) { const i = Math.max(0, Math.min(index, this.layout.count - 1)); this.anchor = { index: i, offset: 0 }; this.following = false; this.pin(); }

  /**
   * One GUI frame: measure what is on screen (and just around it), start loading what is near, and describe the
   * window. `pending` lists visible items without a body: they must be zero on any frame after the first.
   */
  frame() {
    const started = now();
    const layout = this.layout;
    let top = this.top;
    const margin = this.viewport;
    const first = layout.locate(Math.max(0, top - margin));
    const last = layout.locate(top + this.viewport + margin);
    // Visible items first, then the margin; measuring above the anchor must not move it.
    const order = [];
    const visibleFirst = layout.locate(top).index;
    const visibleLast = layout.locate(top + this.viewport).index;
    for (let i = visibleFirst; i <= visibleLast && i < layout.count; i++) order.push(i);
    for (let i = visibleLast + 1; i <= last.index && i < layout.count; i++) order.push(i);
    for (let i = visibleFirst - 1; i >= first.index && i >= 0; i--) order.push(i);
    let measuredCount = 0;
    for (const i of order) {
      if (now() - started > this.budgetMs && i > visibleLast) break;
      const item = this.model.items[i];
      if (item.k === "rows") { this.wantRows(i); continue; }
      if (layout.measure(i) !== undefined && !layout.measured[i]) measuredCount++;
    }
    // Heights above the anchor changed: restore the position from the anchor item.
    top = this.top;
    const windowItems = layout.window(top, this.viewport);
    const pending = [];
    for (const entry of windowItems) {
      const item = this.model.items[entry.index];
      if (item.k === "rows" ? !layout.fallbackRows.has(item.id) : !this.model.bodies.has(item.id)) pending.push(entry.index);
    }
    this.prefetch(visibleFirst, visibleLast);
    // Spare budget makes the rest of the pane exact, so far jumps and the scrollbar stop drifting.
    const left = this.budgetMs - (now() - started);
    if (left > 0.5 && !this.exact) this.exact = layout.measureSlice(left);
    return { top, total: layout.totalRows, window: windowItems, pending, spentMs: now() - started, measuredCount };
  }

  wantRows(i) {
    const item = this.model.items[i];
    const key = `${item.id}@${this.layout.cols}`;
    if (this.requestedRows.has(key) || this.layout.fallbackRows.has(item.id)) return;
    this.requestedRows.add(key);
    const cols = this.layout.cols;
    this.client.rows(item.id, cols).then(lines => { if (lines) this.layout.setFallback(item.id, lines, cols); });
  }

  /** Bodies near the viewport first, then the rest of the pane as background work. One request at a time. */
  prefetch(visibleFirst, visibleLast) {
    if (this.inFlight || this.complete || this.client.closed) return;
    const items = this.model.items;
    const ids = [];
    let chars = 0;
    const consider = i => {
      const item = items[i];
      if (!item || item.k === "rows" || this.model.bodies.has(item.id)) return true;
      if (ids.length >= BATCH_ITEMS || (ids.length && chars + item.c > BATCH_CHARS)) return false;
      ids.push(item.id); chars += item.c;
      return true;
    };
    const span = Math.max(visibleLast - visibleFirst + 1, 1) * (this.prefetchScreens + 1);
    for (let d = 0; d < span + items.length && ids.length < BATCH_ITEMS; d++) {
      const below = visibleFirst + d, above = visibleFirst - 1 - d;
      if (below < items.length && !consider(below)) break;
      if (above >= 0 && !consider(above)) break;
      if (below >= items.length && above < 0) break;
    }
    if (!ids.length) { this.complete = true; return; }
    this.inFlight = true;
    this.client.get(ids).then(loaded => { this.inFlight = false; this.loadedBodies(loaded); }, () => { this.inFlight = false; });
  }

  loadedBodies() { /* heights are measured lazily by the next frame */ }

  /** Whether the whole pane's bodies are loaded (the benchmark waits for this). */
  get fullyLoaded() { return this.model.items.every(item => item.k === "rows" || this.model.bodies.has(item.id)); }
}
