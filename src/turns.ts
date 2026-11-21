import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, colorToOkhsl, foregroundAnsi, mixColors, okhslColor, rgbColor, type Color, type RgbColor, type TUI } from "@earendil-works/pi-tui";

/** Hues of the turn palette; consecutive turns step by a stride coprime with it, so neighbours differ strongly. */
const HUES = 16;
const STRIDE = 7;

/** Colors of one turn for each mark; `undefined` for blocks before the first turn. */
export interface TurnColor {
  /** Background of the block's clock. */
  clock: Color;
  /** Background of default cells when turn backgrounds are on. */
  fill: string;
  /** Background of default cells while the turn is under the pointer and turn backgrounds are on. */
  hover: string;
  /** Background of the one-cell block stripe on the left. */
  stripe: string;
  /** Foreground of the line stripe and the separator rule. */
  line: string;
}

/** Percent of the turn hue mixed into the terminal background for each mark. */
export interface TurnMix {
  clock: number;
  stripe: number;
  background: number;
}

/** Default mixes: faint clocks and backgrounds, full-strength stripes and lines. */
export const DEFAULT_MIX: TurnMix = { clock: 10, stripe: 100, background: 5 };

const palettes = new WeakMap<Theme, { background?: RgbColor; mix: TurnMix; colors: TurnColor[] }>();

/** Common dark and light terminal backgrounds, for a terminal that does not report its own. */
const GUESSED_BACKGROUND = { dark: rgbColor(24, 24, 27), light: rgbColor(250, 250, 250) };

/**
 * The palette for a theme over the terminal's background. Each color mixes a hue into that background by the mark's
 * percentage, so it stays a tint on dark and light terminals alike. Without a reported background, the theme's
 * appearance picks a guess. `hover` doubles the background mix, to stand out over turn backgrounds.
 */
export function turnColor(theme: Theme, turn: number, background?: RgbColor, mix: TurnMix = DEFAULT_MIX): TurnColor | undefined {
  if (turn <= 0) return undefined;
  let palette = palettes.get(theme);
  if (!palette || palette.background !== background || palette.mix.clock !== mix.clock || palette.mix.stripe !== mix.stripe ||
    palette.mix.background !== mix.background) {
    const appearance = Reflect.get(theme, "appearance") === "light" ? "light" : "dark";
    const base: Color = background ? rgbColor(background.r, background.g, background.b) : GUESSED_BACKGROUND[appearance];
    const dark = colorToOkhsl(base).l < 0.5;
    const mode = theme.getColorMode();
    const share = (percent: number): number => Math.min(100, Math.max(0, percent)) / 100;
    const colors: TurnColor[] = [];
    for (let index = 0; index < HUES; index++) {
      const hue = okhslColor((index * 360) / HUES + 15, 0.85, dark ? 0.62 : 0.55);
      const stripe = mixColors(base, hue, share(mix.stripe), "srgb");
      colors.push({
        clock: mixColors(base, hue, share(mix.clock), "srgb"),
        fill: backgroundAnsi(mixColors(base, hue, share(mix.background), "srgb"), mode),
        hover: backgroundAnsi(mixColors(base, hue, share(mix.background * 2), "srgb"), mode),
        stripe: backgroundAnsi(stripe, mode),
        line: foregroundAnsi(stripe, mode),
      });
    }
    palette = { background, mix: { ...mix }, colors };
    palettes.set(theme, palette);
  }
  return palette.colors[((turn - 1) * STRIDE) % HUES];
}

/** SGR parameters that take arguments: extended foreground, background and underline colors. */
const EXTENDED = new Set(["38", "48", "58"]);
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;:]*)m/g;
// eslint-disable-next-line no-control-regex
const ZONES = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/** Whether a sequence leaves the default background active. */
function resetsBackground(parameters: string): boolean {
  if (parameters === "") return true;
  const parts = parameters.split(";");
  let reset = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const code = Number(part.split(":")[0] || "0");
    if (code === 0 || code === 49) reset = true;
    else if (code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) reset = false;
    if (EXTENDED.has(part)) index += parts[index + 1] === "5" ? 2 : parts[index + 1] === "2" ? 4 : 0;
  }
  return reset;
}

/**
 * Give every cell with the default background a color and put a prefix before the row. Native backgrounds stay as
 * they are; image rows keep their placement, and shell zone markers stay at the start of the row.
 */
export function decorateLine(line: string, background: string | undefined, prefix = ""): string {
  if (line.includes("\x1b_G") || line.includes("\x1b]1337;")) return prefix + line;
  const zones = ZONES.exec(line)?.[0] ?? "";
  const body = zones ? line.slice(zones.length) : line;
  if (!background) return zones + prefix + body;
  return zones + prefix + background + body.replace(SGR, (sequence, parameters: string) =>
    resetsBackground(parameters) ? sequence + background : sequence);
}

const decorated = new WeakMap<readonly string[], { background?: string; prefix: string; source: string[]; lines: string[] }>();

/**
 * Decorate rows, reusing the result while a renderer returns the same rows. Native renderers may mutate and return
 * the same array, so the cache compares the rows themselves, not only the array.
 */
export function decorateLines(lines: readonly string[], background: string | undefined, prefix = ""): readonly string[] {
  if (!background && !prefix) return lines;
  const cached = decorated.get(lines);
  if (cached && cached.background === background && cached.prefix === prefix && cached.source.length === lines.length &&
    cached.source.every((line, index) => line === lines[index])) return cached.lines;
  const result = lines.map(line => decorateLine(line, background, prefix));
  decorated.set(lines, { background, prefix, source: [...lines], lines: result });
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
