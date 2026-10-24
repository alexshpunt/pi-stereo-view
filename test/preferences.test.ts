import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences, type Preferences } from "../src/preferences.js";

const arrangement = {
  side: "right", chatWidth: 73, layout: "rows", chatHeight: 17,
  showTimestamps: false, showCopyButtons: false,
} as const;

test.each(["chat", "activity", null] as const)("ignores legacy combined mode and %s zoom without losing the saved arrangement", async zoom => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    await writeFile(file, JSON.stringify({ ...arrangement, mode: "combined", zoom }));
    expect(await loadPreferences(file)).toEqual({ ...arrangement, mode: "split", zoom: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["columns", "rows"] as const)("saves the %s arrangement without temporary mode or zoom", async layout => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    const state: Preferences = { ...arrangement, layout, mode: "combined", zoom: "activity" };
    await savePreferences(file, state);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...arrangement, layout });
    expect(state).toEqual({ ...arrangement, layout, mode: "combined", zoom: "activity" });
    expect(await loadPreferences(file)).toEqual({ ...arrangement, layout, mode: "split", zoom: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retains automatic sizes and accepts settings with no temporary-state keys", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    const { mode: _mode, zoom: _zoom, ...saved } = defaults;
    await writeFile(file, JSON.stringify(saved));
    expect(await loadPreferences(file)).toEqual(defaults);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
