import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Display state; mode and zoom are session-only, while arrangement and display choices are saved. */
export interface Preferences {
  mode: "split" | "combined";
  /** Left means first: left in columns, top in rows. */
  side: "left" | "right";
  /** Null reserves 20% of the column layout; a number is a manual width. */
  chatWidth: number | null;
  layout: "columns" | "rows";
  /** Null grows to half the history area; a number is a manual maximum. */
  chatHeight: number | null;
  zoom: "activity" | "chat" | null;
  showTimestamps: boolean;
  showCopyButtons: boolean;
  /** Annotate individual finished tools with their recorded execution duration. */
  showToolDurations: boolean;
  /** Annotate model responses and tool calls with the usage Pi recorded. */
  showModelUsage: boolean;
  /** Show each finished Activity call as a one-line row that opens its full card. */
  compactTools: boolean;
  /** Merge adjacent Activity calls of one tool in one state under a counted header. */
  groupTools: boolean;
  /** Show the calls a tool made, such as Codemode's, as a tree instead of the parent's native output panel. */
  nestedTree: boolean;
  /** Show the latest tool calls in full while Compact or Group would hide them, then collapse them. */
  streamTools: boolean;
  /** Seconds a finished streamed call stays in full before it collapses. */
  streamDelay: number;
  buttonStyle: "icons" | "text";
  /*
   * Turn marks: every block of a turn, a user or custom message and the work that follows it, gets the same color in
   * both panels. Each mark is chosen independently and applies only while `turns` is on.
   */
  /** Turn colors, hover highlighting and Go to as a whole; the settings below keep their values while it is off. */
  turns: boolean;
  /** Color the background of each block's clock. */
  turnClock: boolean;
  /** A one-column colored cell or line on the left of every block. */
  turnStripe: TurnStripe;
  /** Tint the default background of every block. */
  turnBackground: boolean;
  /** A colored rule above the first block of each turn. */
  turnSeparator: boolean;
  /** Percent of the turn hue mixed into the terminal background behind clocks, in stripes and lines, in blocks and under the pointer. */
  turnClockMix: number;
  turnStripeMix: number;
  turnBackgroundMix: number;
  turnHoverMix: number;
  /** The hover layer's color: `turn` for each turn's own hue, or one `#rrggbb` color for every turn. */
  turnHoverColor: string;
  /** Highlight the turn under the pointer in both panels, where the terminal reports pointer motion. */
  turnHover: boolean;
  /** How a block opens the same point of history in the other panel. */
  goTo: GoTo;
  /** How Pi's own windows, such as the session tree, open while the panels are side by side. */
  piWindows: PiWindows;
}

export type TurnStripe = "off" | "block" | "line";
/** Settings that change how turns are marked; each applies at once without other effects. */
export type TurnMarkSetting = "turns" | "turnClock" | "turnStripe" | "turnBackground" | "turnSeparator" | "turnClockMix" | "turnStripeMix" |
  "turnBackgroundMix" | "turnHoverMix" | "turnHoverColor";
export type GoTo = "clock" | "button" | "both" | "off";
export const TURN_STRIPES: readonly TurnStripe[] = ["off", "block", "line"];
export const GO_TO: readonly GoTo[] = ["clock", "button", "both", "off"];
/**
 * `combined` shows Pi's single history with the window at full width, `maximize` gives Activity the whole screen,
 * `inline` keeps the window under Activity like extension dialogs.
 */
export type PiWindows = "combined" | "maximize" | "inline";
export const PI_WINDOWS: readonly PiWindows[] = ["combined", "maximize", "inline"];

export const defaults: Preferences = {
  mode: "split", side: "left", chatWidth: null, layout: "columns", chatHeight: null, zoom: null,
  showTimestamps: true, showCopyButtons: true, showToolDurations: false, showModelUsage: false,
  compactTools: true, groupTools: true, nestedTree: true, streamTools: true, streamDelay: 5, buttonStyle: "text",
  // Strengths chosen on dark and light terminals; one gray hover reads as "this turn" without competing with turn hues.
  turns: true, turnClock: true, turnStripe: "block", turnBackground: false, turnSeparator: true,
  turnClockMix: 10, turnStripeMix: 20, turnBackgroundMix: 8, turnHoverMix: 10, turnHoverColor: "#808080", turnHover: true, goTo: "both", piWindows: "combined",
};

/** One-color hover choices offered in settings besides each turn's own hue; any `#rrggbb` can be typed in. */
export const HOVER_COLORS: readonly string[] = ["#808080", "#3b82f6", "#14b8a6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7"];
const validHoverColor = (value: unknown): value is string => value === "turn" || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));

/** Mix choices offered in settings, in percent; saved files may hold any whole percent from 1 to 100. */
export const TURN_MIXES: readonly number[] = [2, 5, 8, 10, 15, 20, 30, 50, 75, 100];
const validMix = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100;

/** Read display preferences, retaining the first version's saved arrangement. */
export async function loadPreferences(file: string): Promise<Preferences> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
  if (!value || typeof value !== "object") throw new Error("Invalid pi-stereo-view preferences");
  const record = value as Record<string, unknown>;
  // The first version only had columns; keep that saved arrangement.
  const layout = record.layout === undefined ? "columns" : record.layout;
  const chatHeight = record.chatHeight === undefined ? defaults.chatHeight : record.chatHeight;
  const showTimestamps = record.showTimestamps === undefined ? defaults.showTimestamps : record.showTimestamps;
  const showCopyButtons = record.showCopyButtons === undefined ? defaults.showCopyButtons : record.showCopyButtons;
  const showToolDurations = record.showToolDurations === undefined ? defaults.showToolDurations : record.showToolDurations;
  const showModelUsage = record.showModelUsage === undefined ? defaults.showModelUsage : record.showModelUsage;
  const compactTools = record.compactTools === undefined ? defaults.compactTools : record.compactTools;
  // Grouping used to be part of Compact; files saved before the split keep that combination.
  const groupTools = record.groupTools === undefined ? compactTools : record.groupTools;
  const nestedTree = record.nestedTree === undefined ? defaults.nestedTree : record.nestedTree;
  const streamTools = record.streamTools === undefined ? defaults.streamTools : record.streamTools;
  const streamDelay = record.streamDelay === undefined ? defaults.streamDelay : record.streamDelay;
  const buttonStyle = record.buttonStyle === undefined ? defaults.buttonStyle : record.buttonStyle;
  const turns = record.turns === undefined ? defaults.turns : record.turns;
  const turnClock = record.turnClock === undefined ? defaults.turnClock : record.turnClock;
  const turnStripe = record.turnStripe === undefined ? defaults.turnStripe : record.turnStripe;
  const turnBackground = record.turnBackground === undefined ? defaults.turnBackground : record.turnBackground;
  const turnSeparator = record.turnSeparator === undefined ? defaults.turnSeparator : record.turnSeparator;
  const turnClockMix = record.turnClockMix === undefined ? defaults.turnClockMix : record.turnClockMix;
  const turnStripeMix = record.turnStripeMix === undefined ? defaults.turnStripeMix : record.turnStripeMix;
  const turnBackgroundMix = record.turnBackgroundMix === undefined ? defaults.turnBackgroundMix : record.turnBackgroundMix;
  const turnHoverMix = record.turnHoverMix === undefined ? defaults.turnHoverMix : record.turnHoverMix;
  const turnHoverColor = record.turnHoverColor === undefined ? defaults.turnHoverColor : record.turnHoverColor;
  const turnHover = record.turnHover === undefined ? defaults.turnHover : record.turnHover;
  const goTo = record.goTo === undefined ? defaults.goTo : record.goTo;
  const piWindows = record.piWindows === undefined ? defaults.piWindows : record.piWindows;
  if ((record.side !== "left" && record.side !== "right") ||
      (record.chatWidth !== null && (typeof record.chatWidth !== "number" || !Number.isInteger(record.chatWidth) ||
        record.chatWidth < 24 || record.chatWidth > 240)) ||
      (layout !== "columns" && layout !== "rows") ||
      (chatHeight !== null && (typeof chatHeight !== "number" || !Number.isInteger(chatHeight) || chatHeight < 4 || chatHeight > 240)) ||
      typeof showTimestamps !== "boolean" || typeof showCopyButtons !== "boolean" || typeof compactTools !== "boolean" ||
      typeof showToolDurations !== "boolean" || typeof showModelUsage !== "boolean" ||
      typeof groupTools !== "boolean" || typeof nestedTree !== "boolean" ||
      typeof streamTools !== "boolean" || typeof streamDelay !== "number" || !Number.isInteger(streamDelay) || streamDelay < 1 || streamDelay > 300 ||
      (buttonStyle !== "icons" && buttonStyle !== "text") || typeof turns !== "boolean" || typeof turnClock !== "boolean" ||
      !TURN_STRIPES.includes(turnStripe as TurnStripe) || typeof turnBackground !== "boolean" || typeof turnSeparator !== "boolean" ||
      !validMix(turnClockMix) || !validMix(turnStripeMix) || !validMix(turnBackgroundMix) || !validMix(turnHoverMix) || !validHoverColor(turnHoverColor) ||
      typeof turnHover !== "boolean" || !GO_TO.includes(goTo as GoTo) || !PI_WINDOWS.includes(piWindows as PiWindows)) {
    throw new Error("Invalid pi-stereo-view preferences");
  }
  // Legacy files may contain mode/zoom. Every session starts with both panels visible.
  return { mode: "split", side: record.side, chatWidth: record.chatWidth, layout, chatHeight, zoom: null, showTimestamps, showCopyButtons, showToolDurations, showModelUsage, compactTools, groupTools, nestedTree, streamTools, streamDelay, buttonStyle,
    turns, turnClock, turnStripe: turnStripe as TurnStripe, turnBackground, turnSeparator, turnClockMix, turnStripeMix, turnBackgroundMix, turnHoverMix,
    turnHoverColor: turnHoverColor.toLowerCase(), turnHover, goTo: goTo as GoTo, piWindows: piWindows as PiWindows };
}

/** Atomically save only the display settings, never session messages. */
export async function savePreferences(file: string, preferences: Preferences): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const { side, chatWidth, layout, chatHeight, showTimestamps, showCopyButtons, showToolDurations, showModelUsage, compactTools, groupTools, nestedTree, streamTools, streamDelay, buttonStyle,
      turns, turnClock, turnStripe, turnBackground, turnSeparator, turnClockMix, turnStripeMix, turnBackgroundMix, turnHoverMix, turnHoverColor, turnHover, goTo, piWindows } = preferences;
    const saved = { side, chatWidth, layout, chatHeight, showTimestamps, showCopyButtons, showToolDurations, showModelUsage, compactTools, groupTools, nestedTree, streamTools, streamDelay, buttonStyle,
      turns, turnClock, turnStripe, turnBackground, turnSeparator, turnClockMix, turnStripeMix, turnBackgroundMix, turnHoverMix, turnHoverColor, turnHover, goTo, piWindows };
    await writeFile(temporary, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
