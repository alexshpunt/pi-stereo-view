import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface Preferences {
  mode: "split" | "combined";
  side: "left" | "right";
  chatWidth: number;
}

export const defaults: Preferences = { mode: "split", side: "right", chatWidth: 40 };

/** Read display preferences without letting invalid values reach the layout. */
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
  if ((record.mode !== "split" && record.mode !== "combined") ||
      (record.side !== "left" && record.side !== "right") ||
      typeof record.chatWidth !== "number" || !Number.isInteger(record.chatWidth) ||
      record.chatWidth < 24 || record.chatWidth > 240) {
    throw new Error("Invalid transcript preferences");
  }
  return { mode: record.mode, side: record.side, chatWidth: record.chatWidth };
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
