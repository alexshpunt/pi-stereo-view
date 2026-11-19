import type { Component } from "@earendil-works/pi-tui";
import type { ContentEntry } from "./content.ts";

interface Live { entry: ContentEntry; finishedAt?: number; timer?: ReturnType<typeof setTimeout> }

/**
 * Tracks which tool calls Compact Activity still shows in full. A call is live from the moment it is first seen
 * running until its delay has passed after it finished. Calls first seen already finished, such as a restored
 * session, were never live.
 */
export class ToolStreaming {
  private readonly live = new Map<Component, Live>();
  private readonly released = new WeakSet<Component>();
  private observed?: readonly ContentEntry[];
  private changes = 0;

  constructor(private readonly delay: () => number, private readonly changed: () => void, private readonly now: () => number = Date.now) {}

  /**
   * Advance every call's lifecycle from the current entries; call once per frame. While the entries are the same
   * array, every call is already live or released, so only live calls need another look.
   */
  observe(entries: readonly ContentEntry[]): void {
    if (entries === this.observed) {
      for (const [source, state] of [...this.live]) this.advance(source, state);
      return;
    }
    this.observed = entries;
    const present = new Set<Component>();
    for (const entry of entries) {
      if (!entry.tool || entry.owner !== entry.source) continue;
      const source = entry.source;
      present.add(source);
      if (this.released.has(source)) continue;
      let state = this.live.get(source);
      if (!state) {
        // Anything that is not running on first sight is history.
        if (entry.tool().status !== "running") { this.released.add(source); continue; }
        state = { entry };
        this.live.set(source, state);
        this.changes++;
      }
      state.entry = entry;
      this.advance(source, state);
    }
    for (const source of [...this.live.keys()]) if (!present.has(source)) this.release(source);
  }

  private advance(source: Component, state: Live): void {
    if (state.entry.tool!().status === "running") {
      if (state.timer) clearTimeout(state.timer);
      state.finishedAt = undefined; state.timer = undefined;
    } else if (state.finishedAt === undefined) {
      state.finishedAt = this.now();
      state.timer = setTimeout(this.changed, this.delay() + 20);
    } else if (this.now() - state.finishedAt >= this.delay()) this.release(source);
  }

  isLive(source: Component): boolean { return this.live.has(source); }

  /** Changes whenever a call becomes live or is released. */
  get revision(): number { return this.changes; }

  /** Collapse one call now, for example because the user closed it. */
  release(source: Component): void {
    const state = this.live.get(source);
    if (state?.timer) clearTimeout(state.timer);
    if (this.live.delete(source)) this.changes++;
    this.released.add(source);
  }

  /** Stop streaming: everything collapses. */
  clear(): void {
    for (const source of [...this.live.keys()]) this.release(source);
  }

  dispose(): void { this.clear(); }
}
