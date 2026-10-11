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
 * Highlight the matcher's positive saved-text spans in native rows. Visible text,
 * widths, links and markers stay unchanged; images and unmapped fragments are skipped.
 * No query parsing or matching happens during rendering.
 */
export function highlightSearchRows(lines: string[], hit: SearchHit, theme: Theme, clock?: SearchClock): string[] {
  if (!hit.ranges?.length || lines.some(line => line.includes("\x1b_G") || line.includes("\x1b]1337;") || line.includes("\x1bP"))) return lines;
  let lettersOnly = false;
  let found = locate(lines, hit, false, clock);
  if (!found) { lettersOnly = true; found = locate(lines, hit, true, clock); }
  if (!found) return lines;
  const byRow = new Map<number, Position[]>();
  const savedGraphemes = [...graphemes.segment(hit.text)];
  for (const range of hit.ranges) {
    if (range.end <= range.start) continue;
    // A regex may select only the combining mark inside a visible grapheme.
    const selectedGraphemes = savedGraphemes.filter(part => part.index < range.end &&
      part.index + part.segment.length > range.start);
    if (!selectedGraphemes.length) continue;
    const first = selectedGraphemes[0];
    const last = selectedGraphemes[selectedGraphemes.length - 1];
    const start = normalize(hit.text.slice(0, first.index), lettersOnly).length;
    const end = normalize(hit.text.slice(0, last.index + last.segment.length), lettersOnly).length;
    const spans = new Map<number, Position>();
    if (start === end && /^\s+$/u.test(hit.text.slice(range.start, range.end))) {
      const before = found.positions[start - 1];
      const after = found.positions[end];
      if (before && after && before.row === after.row && before.end < after.start) {
        spans.set(before.row, { row: before.row, start: before.end, end: after.start });
      }
    }
    for (const position of found.positions.slice(start, end)) {
      const span = spans.get(position.row);
      if (span) span.end = Math.max(span.end, position.end);
      else spans.set(position.row, { ...position });
    }
    // Include visible spaces within each contiguous match, not between Boolean terms.
    for (const [row, span] of spans) {
      const selected = byRow.get(row) ?? [];
      selected.push(span);
      byRow.set(row, selected);
    }
  }
  if (!byRow.size) return lines;
  return lines.map((line, row) => {
    const selected = byRow.get(row);
    return selected ? decorate(line, selected, theme) : line;
  });
}
