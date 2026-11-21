import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, colorToOkhsl, mixColors, okhslColor, rgbColor, type Color, type RgbColor, type TUI } from "@earendil-works/pi-tui";

/** Hues of the act palette; consecutive acts step by a stride coprime with it, so neighbours differ strongly. */
const HUES = 16;
const STRIDE = 7;

/** Colors of one act for each presentation; `undefined` for blocks before the first act. */
export interface ActColor {
  /** Background of the block's clock in `clock` mode. */
  clock: Color;
  /** Background of default cells in `fill` mode. */
  fill: string;
  /** Background of default cells while the act is under the pointer. */
  hover: string;
  /** The one-cell stripe on the left in `stripe` mode. */
  stripe: string;
}

const palettes = new WeakMap<Theme, { background?: RgbColor; colors: ActColor[] }>();

/** Common dark and light terminal backgrounds, for a terminal that does not report its own. */
const GUESSED_BACKGROUND = { dark: rgbColor(24, 24, 27), light: rgbColor(250, 250, 250) };

/** Share of the hue in each background: a faint shift from the terminal background, never a solid block. */
const MIX = { clock: 0.05, fill: 0.05, hover: 0.05 };

/**
 * The palette for a theme over the terminal's background. Each color mixes a hue into that background, so it stays a
 * light tint on dark and light terminals alike. Without a reported background, the theme's appearance picks a guess.
 */
export function actColor(theme: Theme, act: number, background?: RgbColor): ActColor | undefined {
  if (act <= 0) return undefined;
  let palette = palettes.get(theme);
  if (!palette || palette.background !== background) {
    const appearance = Reflect.get(theme, "appearance") === "light" ? "light" : "dark";
    const base: Color = background ? rgbColor(background.r, background.g, background.b) : GUESSED_BACKGROUND[appearance];
    const dark = colorToOkhsl(base).l < 0.5;
    const mode = theme.getColorMode();
    const colors: ActColor[] = [];
    for (let index = 0; index < HUES; index++) {
      const hue = okhslColor((index * 360) / HUES + 15, 0.85, dark ? 0.62 : 0.55);
      colors.push({
        clock: mixColors(base, hue, MIX.clock, "srgb"),
        fill: backgroundAnsi(mixColors(base, hue, MIX.fill, "srgb"), mode),
        hover: backgroundAnsi(mixColors(base, hue, MIX.hover, "srgb"), mode),
        stripe: backgroundAnsi(hue, mode),
      });
    }
    palette = { background, colors };
    palettes.set(theme, palette);
  }
  return palette.colors[((act - 1) * STRIDE) % HUES];
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
