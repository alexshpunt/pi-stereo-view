import type { Component } from "@earendil-works/pi-tui";
import type { NativeContentIndex, Pane } from "./content.ts";

export interface GuiEntry { id: string; lines: readonly string[] }
export interface GuiPage { v: 1; revision: number; total: number; start: number; entries: GuiEntry[] }

/** A paged projection of the live native index. Only the requested entries are rendered. */
export class GuiContent {
  private readonly identities = new WeakMap<Component, Map<string, string>>();
  private readonly ordinals = new WeakMap<readonly object[], Uint32Array>();
  private nextId = 0;
  private revision = 0;

  constructor(private readonly index: NativeContentIndex) {}

  page(pane: Pane, start: number, count: number, width: number): GuiPage {
    this.index.beginFrame();
    const entries = this.index.entries(pane);
    let ordinals = this.ordinals.get(entries);
    if (!ordinals) {
      ordinals = new Uint32Array(entries.length);
      const occurrence = new Map<Component, number>();
      entries.forEach((entry, position) => {
        const ordinal = occurrence.get(entry.source) ?? 0;
        ordinals![position] = ordinal;
        occurrence.set(entry.source, ordinal + 1);
      });
      this.ordinals.set(entries, ordinals);
    }
    const result: GuiEntry[] = [];
    for (let position = start; position < Math.min(entries.length, start + count); position++) {
      const entry = entries[position]!;
      const ordinal = ordinals[position]!;
      let byProjection = this.identities.get(entry.source);
      if (!byProjection) { byProjection = new Map(); this.identities.set(entry.source, byProjection); }
      const key = `${pane}:${entry.kind}:${ordinal}`;
      let id = byProjection.get(key);
      if (!id) { id = String(++this.nextId); byProjection.set(key, id); }
      result.push({ id, lines: entry.component.render(width) });
    }
    return { v: 1, revision: ++this.revision, total: entries.length, start, entries: result };
  }
}
