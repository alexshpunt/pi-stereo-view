/** How often a shown copy reads the bridge. */
export const LIVE_MS = 700;
/** How often a copy that is not on screen (its pane is in TUI mode) keeps its data warm. */
export const HIDDEN_MS = 2500;
/** The granularity of the copy's clock; it decides when a refresh is due. */
export const TICK_MS = 200;

/**
 * What one tick of the copy's clock should do.
 *
 * - "live": read everything now (the copy is shown and either just appeared or its interval ran out).
 * - "prefetch": the copy is not shown but its tab is: read so the first frame after a switch has content.
 * - "idle": nothing is due.
 * @param {{shown: boolean, prefetchable: boolean, wasShown: boolean, elapsed: number}} input elapsed: ms since the last read
 * @returns {"live" | "prefetch" | "idle"}
 */
export function refreshPlan({ shown, prefetchable, wasShown, elapsed }) {
  if (shown) return !wasShown || elapsed >= LIVE_MS ? "live" : "idle";
  return prefetchable && elapsed >= HIDDEN_MS ? "prefetch" : "idle";
}

/**
 * The terminal cells a panel of this pixel size holds.
 * @param {{width: number, height: number}} size @param {number} zoom @param {number} cellWidth @param {number} chrome pixels beside the cells
 */
export function paneDimensions(size, zoom, cellWidth, chrome) {
  return {
    width: Math.max(10, Math.min(300, Math.floor((size.width / zoom - chrome) / cellWidth))),
    height: Math.max(1, Math.floor(size.height / zoom)),
  };
}

/**
 * Rows kept from before a width change are drawn until the first page at the new width arrives, then dropped:
 * a page replaces its own rows, and any other old row has the wrong wrapping.
 * @param {Map<number, unknown>} items @param {number} top @param {number} length returns the dropped indexes
 */
export function dropStaleRows(items, top, length) {
  const dropped = [];
  for (const index of items.keys()) {
    if (index < top || index >= top + length) { items.delete(index); dropped.push(index); }
  }
  return dropped;
}
