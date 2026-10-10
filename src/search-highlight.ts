import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { extractAnsiCode } from "@earendil-works/pi-tui/dist/utils.js";
import type { SearchHit } from "./search.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const normalize = (text: string, lettersOnly: boolean): string => text.normalize("NFKC").toLowerCase()
  .replace(lettersOnly ? /[^\p{L}\p{N}]/gu : /\s/gu, "");
interface Position { row: number; start: number; end: number }

/** An actual clock inserted by CompactMessage, not a suffix guessed from saved text. */
export interface SearchClock { row: number; column: number }

function locate(lines: string[], hit: SearchHit, lettersOnly: boolean, clock?: SearchClock): { text: string; positions: Position[] } | undefined {
  const wanted = normalize(hit.text, lettersOnly);
  if (!wanted) return undefined;
  let text = "";
  const positions: Position[] = [];
  for (const [row, line] of lines.entries()) {
    // Only the decorator knows where its clock starts. Saved trailing times remain text.
    const plain = stripTerminalSequences(clock?.row === row ? sliceByColumn(line, 0, clock.column) : line);
    for (const { segment, index } of graphemes.segment(plain)) {
      const value = normalize(segment, lettersOnly);
      text += value;
      const position = { row, start: index, end: index + segment.length };
      for (let offset = 0; offset < value.length; offset++) positions.push(position);
    }
  }
  const preceding = normalize(stripTerminalSequences(hit.entry.text).split("\n").slice(0, hit.line).join("\n"), lettersOnly);
  let occurrence = 0;
  let precedingStart = 0;
  for (;;) {
    const index = preceding.indexOf(wanted, precedingStart);
    if (index < 0) break;
    occurrence++;
    precedingStart = index + wanted.length;
  }
  let start = 0;
  for (;;) {
    const index = text.indexOf(wanted, start);
    if (index < 0) return undefined;
    if (occurrence-- === 0) return { text: wanted, positions: positions.slice(index, index + wanted.length) };
    start = index + wanted.length;
  }
}

/** Locate the exact saved occurrence using the same mapping as its highlight. */
export function searchHitRow(lines: string[], hit: SearchHit, clock?: SearchClock): number | undefined {
  return (locate(lines, hit, false, clock) ?? locate(lines, hit, true, clock))?.positions[0]?.row;
}
function tokenPositions(text: string, token: string): number[] | undefined {
  const match = (query: string): number[] | undefined => {
    const positions: number[] = [];
    let previous = -1;
    for (let offset = 0; offset < query.length; offset++) {
      const index = text.indexOf(query[offset], previous + 1);
      if (index < 0) return undefined;
      positions.push(index);
      previous = index;
    }
    return positions;
  };
  const primary = match(token);
  if (primary) return primary;
  // Pi's fuzzyMatch accepts number/letter tokens in either order.
  const parts = token.match(/^([a-z]+)([0-9]+)$/) ?? token.match(/^([0-9]+)([a-z]+)$/);
  return parts ? match(parts[2] + parts[1]) : undefined;
}

function decorate(line: string, selected: Position[], theme: Theme): string {
  let output = "";
  let offset = 0;
  let plainOffset = 0;
  let styles: string[] = [];
  while (offset < line.length) {
    // Use the native parser so OSC markers and links remain byte-for-byte, exactly once.
    const ansi = extractAnsiCode(line, offset);
    if (ansi) {
      output += ansi.code;
      if ((ansi.code.startsWith("\x1b[") || ansi.code.startsWith("\x9b")) && ansi.code.endsWith("m")) {
        if (ansi.code === "\x1b[0m" || ansi.code === "\x1b[m") styles = [];
        styles.push(ansi.code);
      }
      offset += ansi.length;
      continue;
    }
    let end = offset + 1;
    while (end < line.length && !extractAnsiCode(line, end)) end++;
    for (const { segment } of graphemes.segment(line.slice(offset, end))) {
      if (selected.some(position => plainOffset >= position.start && plainOffset < position.end)) {
        output += theme.style(segment, { fg: "searchMatchText", bg: "searchMatchBg" });
        // Restore the native style, including an existing background, before the next cell.
        output += "\x1b[0m" + styles.join("");
      } else output += segment;
      plainOffset += segment.length;
    }
    offset = end;
  }
  return output;
}

/**
 * Highlight only the query characters in one saved occurrence's native rows.
 * Native visible text, widths, links and markers stay unchanged. Rows containing
 * image placement, an empty query or an unmappable saved fragment are left alone.
 * For a standalone temporary excerpt, pass that excerpt as the hit's sole saved line.
 */
export function highlightSearchRows(lines: string[], hit: SearchHit, query: string, theme: Theme, clock?: SearchClock): string[] {
  const tokens = query.trim().split(/[\s/]+/).filter(Boolean);
  if (!tokens.length || lines.some(line => line.includes("\x1b_G") || line.includes("\x1b]1337;") || line.includes("\x1bP"))) return lines;
  let lettersOnly = false;
  let found = locate(lines, hit, false, clock);
  if (!found) { lettersOnly = true; found = locate(lines, hit, true, clock); }
  if (!found) return lines;
  const byRow = new Map<number, Map<number, Position>>();
  for (const token of tokens) {
    const normalized = normalize(token, lettersOnly);
    if (!normalized) continue;
    const matched = tokenPositions(found.text, normalized);
    if (!matched) return lines;
    for (const index of matched) {
      const position = found.positions[index];
      let selected = byRow.get(position.row);
      if (!selected) { selected = new Map(); byRow.set(position.row, selected); }
      selected.set(position.start, position);
    }
  }
  if (!byRow.size) return lines;
  return lines.map((line, row) => {
    const selected = byRow.get(row);
    return selected ? decorate(line, [...selected.values()], theme) : line;
  });
}
