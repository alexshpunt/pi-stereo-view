// LPT-1943: the local copy of Pi's element tree of one pane. Pi sends a snapshot (headers in chunks, bodies of the
// tail) and then splices; everything else (scroll, resize, search) works on this copy without a request.

export class TreeModel {
  constructor() { this.reset(); }

  reset() {
    this.epoch = -1;
    this.rev = 0;
    /** Item headers in order: { id, k, n, c, m?, b? }. */
    this.items = [];
    this.index = new Map();
    /** Bodies by id: { t?, a?, o? }. Every item has one: folded (as the TUI shows it) unless it is expanded. */
    this.bodies = new Map();
    /** Ids whose body in `bodies` is the full one (expanded or never folded); `folded` keeps the folded body meanwhile. */
    this.full = new Set();
    this.folded = new Map();
    this.ready = false;
    this.filled = 0;
  }

  /** Position of an id, or -1. The map is rebuilt lazily after a splice. */
  indexOf(id) {
    if (!this.index.size && this.items.length) this.reindex();
    const at = this.index.get(id);
    return at !== undefined && this.items[at]?.id === id ? at : this.reindexOf(id);
  }
  reindex() { this.index = new Map(this.items.map((item, at) => [item.id, at])); }
  reindexOf(id) { this.reindex(); return this.index.get(id) ?? -1; }

  /**
   * Apply one server message. Returns a change `{ kind, at, removed, inserted, resync }` for the layout,
   * or undefined when the message does not touch the tree.
   */
  apply(message) {
    if (message.t === "snap") return this.snapshot(message);
    if (message.t === "delta") return this.delta(message);
    return undefined;
  }

  snapshot(message) {
    if (message.at === 0) {
      this.reset();
      this.epoch = message.epoch;
      this.rev = message.rev;
      this.items = new Array(message.total);
      this.snapRev = message.rev;
    } else if (message.rev !== this.snapRev || message.epoch !== this.epoch) return { kind: "ignored", resync: true };
    message.items.forEach((item, i) => this.place(message.at + i, item));
    this.filled += message.items.length;
    if (message.last) {
      this.ready = true;
      this.reindex();
      return { kind: "snapshot", at: 0, removed: 0, inserted: this.items.length, last: true };
    }
    return { kind: "snapshot", at: message.at, removed: 0, inserted: message.items.length, last: false };
  }

  place(at, item) {
    this.items[at] = item;
    this.setBody(item);
  }

  /** A header arrived with its body: it replaces anything held for the id, including an expansion. */
  setBody(item) {
    this.full.delete(item.id); this.folded.delete(item.id);
    if (item.b) { this.bodies.set(item.id, item.b); delete item.b; } else this.bodies.delete(item.id);
  }

  delta(message) {
    if (!this.ready || message.epoch !== this.epoch || message.rev <= this.rev) return { kind: "ignored", resync: !this.ready || message.epoch !== this.epoch };
    const removed = this.items.slice(message.at, message.at + message.remove);
    const inserted = message.items;
    const keep = new Set(inserted.map(item => item.id));
    for (const item of removed) if (!keep.has(item.id)) { this.bodies.delete(item.id); this.full.delete(item.id); this.folded.delete(item.id); }
    for (const item of inserted) this.setBody(item);
    this.items.splice(message.at, message.remove, ...inserted);
    this.rev = message.rev;
    this.index = new Map();
    return { kind: "delta", at: message.at, removed: message.remove, inserted: inserted.length };
  }

  /** Whether an item shows its folded body (it has hidden lines and is not expanded). */
  isFolded(item) { return !!item.x && !this.full.has(item.id); }

  /** Full bodies came back for a request (expand or copy); the folded one is kept to fold again. */
  storeBodies(bodies) {
    const loaded = [];
    for (const id of Object.keys(bodies)) {
      const body = bodies[id];
      if (!body || this.indexOf(id) < 0) continue;
      if (!this.full.has(id)) { const old = this.bodies.get(id); if (old) this.folded.set(id, old); }
      this.bodies.set(id, body);
      this.full.add(id);
      loaded.push(id);
    }
    return loaded;
  }

  /** Back to the folded body. Returns whether the item changed. */
  fold(id) {
    const folded = this.folded.get(id);
    if (!folded || !this.full.has(id)) return false;
    this.bodies.set(id, folded); this.folded.delete(id); this.full.delete(id);
    return true;
  }

  /** Characters held in all bodies. */
  get bodyChars() {
    let chars = 0;
    for (const body of this.bodies.values()) chars += (body.t?.length ?? 0) + (body.a?.length ?? 0) + (body.o?.length ?? 0);
    return chars;
  }

  /** Characters held in expanded bodies only (the part that can be dropped again). */
  get expandedChars() {
    let chars = 0;
    for (const id of this.folded.keys()) { const body = this.bodies.get(id); if (body) chars += (body.t?.length ?? 0) + (body.a?.length ?? 0) + (body.o?.length ?? 0); }
    return chars;
  }

  /**
   * Keep expansions bounded: above `maxChars` of expanded text, fold the ones farthest from item `center` until
   * 75% remain. Folded bodies are never dropped (the whole tree stays in memory, like terminal scrollback).
   * Returns the ids folded.
   */
  evictExpanded(center, maxChars) {
    let chars = this.expandedChars;
    if (chars <= maxChars) return [];
    const order = [];
    for (const id of this.folded.keys()) { const at = this.indexOf(id); order.push([at < 0 ? Infinity : Math.abs(at - center), id]); }
    order.sort((x, y) => y[0] - x[0]);
    const dropped = [];
    for (const [, id] of order) {
      if (chars <= maxChars * 0.75) break;
      const body = this.bodies.get(id);
      chars -= (body?.t?.length ?? 0) + (body?.a?.length ?? 0) + (body?.o?.length ?? 0);
      this.fold(id);
      dropped.push(id);
    }
    return dropped;
  }

  body(at) { const item = this.items[at]; return item ? this.bodies.get(item.id) : undefined; }
  get length() { return this.items.length; }
}

/** Plain text of an item's body for search and copy. */
export function bodyText(body) {
  if (!body) return "";
  return body.t ?? [body.a, body.o].filter(Boolean).join("\n");
}
