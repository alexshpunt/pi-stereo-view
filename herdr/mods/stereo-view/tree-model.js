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
    /** Loaded bodies by id: { t?, a?, o? }. */
    this.bodies = new Map();
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
    if (item.b) { this.bodies.set(item.id, item.b); delete item.b; } else this.bodies.delete(item.id);
  }

  delta(message) {
    if (!this.ready || message.epoch !== this.epoch || message.rev <= this.rev) return { kind: "ignored", resync: !this.ready || message.epoch !== this.epoch };
    const removed = this.items.slice(message.at, message.at + message.remove);
    const inserted = message.items;
    const keep = new Set(inserted.map(item => item.id));
    for (const item of removed) if (!keep.has(item.id)) this.bodies.delete(item.id);
    for (const item of inserted) { if (item.b) { this.bodies.set(item.id, item.b); delete item.b; } else this.bodies.delete(item.id); }
    this.items.splice(message.at, message.remove, ...inserted);
    this.rev = message.rev;
    this.index = new Map();
    return { kind: "delta", at: message.at, removed: message.remove, inserted: inserted.length };
  }

  /** Bodies came back for a request; truncated ids keep their (cut) text. */
  storeBodies(bodies) {
    const loaded = [];
    for (const id of Object.keys(bodies)) {
      const body = bodies[id];
      if (!body || this.indexOf(id) < 0) continue;
      this.bodies.set(id, body);
      loaded.push(id);
    }
    return loaded;
  }

  body(at) { const item = this.items[at]; return item ? this.bodies.get(item.id) : undefined; }
  get length() { return this.items.length; }
}

/** Plain text of an item's body for search and copy. */
export function bodyText(body) {
  if (!body) return "";
  return body.t ?? [body.a, body.o].filter(Boolean).join("\n");
}
