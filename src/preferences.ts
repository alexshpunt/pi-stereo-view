import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Saved display settings only; they never become session messages. */
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
}

export const defaults: Preferences = {
  mode: "split", side: "left", chatWidth: null, layout: "columns", chatHeight: null, zoom: null, showTimestamps: true,
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
  if (!value || typeof value !== "object") throw new Error("Invalid transcript preferences");
  const record = value as Record<string, unknown>;
  // The first version only had columns; keep that saved arrangement.
  const layout = record.layout === undefined ? "columns" : record.layout;
  const chatHeight = record.chatHeight === undefined ? defaults.chatHeight : record.chatHeight;
  const zoom = record.zoom === undefined ? defaults.zoom : record.zoom;
  const showTimestamps = record.showTimestamps === undefined ? defaults.showTimestamps : record.showTimestamps;
  if ((record.mode !== "split" && record.mode !== "combined") ||
      (record.side !== "left" && record.side !== "right") ||
      (record.chatWidth !== null && (typeof record.chatWidth !== "number" || !Number.isInteger(record.chatWidth) ||
        record.chatWidth < 24 || record.chatWidth > 240)) ||
      (layout !== "columns" && layout !== "rows") ||
      (chatHeight !== null && (typeof chatHeight !== "number" || !Number.isInteger(chatHeight) || chatHeight < 4 || chatHeight > 240)) ||
      (zoom !== null && zoom !== "activity" && zoom !== "chat") || typeof showTimestamps !== "boolean") {
    throw new Error("Invalid transcript preferences");
  }
  return { mode: record.mode, side: record.side, chatWidth: record.chatWidth, layout, chatHeight, zoom, showTimestamps };
}

/** Atomically save only the display settings, never session messages. */
export async function savePreferences(file: string, preferences: Preferences): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(preferences, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
