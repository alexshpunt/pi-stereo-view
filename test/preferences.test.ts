import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences, type Preferences } from "../src/preferences.ts";

const arrangement = {
  side: "right", chatWidth: 73, layout: "rows", chatHeight: 17,
  showTimestamps: false, showCopyButtons: false, compactTools: true, groupTools: false, nestedTree: false, streamTools: true, streamDelay: 8, buttonStyle: "icons",
  actClock: false, actStripe: "line", actBackground: true, actSeparator: true, actClockMix: 20, actStripeMix: 50, actBackgroundMix: 3,
  actHover: false, goTo: "both",
} as const;

test.each(["chat", "activity", null] as const)("ignores legacy temporary state with %s zoom without losing the saved arrangement", async zoom => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    for (const mode of ["split", "combined"]) {
      await writeFile(file, JSON.stringify({ ...arrangement, mode, zoom }));
      expect(await loadPreferences(file)).toEqual({ ...arrangement, mode: "split", zoom: null });
    }
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

test("files saved before act settings get clock colors, a block stripe, hover and clock Go to", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    const { actClock: _clock, actStripe: _stripe, actBackground: _background, actSeparator: _separator, actClockMix: _clockMix,
      actStripeMix: _stripeMix, actBackgroundMix: _backgroundMix, actHover: _hover, goTo: _goTo, ...older } = arrangement;
    await writeFile(file, JSON.stringify(older));
    expect(await loadPreferences(file)).toMatchObject({
      actClock: true, actStripe: "block", actBackground: false, actSeparator: false, actClockMix: 10, actStripeMix: 100, actBackgroundMix: 5,
      actHover: true, goTo: "clock",
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([{ actClock: "yes" }, { actStripe: "rainbow" }, { actBackground: 1 }, { actSeparator: "on" }, { actClockMix: 0 }, { actStripeMix: 101 }, { actBackgroundMix: 2.5 }, { actHover: "yes" }, { goTo: "elsewhere" }])("rejects an invalid act setting %o", async invalid => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    await writeFile(file, JSON.stringify({ ...arrangement, ...invalid }));
    await expect(loadPreferences(file)).rejects.toThrow("Invalid pi-stereo-view preferences");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
