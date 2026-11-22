import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, colorToOkhsl, foregroundAnsi, mixColors, okhslColor, rgbColor, type Color, type RgbColor, type TUI } from "@earendil-works/pi-tui";

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

/** Percent of the turn hue each layer adds on top of the layers below it. */
export interface TurnMix {
  clock: number;
  stripe: number;
  background: number;
  hover: number;
}

/** Default mixes, as the settings default to. */
export const DEFAULT_MIX: TurnMix = { clock: 10, stripe: 8, background: 5, hover: 5 };

const palettes = new WeakMap<Theme, { background?: RgbColor; mix: TurnMix; colors: Map<string, TurnColor[]> }>();

/** Common dark and light terminal backgrounds, for a terminal that does not report its own. */
const GUESSED_BACKGROUND = { dark: rgbColor(24, 24, 27), light: rgbColor(250, 250, 250) };

/**
 * The palette for a theme over the terminal's background. Layers are additive: a mark's color mixes the hue into the
 * terminal background by the sum of its own share and the shares of the layers under it, capped at the full hue, so
 * every layer stays visible over the ones below. Without a reported background, the theme's appearance picks a guess.
 */
export function turnColor(theme: Theme, turn: number, background?: RgbColor, mix: TurnMix = DEFAULT_MIX,
  layers: TurnLayers = NO_LAYERS): TurnColor | undefined {
  if (turn <= 0) return undefined;
  let palette = palettes.get(theme);
  if (!palette || palette.background !== background || palette.mix.clock !== mix.clock || palette.mix.stripe !== mix.stripe ||
    palette.mix.background !== mix.background || palette.mix.hover !== mix.hover) {
    palette = { background, mix: { ...mix }, colors: new Map() };
    palettes.set(theme, palette);
  }
  const key = (layers.background ? "b" : "") + (layers.hover ? "h" : "");
  let colors = palette.colors.get(key);
  if (!colors) {
    const appearance = Reflect.get(theme, "appearance") === "light" ? "light" : "dark";
    const base: Color = background ? rgbColor(background.r, background.g, background.b) : GUESSED_BACKGROUND[appearance];
    const dark = colorToOkhsl(base).l < 0.5;
    const mode = theme.getColorMode();
    const share = (percent: number): number => Math.min(100, Math.max(0, percent)) / 100;
    const under = (layers.background ? mix.background : 0) + (layers.hover ? mix.hover : 0);
    colors = [];
    for (let index = 0; index < HUES; index++) {
      const hue = okhslColor((index * 360) / HUES + 15, 0.85, dark ? 0.62 : 0.55);
      const stripe = mixColors(base, hue, share(under + mix.stripe), "srgb");
      colors.push({
        clock: mixColors(base, hue, share(under + mix.clock), "srgb"),
        fill: under > 0 ? backgroundAnsi(mixColors(base, hue, share(under), "srgb"), mode) : undefined,
        stripe: backgroundAnsi(stripe, mode),
        line: foregroundAnsi(stripe, mode),
      });
    }
    palette.colors.set(key, colors);
  }
  return colors[((turn - 1) * STRIDE) % HUES];
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
