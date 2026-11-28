// LPT-1943: scroll position, measuring and expansion for one pane. `frame()` is what a GUI frame calls: it never
// waits for Pi, never allocates per row beyond the visible window, and spends at most `budgetMs` measuring.
import { TreeLayout } from "./tree-layout.js";

/** Background measuring while the pane moves (scroll, drag): frames stay cheap. */
const MOVING_SLICE_MS = 1;
const IDLE_SLICE_MS = 10;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class TreeView {
  /** @param client TreeClient; @param viewport rows visible; @param cols text width in cells */
  constructor(client, { viewport = 40, cols = 100, budgetMs = 4, maxExpandedChars = 12_000_000 } = {}) {
    /** Expanded (full) bodies are a bounded cache; folded bodies of the whole pane stay in memory. */
    this.maxExpandedChars = maxExpandedChars;
    this.client = client;
    this.model = client.model;
    this.layout = new TreeLayout(this.model);
    this.viewport = viewport;
    this.budgetMs = budgetMs;
    this.layout.cols = cols;
    /** The scroll position is an item and a row inside it: measuring other items never moves what is on screen. */
    this.anchor = { index: 0, offset: 0 };
    this.following = true;
    /** Expansions requested and not yet answered. */
    this.busy = 0;
    this.requestedRows = new Set();
    this.dirtyAnchor = false;
    this.lastTop = -1;
  }

  get top() { return this.layout.prefix(this.anchor.index) + this.anchor.offset; }
  get maxTop() { return Math.max(0, this.layout.totalRows - this.viewport); }

  /** A snapshot or splice arrived (the client calls this from its `change` hook). */
  changed(change) {
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
    // `pending`: visible items with nothing to draw yet. Every body is in memory, so only Pi-rows fallbacks can be pending.
    const pending = [];
    for (const entry of windowItems) {
      const item = this.model.items[entry.index];
      if (item.k === "rows" ? !layout.fallbackRows.has(item.id) : !this.model.bodies.has(item.id)) pending.push(entry.index);
    }
    // Spare budget makes the rest of the pane exact, so far jumps and the scrollbar stop drifting.
    // While the pane moves the frame stays cheap (1 ms of background work); a still pane measures on in bigger slices.
    const moving = top !== this.lastTop;
    this.lastTop = top;
    const left = (moving ? MOVING_SLICE_MS : Math.max(this.budgetMs, IDLE_SLICE_MS)) - (now() - started);
    if (left > 0.5 && layout.unmeasured > 0) layout.measureSlice(left);
    return { top, total: layout.totalRows, window: windowItems, pending, blank: pending, spentMs: now() - started, measuredCount };
  }

  wantRows(i) {
    const item = this.model.items[i];
    const key = `${item.id}@${this.layout.cols}`;
    if (this.requestedRows.has(key) || this.layout.fallbackRows.has(item.id)) return;
    this.requestedRows.add(key);
    const cols = this.layout.cols;
    this.client.rows(item.id, cols).then(lines => { if (lines) this.layout.setFallback(item.id, lines, cols); });
  }

  /** Expand a folded item: its full body comes from Pi, then the item is measured again. Resolves when it is drawn. */
  expand(id) {
    const item = this.model.items[this.model.indexOf(id)];
    if (!item || !item.x || this.model.full.has(id) || this.client.closed) return Promise.resolve(false);
    this.busy++;
    return this.client.get([id]).then(loaded => {
      this.busy--;
      if (!loaded?.includes(id)) return false;
      this.layout.remeasure(id);
      this.model.evictExpanded(this.anchor.index, this.maxExpandedChars).forEach(folded => this.layout.remeasure(folded));
      return true;
    }, () => { this.busy--; return false; });
  }

  /** Fold an expanded item again. */
  fold(id) {
    if (!this.model.fold(id)) return false;
    this.layout.remeasure(id);
    return true;
  }

  /** The full text of an item for copy: expands nothing, resolves with the body. */
  fullBody(id) {
    const i = this.model.indexOf(id);
    if (i < 0) return Promise.resolve(undefined);
    const item = this.model.items[i];
    if (!this.model.isFolded(item)) return Promise.resolve(this.model.bodies.get(id));
    return this.client.get([id]).then(() => this.model.bodies.get(id), () => undefined).then(body => {
      // The copy fetched a full body into the model: put it back the way it was unless the user expanded it.
      this.model.fold(id);
      return body;
    });
  }

  /** Jump to an item by id; false when it is not in the tree. */
  toItemId(id) {
    const i = this.model.indexOf(id);
    if (i < 0) return false;
    this.toItem(i);
    return true;
  }

  /** Every height is exact. */
  get exact() { return this.layout.unmeasured === 0; }
  /** Every height is exact and no expansion is in flight (the benchmark waits for this). */
  get settled() { return this.exact && this.busy === 0; }
}
