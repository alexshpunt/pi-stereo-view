// LPT-1943: local text search over the loaded bodies. It runs in slices of a time budget so no frame is
// stretched by a search over tens of megabytes; hits appear as the slices finish.
import { bodyText } from "./tree-model.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class TreeSearch {
  constructor(model) { this.model = model; this.query = ""; this.hits = []; this.next = 0; this.done = true; this.missing = 0; }

  /** Start a case-insensitive search from item 0. */
  start(query) {
    this.query = query.toLowerCase();
    this.hits = [];
    this.next = 0;
    this.missing = 0;
    this.done = !this.query;
  }

  /** Scan items for at most `budgetMs`; returns the number of items scanned. Items without a body are counted as missing. */
  step(budgetMs = 4) {
    const started = now();
    const items = this.model.items;
    let scanned = 0;
    while (this.next < items.length && now() - started < budgetMs) {
      const item = items[this.next];
      const body = this.model.bodies.get(item.id);
      if (!body) this.missing++;
      else {
        const text = bodyText(body).toLowerCase();
        for (let at = text.indexOf(this.query); at >= 0; at = text.indexOf(this.query, at + this.query.length)) {
          this.hits.push({ index: this.next, id: item.id, at });
          if (this.hits.length >= 5000) { this.done = true; return scanned; }
        }
      }
      this.next++;
      scanned++;
    }
    if (this.next >= items.length) this.done = true;
    return scanned;
  }
}
