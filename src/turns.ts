import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi, colorToOkhsl, colorToRgb, foregroundAnsi, indexedColor, okhslColor, rgbColor, type Color, type RgbColor, type TerminalColorMode, type TUI,
} from "@earendil-works/pi-tui";

/** Hues of the turn palette; consecutive turns step by a stride coprime with it, so neighbours differ strongly. */
const HUES = 16;
const STRIDE = 7;

/**
 * Colors of one turn for each mark, layered over what lies beneath it; `undefined` for blocks before the first turn.
 * Layers stack from the terminal background up: the turn background, then hover, then stripes, lines and clocks.
 * Each layer adds its share of the turn's hue to the layers below, so a clock stays darker than a hovered block.
 */
export interface TurnColor {
  /** Background of the block's clock, on top of the block's layers. */
  clock: Color;
  /** Background of default cells: the turn background and hover layers; none when neither applies. */
  fill?: string;
  /** Moves the block's own explicit backgrounds as far as `fill` moved the terminal background; none without layers. */
  shift?: BackgroundShift;
  /** Background of the one-cell block stripe on the left, on top of the block's layers. */
  stripe: string;
  /** Foreground of the line stripe and the separator rule, on top of the block's layers. */
  line: string;
}

/** Which layers lie under a block's marks: the turn background, and hover while the turn is under the pointer. */
export interface TurnLayers {
  background: boolean;
  hover: boolean;
}

const NO_LAYERS: TurnLayers = { background: false, hover: false };

/** Percent of its color each layer adds on top of the layers below it. */
export interface TurnMix {
  clock: number;
  stripe: number;
  background: number;
  hover: number;
  /** The hover layer's color: the turn's own hue, or one color for every turn. */
  hoverColor?: RgbColor;
}

/** Default strengths, as the settings default to; without `hoverColor` the hover layer takes the turn's hue. */
export const DEFAULT_MIX: TurnMix = { clock: 10, stripe: 20, background: 8, hover: 10 };

const palettes = new WeakMap<Theme, { background?: RgbColor; mix: TurnMix; colors: Map<string, TurnColor[]> }>();

const sameRgb = (a: RgbColor | undefined, b: RgbColor | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);

/** Common dark and light terminal backgrounds, for a terminal that does not report its own. */
const GUESSED_BACKGROUND = { dark: rgbColor(24, 24, 27), light: rgbColor(250, 250, 250) };

/**
 * The terminal background moved toward each layer's color by that layer's share. Layers add up: in one color, the
 * shares sum; together they never pass the full colors, so the result stays between the background and them.
 */
function layered(base: RgbColor, parts: readonly { color: RgbColor; share: number }[]): Color {
  const total = parts.reduce((sum, part) => sum + part.share, 0);
  const scale = total > 1 ? 1 / total : 1;
  const channel = (key: "r" | "g" | "b"): number => Math.round(Math.min(255, Math.max(0,
    base[key] + parts.reduce((sum, part) => sum + part.share * scale * (part.color[key] - base[key]), 0))));
  return rgbColor(channel("r"), channel("g"), channel("b"));
}

/**
 * The palette for a theme over the terminal's background. Layers are additive: a mark's color moves the terminal
 * background toward each layer under it and then toward its own color, by each layer's share, so every layer stays
 * visible over the ones below. In one hue the shares simply sum, capped at the full hue. Without a reported
 * background, the theme's appearance picks a guess.
 */
export function turnColor(theme: Theme, turn: number, background?: RgbColor, mix: TurnMix = DEFAULT_MIX,
  layers: TurnLayers = NO_LAYERS): TurnColor | undefined {
  if (turn <= 0) return undefined;
  let palette = palettes.get(theme);
  if (!palette || palette.background !== background || palette.mix.clock !== mix.clock || palette.mix.stripe !== mix.stripe ||
    palette.mix.background !== mix.background || palette.mix.hover !== mix.hover || !sameRgb(palette.mix.hoverColor, mix.hoverColor)) {
    palette = { background, mix: { ...mix }, colors: new Map() };
    palettes.set(theme, palette);
  }
  const key = (layers.background ? "b" : "") + (layers.hover ? "h" : "");
  let colors = palette.colors.get(key);
  if (!colors) {
    const appearance = Reflect.get(theme, "appearance") === "light" ? "light" : "dark";
    const base: Color = background ? rgbColor(background.r, background.g, background.b) : GUESSED_BACKGROUND[appearance];
    const baseRgb = colorToRgb(base);
    const dark = colorToOkhsl(base).l < 0.5;
    const mode = theme.getColorMode();
    const share = (percent: number): number => Math.min(100, Math.max(0, percent)) / 100;
    colors = [];
    for (let index = 0; index < HUES; index++) {
      const hue = colorToRgb(okhslColor((index * 360) / HUES + 15, 0.85, dark ? 0.62 : 0.55));
      const hover = mix.hoverColor ?? hue;
      const under = [
        ...(layers.background ? [{ color: hue, share: share(mix.background) }] : []),
        ...(layers.hover ? [{ color: hover, share: share(mix.hover) }] : []),
      ];
      const stripe = layered(baseRgb, [...under, { color: hue, share: share(mix.stripe) }]);
      const clock = layered(baseRgb, [...under, { color: hue, share: share(mix.clock) }]);
      const fill = under.length ? colorToRgb(layered(baseRgb, under)) : undefined;
      const offset = fill && { r: fill.r - baseRgb.r, g: fill.g - baseRgb.g, b: fill.b - baseRgb.b };
      colors.push({
        clock,
        fill: fill && backgroundAnsi(rgbColor(fill.r, fill.g, fill.b), mode),
        // The clock is drawn over the block's layers already; moving it again would take it past them.
        shift: offset && (offset.r || offset.g || offset.b) ? new BackgroundShift(offset, mode, backgroundAnsi(clock, mode)) : undefined,
        stripe: backgroundAnsi(stripe, mode),
        line: foregroundAnsi(stripe, mode),
      });
    }
    palette.colors.set(key, colors);
  }
  return colors[((turn - 1) * STRIDE) % HUES];
}

/** A `#rrggbb` color, or undefined for anything else. */
export function parseHex(value: string): RgbColor | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  return match ? { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) } : undefined;
}

/** SGR parameters that take arguments: extended foreground, background and underline colors. */
const EXTENDED = new Set(["38", "48", "58"]);
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;:]*)m/g;
// eslint-disable-next-line no-control-regex
const ZONES = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

const clamp = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));

/** Moved colors a shift keeps; diffs and other renderers can bring many distinct backgrounds. */
const MOVED_COLORS = 1024;

/**
 * Moves explicit backgrounds by the offset the layers gave the terminal background, so a card keeps its contrast to the
 * plain background around it. Truecolor and 256-color backgrounds move; the basic 16 colors are the terminal's own and
 * have no known RGB value. One background, the block's clock, is exempt: its color already includes the layers.
 */
export class BackgroundShift {
  private readonly moved = new Map<string, string>();
  private readonly exempt: string;
  constructor(private readonly offset: RgbColor, private readonly mode: TerminalColorMode, exempt: string) {
    this.exempt = exempt.slice(2, -1);
  }
  /** SGR parameters of a background with this offset added, in the terminal's color mode. */
  background(color: RgbColor): string {
    const key = color.r + "," + color.g + "," + color.b;
    let moved = this.moved.get(key);
    if (moved === undefined) {
      if (this.moved.size >= MOVED_COLORS) this.moved.clear();
      const ansi = backgroundAnsi(rgbColor(clamp(color.r + this.offset.r), clamp(color.g + this.offset.g), clamp(color.b + this.offset.b)), this.mode);
      this.moved.set(key, moved = ansi.slice(2, -1));
    }
    return moved;
  }
  /** Whether a background's SGR parameters are the exempt one. */
  keeps(parameters: string): boolean {
    return parameters === this.exempt;
  }
}

/**
 * Read one SGR sequence: whether it leaves the default background active, and its parameters with each explicit
 * background moved by `shift`.
 */
function scan(parameters: string, shift: BackgroundShift | undefined): { reset: boolean; parameters: string } {
  if (parameters === "") return { reset: true, parameters };
  const parts = parameters.split(";");
  const out: string[] = [];
  let reset = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const code = Number(part.split(":")[0] || "0");
    if (code === 0 || code === 49) reset = true;
    else if (code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) reset = false;
    if (EXTENDED.has(part)) {
      const length = parts[index + 1] === "5" ? 2 : parts[index + 1] === "2" ? 4 : 0;
      const sequence = parts.slice(index, index + length + 1);
      index += length;
      if (part === "48" && shift) {
        const color = extendedColor(sequence.slice(1).map(Number));
        if (color && !shift.keeps(sequence.join(";"))) { out.push(shift.background(color)); continue; }
      }
      out.push(...sequence);
      continue;
    }
    if (code === 48 && shift && part.includes(":")) {
      // Colon form: 48:5:N, 48:2:R:G:B or 48:2:<color space>:R:G:B.
      const fields = part.split(":").slice(1).map(Number);
      const color = extendedColor(fields[0] === 2 && fields.length > 4 ? [2, ...fields.slice(-3)] : fields);
      if (color) { out.push(shift.background(color)); continue; }
    }
    out.push(part);
  }
  return { reset, parameters: shift ? out.join(";") : parameters };
}

/** The RGB value of an extended color's fields after 38/48 (`5;N` or `2;R;G;B`); none for the basic 16 colors. */
function extendedColor(fields: number[]): RgbColor | undefined {
  if (fields[0] === 5 && fields[1] >= 16 && fields[1] <= 255) return colorToRgb(indexedColor(fields[1]));
  if (fields[0] === 2 && fields.length >= 4 && fields.slice(1, 4).every(value => Number.isFinite(value))) {
    return { r: fields[1], g: fields[2], b: fields[3] };
  }
  return undefined;
}

/**
 * Give every cell with the default background a color, move every explicit background by `shift`, and put a prefix
 * before the row. Image rows keep their placement, and shell zone markers stay at the start of the row.
 */
export function decorateLine(line: string, background: string | undefined, prefix = "", shift?: BackgroundShift): string {
  if (line.includes("\x1b_G") || line.includes("\x1b]1337;")) return prefix + line;
  const zones = ZONES.exec(line)?.[0] ?? "";
  const body = zones ? line.slice(zones.length) : line;
  if (!background) return zones + prefix + body;
  return zones + prefix + background + body.replace(SGR, (sequence, parameters: string) => {
    const scanned = scan(parameters, shift);
    const rewritten = scanned.parameters === parameters ? sequence : "\x1b[" + scanned.parameters + "m";
    return scanned.reset ? rewritten + background : rewritten;
  });
}

const decorated = new WeakMap<readonly string[], {
  background?: string; prefix: string; shift?: BackgroundShift; source: string[]; lines: string[];
}>();

/**
 * Decorate rows, reusing the result while a renderer returns the same rows. Native renderers may mutate and return
 * the same array, so the cache compares the rows themselves, not only the array.
 */
export function decorateLines(lines: readonly string[], background: string | undefined, prefix = "", shift?: BackgroundShift): readonly string[] {
  if (!background && !prefix) return lines;
  const cached = decorated.get(lines);
  if (cached && cached.background === background && cached.prefix === prefix && cached.shift === shift && cached.source.length === lines.length &&
    cached.source.every((line, index) => line === lines[index])) return cached.lines;
  const result = lines.map(line => decorateLine(line, background, prefix, shift));
  decorated.set(lines, { background, prefix, shift, source: [...lines], lines: result });
  return result;
}

/**
 * Pi reports pointer motion without a pressed button only outside terminal multiplexers, where it enables all-motion
 * mouse tracking, and only while its mouse support is on. The terminal itself cannot be asked.
 */
export function pointerMotionAvailable(tui: TUI | undefined, env?: NodeJS.ProcessEnv): boolean {
  if (tui && Reflect.get(tui, "mouseEnabled") === false) return false;
  // Every frame asks; the environment Pi chose its mouse mode from does not change.
  if (env) return outsideMultiplexer(env);
  return processMotion ??= outsideMultiplexer(process.env);
}
let processMotion: boolean | undefined;
function outsideMultiplexer(env: NodeJS.ProcessEnv): boolean {
  const term = env.TERM?.toLowerCase() ?? "";
  return env.TMUX === undefined && env.ZELLIJ === undefined && env.STY === undefined &&
    !term.startsWith("tmux") && !term.startsWith("screen");
}
