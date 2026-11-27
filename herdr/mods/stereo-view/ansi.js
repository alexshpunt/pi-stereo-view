// ANSI text (what Pi's TUI draws) to styled runs for the app's own elements.
//
// A run is { text, fg, bg, bold, italic, underline, dim, link }. `link` is the OSC 8 target, if any.
// `fg` and `bg` are "#rrggbb", or { ansi: 0..15 } for a
// colour of the terminal palette, which the caller takes from the theme so it follows light and dark appearances.

const XTERM_LEVELS = [0, 95, 135, 175, 215, 255];

function hex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("")}`;
}

/** An xterm 256-colour index: 0..15 stay palette colours, the cube and the grey ramp are fixed. */
function indexed(n) {
  if (n < 16) return { ansi: n };
  if (n < 232) {
    const i = n - 16;
    return hex(XTERM_LEVELS[Math.floor(i / 36) % 6], XTERM_LEVELS[Math.floor(i / 6) % 6], XTERM_LEVELS[i % 6]);
  }
  const grey = 8 + (n - 232) * 10;
  return hex(grey, grey, grey);
}

const FRESH = { fg: undefined, bg: undefined, bold: false, italic: false, underline: false, dim: false, inverse: false };

/** Apply the parameters of one SGR sequence (`ESC [ ... m`) to a style. */
function applySgr(style, params) {
  const next = { ...style };
  const p = params.length === 0 ? [0] : params;
  for (let i = 0; i < p.length; i += 1) {
    const code = p[i];
    if (code === 0) Object.assign(next, FRESH);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = { ansi: code - 30 };
    else if (code >= 90 && code <= 97) next.fg = { ansi: code - 90 + 8 };
    else if (code >= 40 && code <= 47) next.bg = { ansi: code - 40 };
    else if (code >= 100 && code <= 107) next.bg = { ansi: code - 100 + 8 };
    else if (code === 39) next.fg = undefined;
    else if (code === 49) next.bg = undefined;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      if (p[i + 1] === 5 && Number.isFinite(p[i + 2])) {
        next[target] = indexed(p[i + 2]);
        i += 2;
      } else if (p[i + 1] === 2 && Number.isFinite(p[i + 4])) {
        next[target] = hex(p[i + 2], p[i + 3], p[i + 4]);
        i += 4;
      }
    }
  }
  return next;
}

/**
 * One line of ANSI text as runs. Colour sequences and OSC 8 links are applied; other escape sequences are dropped.
 * Tabs become spaces. Adjacent runs with the same style and link are joined.
 */
export function parseAnsi(line) {
  const runs = [];
  let style = { ...FRESH };
  let link;
  let text = "";
  const flush = () => {
    if (text === "") return;
    const last = runs[runs.length - 1];
    const same =
      last && last.link === link &&
      JSON.stringify([last.fg, last.bg, last.bold, last.italic, last.underline, last.dim, last.inverse]) ===
        JSON.stringify([style.fg, style.bg, style.bold, style.italic, style.underline, style.dim, style.inverse]);
    if (same) last.text += text;
    else runs.push({ text, ...style, link });
    text = "";
  };
  const input = String(line).replace(/\t/g, "    ");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\u009d" || (ch === "\u001b" && input[i + 1] === "]")) {
      const start = i + (ch === "\u009d" ? 1 : 2);
      let end = start;
      while (end < input.length && input[end] !== "\u0007" && input[end] !== "\u009c" &&
        !(input[end] === "\u001b" && input[end + 1] === "\\")) end++;
      // An incomplete control string is not visible text.
      if (end === input.length) break;
      const payload = input.slice(start, end);
      if (payload.startsWith("8;")) {
        const separator = payload.indexOf(";", 2);
        if (separator !== -1) {
          flush();
          link = payload.slice(separator + 1) || undefined;
        }
      }
      i = end + (input[end] === "\u001b" ? 1 : 0);
      continue;
    }
    if (ch !== "\u001b") {
      text += ch;
      continue;
    }
    if (input[i + 1] === "[") {
      let j = i + 2;
      while (j < input.length && /[0-9;:]/.test(input[j])) j += 1;
      const final = input[j];
      if (final === "m") {
        flush();
        style = applySgr(style, input.slice(i + 2, j).split(/[;:]/).filter((s) => s !== "").map(Number));
      }
      i = j;
    } else {
      // Another escape (a two-character one): skip it.
      i += 1;
    }
  }
  flush();
  return runs;
}

/** The visible text of an ANSI line. */
export function plainAnsi(line) {
  return parseAnsi(line).map((r) => r.text).join("");
}
