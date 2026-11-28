// LPT-1943: item heights for the virtual list. GPUI's list needs every item's height up front, so the mod
// computes them: exact (wrapped) for items whose body is loaded and has been measured, estimated for the rest.
// Heights are whole rows; a Fenwick tree keeps prefix sums and "which item is at this row" in O(log n).
import { estimateRows, wrapRows } from "./wrap.js";

/** Rows of padding/headers an item kind adds around its text. */
const CHROME = { user: 2, md: 1, think: 2, tool: 2, bash: 2, rows: 1 };
const FALLBACK_ROWS = 3;

export class TreeLayout {
  constructor(model) {
    this.model = model;
    this.cols = 100;
    this.heights = new Int32Array(0);
    this.measured = new Uint8Array(0);
    this.tree = new Int32Array(1);
    /** Wrapped rows per id at `cols`; dropped on a width change. */
    this.wrapped = new Map();
    this.fallbackRows = new Map();
    this.cursor = 0;
    /** Bumps whenever any height changes: a renderer re-sends item sizes only then. */
    this.version = 0;
    /** Items whose height changed since the owner last looked (null: everything may have). */
    this.touched = new Set();
    this.unmeasured = 0;
  }

  /** Padding rows plus the "N more lines" marker row of a folded item. */
  chrome(item) { return (CHROME[item.k] ?? 1) + (this.model.isFolded(item) ? 1 : 0); }

  estimate(item) {
    if (item.k === "rows") return this.fallbackRows.get(item.id)?.rows ?? FALLBACK_ROWS;
    // A folded item draws only its first lines: estimate from what is shown, not from the full text.
    const shown = item.x ? Math.max(1, item.n - item.x) : item.n;
    return this.chrome(item) + estimateRows(shown, item.x ? Math.min(item.c, shown * 80) : item.c, this.cols);
  }

  /** Rebuild everything from the model: after a snapshot or a width change. */
  rebuild(cols = this.cols) {
    if (cols !== this.cols) { this.cols = cols; this.wrapped.clear(); this.fallbackRows.clear(); }
    const items = this.model.items;
    this.heights = new Int32Array(items.length);
    this.measured = new Uint8Array(items.length);
    this.cursor = 0;
    this.version++;
    this.touched = null; // structure changed: the owner rebuilds whatever it derived
    for (let i = 0; i < items.length; i++) this.heights[i] = this.estimate(items[i]);
    this.countUnmeasured();
    this.buildTree();
  }

  /** Items whose height is still an estimate; Pi-rows items are exact once their rows arrive and are not counted. */
  countUnmeasured() {
    const items = this.model.items;
    let count = 0;
    for (let i = 0; i < items.length; i++) { if (items[i].k === "rows") this.measured[i] = 1; else if (!this.measured[i]) count++; }
    this.unmeasured = count;
  }

  buildTree() {
    const n = this.heights.length;
    this.tree = new Int32Array(n + 1);
    for (let i = 1; i <= n; i++) {
      this.tree[i] += this.heights[i - 1];
      const parent = i + (i & -i);
      if (parent <= n) this.tree[parent] += this.tree[i];
    }
  }

  /** Mirror a model change: splice the arrays, estimate inserted items, rebuild the tree. */
  splice(at, removed, inserted) {
    const items = this.model.items;
    const heights = Array.from(this.heights);
    const measured = Array.from(this.measured);
    const add = [];
    for (let i = 0; i < inserted; i++) add.push(this.estimate(items[at + i]));
    heights.splice(at, removed, ...add);
    measured.splice(at, removed, ...new Array(inserted).fill(0));
    this.heights = Int32Array.from(heights);
    this.measured = Uint8Array.from(measured);
    this.version++;
    this.touched = null; // structure changed: the owner rebuilds whatever it derived
    for (let i = 0; i < inserted; i++) this.wrapped.delete(items[at + i].id);
    this.countUnmeasured();
    this.buildTree();
  }

  get count() { return this.heights.length; }
  get totalRows() { return this.prefix(this.heights.length); }

  /** Sum of the heights of items [0, i). */
  prefix(i) {
    let sum = 0;
    for (; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  /** The item that contains row `row`, and the row offset inside it. */
  locate(row) {
    const n = this.heights.length;
    if (!n) return { index: 0, offset: 0 };
    if (row < 0) return { index: 0, offset: 0 };
    let position = 0, remaining = row;
    let step = 1;
    while (step * 2 <= n) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = position + step;
      if (next <= n && this.tree[next] <= remaining) { position = next; remaining -= this.tree[next]; }
    }
    if (position >= n) return { index: n - 1, offset: this.heights[n - 1] };
    return { index: position, offset: remaining };
  }

  setHeight(i, rows) {
    const delta = rows - this.heights[i];
    this.heights[i] = rows;
    if (!this.measured[i]) this.unmeasured--;
    this.measured[i] = 1;
    if (delta) { this.version++; this.touched?.add(i); for (let k = i + 1; k <= this.heights.length; k += k & -k) this.tree[k] += delta; }
    return delta;
  }

  /**
   * Measure item i from its loaded body at the current width. Returns the change in rows,
   * or undefined when its body is not loaded yet.
   */
  measure(i, keep = true) {
    const item = this.model.items[i];
    const body = this.model.bodies.get(item.id);
    if (!body) return undefined;
    if (this.measured[i]) return 0;
    if (keep) return this.setHeight(i, this.chrome(item) + this.rowsOf(item, body).total);
    // Background measuring far from the screen: count the rows, keep nothing.
    let total = 0;
    for (const key of ["t", "a", "o"]) if (typeof body[key] === "string") total += wrapRows(body[key], this.cols).length;
    return this.setHeight(i, this.chrome(item) + total);
  }

  /** An item's body changed (expanded or folded): measure it again now. Returns the change in rows. */
  remeasure(id) {
    const i = this.model.indexOf(id);
    if (i < 0) return 0;
    if (this.measured[i]) { this.measured[i] = 0; this.unmeasured++; }
    this.wrapped.delete(id);
    return this.measure(i, true) ?? 0;
  }

  /** Measure up to `budgetMs` of items from a moving cursor; returns true when every loaded item is exact. */
  measureSlice(budgetMs) {
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    const items = this.model.items;
    let scanned = 0;
    while (scanned < items.length) {
      if (this.cursor >= items.length) this.cursor = 0;
      const i = this.cursor++;
      scanned++;
      if (items[i].k === "rows" || this.measured[i]) continue;
      this.measure(i, false);
      if ((typeof performance !== "undefined" ? performance.now() : Date.now()) - started > budgetMs) return false;
    }
    return true;
  }

  /** Wrapped rows of the body parts, cached per id for the current width. */
  rowsOf(item, body) {
    let rows = this.wrapped.get(item.id);
    if (rows && rows.body === body) return rows;
    const parts = {};
    let total = 0;
    for (const key of ["t", "a", "o"]) {
      if (typeof body[key] !== "string") continue;
      parts[key] = wrapRows(body[key], this.cols);
      total += parts[key].length;
    }
    rows = { body, parts, total };
    // Only what is near the screen is kept; far items are re-wrapped when they come back.
    if (this.wrapped.size > 1500) this.wrapped.clear();
    this.wrapped.set(item.id, rows);
    return rows;
  }

  /** A fallback item's rows from Pi (`rows` reply): their count is its exact height. */
  setFallback(id, lines, cols) {
    if (cols !== this.cols) return false;
    this.fallbackRows.set(id, { rows: Math.max(1, lines.length), lines });
    const i = this.model.indexOf(id);
    if (i >= 0) this.setHeight(i, Math.max(1, lines.length));
    return i >= 0;
  }

  /** Items intersecting rows [top, top + rows), with their first row. */
  window(top, rows) {
    const first = this.locate(top);
    const out = [];
    let row = top - first.offset;
    for (let i = first.index; i < this.heights.length && row < top + rows; i++) {
      out.push({ index: i, row });
      row += this.heights[i];
    }
    return out;
  }
}
