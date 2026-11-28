// LPT-1943: monospace text wrapping done in the GUI. Pi sends unwrapped text; every width change is a local
// computation. `wrapRows` is the single source of truth: the same lines are drawn and counted.

/** Terminal cell width of one code point: 0 for combining marks, 2 for wide CJK/emoji, else 1. */
export function cellWidth(code) {
  if (code < 0x300) return code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0) ? 0 : 1;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}

/** Width in cells of a string. ASCII fast path first. */
export function stringWidth(text) {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x300) { width += code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0) ? 0 : 1; continue; }
    const point = text.codePointAt(i);
    if (point > 0xffff) i++;
    width += cellWidth(point);
  }
  return width;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Wrap one logical line (no "\n") to `cols` cells: break at spaces when possible, inside a word otherwise. */
export function wrapLine(line, cols, out) {
  // Most lines are printable ASCII (one cell per character): native string searches instead of a loop per character.
  if (PRINTABLE_ASCII.test(line)) { wrapAscii(line, cols, out); return; }
  wrapGeneral(line, cols, out);
}

/** The same breaks as `wrapGeneral` for printable ASCII. */
export function wrapAscii(line, cols, out) {
  const length = line.length;
  let start = 0;
  if (length <= cols) { out.push(line); return; }
  while (start < length) {
    const end = start + cols;
    if (end >= length) { out.push(line.slice(start)); return; }
    const lastSpace = line.lastIndexOf(" ", end - 1);
    const atSpace = line.charCodeAt(end) === 32;
    if (lastSpace > start && !atSpace) { out.push(line.slice(start, lastSpace)); start = lastSpace + 1; }
    else { out.push(line.slice(start, end)); start = atSpace ? end + 1 : end; }
  }
}

/** Any text: code points, wide characters and combining marks. */
export function wrapGeneral(line, cols, out) {
  if (line.length <= cols && stringWidth(line) <= cols) { out.push(line); return; }
  let start = 0;
  while (start < line.length) {
    let width = 0, end = start, lastSpace = -1;
    while (end < line.length) {
      const point = line.codePointAt(end);
      const w = point < 0x300 ? (point < 0x20 || (point >= 0x7f && point < 0xa0) ? 0 : 1) : cellWidth(point);
      if (width + w > cols && end > start) break;
      width += w;
      if (point === 32) lastSpace = end;
      end += point > 0xffff ? 2 : 1;
    }
    if (end >= line.length) { out.push(line.slice(start)); return; }
    if (lastSpace > start && line.codePointAt(end) !== 32) { out.push(line.slice(start, lastSpace)); start = lastSpace + 1; }
    else { out.push(line.slice(start, end)); start = line.codePointAt(end) === 32 ? end + 1 : end; }
  }
}

/** Visual rows of unwrapped text at `cols` cells; tabs become four spaces, "\r" is dropped. */
export function wrapRows(text, cols) {
  const out = [];
  const width = Math.max(1, cols | 0);
  let from = 0;
  for (;;) {
    let at = text.indexOf("\n", from);
    if (at < 0) at = text.length;
    let line = text.slice(from, at);
    if (line.includes("\t")) line = line.replaceAll("\t", "    ");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    wrapLine(line, width, out);
    if (at >= text.length) break;
    from = at + 1;
  }
  return out;
}

/** Row estimate for text that is not loaded yet: logical lines, plus the wraps its length suggests. */
export function estimateRows(lines, chars, cols) {
  return Math.max(lines, Math.ceil(chars / Math.max(1, cols)));
}
