import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences } from "../src/preferences.js";

test("keeps copy icons on for old settings and persists the off choice", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copy-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    expect(await loadPreferences(file)).toMatchObject({ showCopyButtons: true });
    await writeFile(file, JSON.stringify({ mode: "split", side: "left", chatWidth: null, showTimestamps: false }));
    expect(await loadPreferences(file)).toMatchObject({ showCopyButtons: true, showTimestamps: false });
    await savePreferences(file, { ...defaults, showCopyButtons: false });
    expect(await loadPreferences(file)).toEqual({ ...defaults, showCopyButtons: false });
    await writeFile(file, JSON.stringify({ ...defaults, showCopyButtons: "off" }));
    await expect(loadPreferences(file)).rejects.toThrow("Invalid pi-stereo-view preferences");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
