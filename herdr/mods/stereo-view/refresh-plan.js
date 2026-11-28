/** How often a shown copy reads the bridge. */
export const LIVE_MS = 700;
/** How often a copy that is not on screen (its pane is in TUI mode) keeps its data warm. */
export const HIDDEN_MS = 2500;
/** The granularity of the copy's clock; it decides when a refresh is due. */
export const TICK_MS = 200;
/** How soon the panels are read again while Pi is still measuring rows at a new width. */
export const SETTLE_MS = 30;
/** How many unusable pages in a row a panel waits out before it shows what Pi sent. */
export const UNUSABLE_LIMIT = 40;

const ANSI = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Whether a row has text, ignoring styles and blanks. @param {string | undefined} line */
export function rowHasText(line) {
  return line !== undefined && line.replace(ANSI, "").trim() !== "";
}

/**
 * Whether a page of rows from the bridge may replace what a panel shows. While Pi lays history out again at a new
 * width, an older Pi answers with an empty window (past the end) or a window of unmeasured, blank rows. Drawing
 * that would blank a panel that has content, so the panel keeps its rows and reads again.
 * @param {{top: number, total: number, lines: string[]}} page @param {boolean} hasContent whether the panel shows any row with text now
 */
export function pageUsable(page, hasContent) {
  if (!hasContent || page.total === 0) return true;
  // An empty window is only wrong when it lies past the end of the history; inside it, it is what Pi really has.
  if (page.lines.length === 0) return page.top < page.total;
  return page.lines.some(rowHasText);
}

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
