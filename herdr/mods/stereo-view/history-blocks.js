// Pure helpers for drawing Pi's terminal rows as blocks: the controls Pi draws under each block, the extent of
// the block under the pointer, a row's background and when two columns still fit.

/** U+034F: Pi's icon-style controls carry it after the glyph to stop terminals rescaling it; it has no width. */
const JOINER = "\u034f";
const GO_TO = /\[(?:Go to|\s*⇄\s*)\]/;
const COPY = /\[(?:Copy|\s*⧉\u034f?\s*)\]/;

/** Drop what has no width of its own, so string offsets count terminal cells. @param {string} text @param {number} index */
function cellColumn(text, index) {
  let column = 0;
  for (let i = 0; i < index; i++) if (text[i] !== JOINER) column++;
  return column;
}

/**
 * The controls of a block's footer row, `[Go to] [Copy]` or its icon style, with their first cell and width.
 * A row that holds anything else is not a footer.
 * @param {string} text the row's visible text
 * @returns {{goTo?: {column: number, width: number}, copy?: {column: number, width: number}} | null}
 */
export function footerControls(text) {
  if (typeof text !== "string" || (!text.includes("]"))) return null;
  /** @type {{goTo?: {column: number, width: number}, copy?: {column: number, width: number}}} */
  const found = {};
  let rest = text;
  for (const [name, pattern] of /** @type {const} */ ([["goTo", GO_TO], ["copy", COPY]])) {
    const match = pattern.exec(rest);
    if (!match) continue;
    const width = match[0].length - (match[0].split(JOINER).length - 1);
    found[name] = { column: cellColumn(text, match.index), width };
    rest = rest.slice(0, match.index) + " ".repeat(match[0].length) + rest.slice(match.index + match[0].length);
  }
  return (found.goTo || found.copy) && rest.trim() === "" ? found : null;
}

/**
 * The rows of the block that holds `row`: from the row after the previous block's footer to its own footer.
 * `footerAt(index)` gives that row's footer controls, null for any other row and undefined for a row that is not
 * loaded; a block whose footer or whose rows are not loaded has no known extent.
 * @param {number} row
 * @param {(index: number) => ReturnType<typeof footerControls> | undefined} footerAt
 * @param {number} [limit] how far to look below `row`
 * @returns {{start: number, end: number, footer: NonNullable<ReturnType<typeof footerControls>>} | null}
 */
export function blockAround(row, footerAt, limit = 1024) {
  if (!Number.isSafeInteger(row) || row < 0) return null;
  let footer;
  let end = row;
  for (; end < row + limit; end++) {
    const here = footerAt(end);
    if (here === undefined) return null;
    if (here) { footer = here; break; }
  }
  if (!footer) return null;
  let start = row;
  while (start > 0) {
    const above = footerAt(start - 1);
    if (above === undefined || above) break;
    start--;
  }
  return { start, end, footer };
}

/** The row that carries a block's buttons: its first row on screen. */
export function buttonRow(block, firstVisible) {
  return Math.min(block.end, Math.max(block.start, firstVisible));
}

/**
 * Whether a run's text begins or ends in a blank, so its background can run on past that edge without changing
 * what is drawn: Pi pads a block's rows with blanks to the panel's width, and the run's own cells fall short of
 * the panel only by the gutters and by rounding.
 * @param {{text: string} | undefined} run
 * @param {"start" | "end"} side
 */
export function padsEdge(run, side) {
  if (!run?.text) return false;
  return /\s/.test(side === "start" ? run.text[0] : run.text[run.text.length - 1]);
}

/** Two panels side by side need this many terminal cells each; below that the view stacks them. */
export const MIN_COLUMN_CELLS = 40;

/**
 * Whether a split view can keep its two columns at this width.
 * @param {number} width the history area's width in logical pixels
 * @param {number} cellWidth one terminal cell's width in logical pixels
 * @param {number} chrome what a panel spends beside its cells: the row gutters and the scrollbar lane
 * @param {number} divider the divider's width
 */
export function columnsFit(width, cellWidth, chrome, divider) {
  return width >= 2 * (MIN_COLUMN_CELLS * cellWidth + chrome) + divider;
}
