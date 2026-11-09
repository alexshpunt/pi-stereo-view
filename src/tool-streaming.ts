import type { Component } from "@earendil-works/pi-tui";
import type { ContentEntry } from "./content.ts";

interface Live { finishedAt?: number; timer?: ReturnType<typeof setTimeout> }

/**
 * Tracks which tool calls Compact Activity still shows in full. A call is live from the moment it is first seen
 * running until its delay has passed after it finished. Calls first seen already finished, such as a restored
 * session, were never live.
 */
export class ToolStreaming {
  private readonly live = new Map<Component, Live>();
  private readonly released = new WeakSet<Component>();

  constructor(private readonly delay: () => number, private readonly changed: () => void, private readonly now: () => number = Date.now) {}

  /** Advance every call's lifecycle from the current entries; call once per frame. */
  observe(entries: readonly ContentEntry[]): void {
    const present = new Set<Component>();
    for (const entry of entries) {
      if (!entry.tool || entry.owner !== entry.source) continue;
      const source = entry.source;
      present.add(source);
      if (this.released.has(source)) continue;
      const running = entry.tool().status === "running";
      let state = this.live.get(source);
      if (!state) {
        // Anything that is not running on first sight is history.
        if (!running) { this.released.add(source); continue; }
        state = {};
        this.live.set(source, state);
      }
      if (running) {
        if (state.timer) clearTimeout(state.timer);
        state.finishedAt = undefined; state.timer = undefined;
      } else if (state.finishedAt === undefined) {
        state.finishedAt = this.now();
        state.timer = setTimeout(this.changed, this.delay() + 20);
      } else if (this.now() - state.finishedAt >= this.delay()) this.release(source);
    }
    for (const source of [...this.live.keys()]) if (!present.has(source)) this.release(source);
  }

  isLive(source: Component): boolean { return this.live.has(source); }

  /** Collapse one call now, for example because the user closed it. */
  release(source: Component): void {
    const state = this.live.get(source);
    if (state?.timer) clearTimeout(state.timer);
    this.live.delete(source);
    this.released.add(source);
  }

  /** Stop streaming: everything collapses. */
  clear(): void {
    for (const source of [...this.live.keys()]) this.release(source);
  }

  dispose(): void { this.clear(); }
}
