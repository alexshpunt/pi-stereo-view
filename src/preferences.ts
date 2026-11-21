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
   * Act marks: every block of an act, a user or custom message and the work that follows it, gets the same color in
   * both panels. Each mark is chosen independently.
   */
  /** Color the background of each block's clock. */
  actClock: boolean;
  /** A one-column colored cell or line on the left of every block. */
  actStripe: ActStripe;
  /** Tint the default background of every block. */
  actBackground: boolean;
  /** A colored rule above the first block of each act. */
  actSeparator: boolean;
  /** Highlight the act under the pointer in both panels, where the terminal reports pointer motion. */
  actHover: boolean;
  /** How a block opens the same point of history in the other panel. */
  goTo: GoTo;
}

export type ActStripe = "off" | "block" | "line";
export type GoTo = "clock" | "button" | "both" | "off";
export const ACT_STRIPES: readonly ActStripe[] = ["off", "block", "line"];
export const GO_TO: readonly GoTo[] = ["clock", "button", "both", "off"];

export const defaults: Preferences = {
  mode: "split", side: "left", chatWidth: null, layout: "columns", chatHeight: null, zoom: null, showTimestamps: true, showCopyButtons: true, compactTools: true, groupTools: true, nestedTree: true, streamTools: true, streamDelay: 5, buttonStyle: "text",
  actClock: true, actStripe: "block", actBackground: false, actSeparator: false, actHover: true, goTo: "clock",
};

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
  const compactTools = record.compactTools === undefined ? defaults.compactTools : record.compactTools;
  // Grouping used to be part of Compact; files saved before the split keep that combination.
  const groupTools = record.groupTools === undefined ? compactTools : record.groupTools;
  const nestedTree = record.nestedTree === undefined ? defaults.nestedTree : record.nestedTree;
  const streamTools = record.streamTools === undefined ? defaults.streamTools : record.streamTools;
  const streamDelay = record.streamDelay === undefined ? defaults.streamDelay : record.streamDelay;
  const buttonStyle = record.buttonStyle === undefined ? defaults.buttonStyle : record.buttonStyle;
  const actClock = record.actClock === undefined ? defaults.actClock : record.actClock;
  const actStripe = record.actStripe === undefined ? defaults.actStripe : record.actStripe;
  const actBackground = record.actBackground === undefined ? defaults.actBackground : record.actBackground;
  const actSeparator = record.actSeparator === undefined ? defaults.actSeparator : record.actSeparator;
  const actHover = record.actHover === undefined ? defaults.actHover : record.actHover;
  const goTo = record.goTo === undefined ? defaults.goTo : record.goTo;
  if ((record.side !== "left" && record.side !== "right") ||
      (record.chatWidth !== null && (typeof record.chatWidth !== "number" || !Number.isInteger(record.chatWidth) ||
        record.chatWidth < 24 || record.chatWidth > 240)) ||
      (layout !== "columns" && layout !== "rows") ||
      (chatHeight !== null && (typeof chatHeight !== "number" || !Number.isInteger(chatHeight) || chatHeight < 4 || chatHeight > 240)) ||
      typeof showTimestamps !== "boolean" || typeof showCopyButtons !== "boolean" || typeof compactTools !== "boolean" ||
      typeof groupTools !== "boolean" || typeof nestedTree !== "boolean" ||
      typeof streamTools !== "boolean" || typeof streamDelay !== "number" || !Number.isInteger(streamDelay) || streamDelay < 1 || streamDelay > 300 ||
      (buttonStyle !== "icons" && buttonStyle !== "text") || typeof actClock !== "boolean" || !ACT_STRIPES.includes(actStripe as ActStripe) ||
      typeof actBackground !== "boolean" || typeof actSeparator !== "boolean" ||
      typeof actHover !== "boolean" || !GO_TO.includes(goTo as GoTo)) {
    throw new Error("Invalid pi-stereo-view preferences");
  }
  // Legacy files may contain mode/zoom. Every session starts with both panels visible.
  return { mode: "split", side: record.side, chatWidth: record.chatWidth, layout, chatHeight, zoom: null, showTimestamps, showCopyButtons, compactTools, groupTools, nestedTree, streamTools, streamDelay, buttonStyle,
    actClock, actStripe: actStripe as ActStripe, actBackground, actSeparator, actHover, goTo: goTo as GoTo };
}

/** Atomically save only the display settings, never session messages. */
export async function savePreferences(file: string, preferences: Preferences): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const { side, chatWidth, layout, chatHeight, showTimestamps, showCopyButtons, compactTools, groupTools, nestedTree, streamTools, streamDelay, buttonStyle,
      actClock, actStripe, actBackground, actSeparator, actHover, goTo } = preferences;
    const saved = { side, chatWidth, layout, chatHeight, showTimestamps, showCopyButtons, compactTools, groupTools, nestedTree, streamTools, streamDelay, buttonStyle,
      actClock, actStripe, actBackground, actSeparator, actHover, goTo };
    await writeFile(temporary, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
