import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences } from "../src/preferences.ts";

test("uses text buttons by default and persists the icon style", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "button-style-"));
  const file = path.join(directory, "transcript.json");
  try {
    expect((await loadPreferences(file)).buttonStyle).toBe("text");
    await writeFile(file, JSON.stringify({ side: "left", chatWidth: null }));
    expect((await loadPreferences(file)).buttonStyle).toBe("text");
    await savePreferences(file, { ...defaults, buttonStyle: "icons" });
    expect((await loadPreferences(file)).buttonStyle).toBe("icons");
    await writeFile(file, JSON.stringify({ ...defaults, buttonStyle: "invalid" }));
    await expect(loadPreferences(file)).rejects.toThrow("Invalid pi-stereo-view preferences");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
