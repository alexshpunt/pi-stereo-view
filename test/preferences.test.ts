import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences, type Preferences } from "../src/preferences.ts";

const arrangement = {
  side: "right", chatWidth: 73, layout: "rows", chatHeight: 17,
  showTimestamps: false, showCopyButtons: false, compactTools: true, groupTools: false, nestedTree: false, streamTools: true, streamDelay: 8, buttonStyle: "icons",
  turns: true, turnClock: false, turnStripe: "line", turnBackground: true, turnSeparator: true, turnClockMix: 20, turnStripeMix: 50,
  turnBackgroundMix: 3, turnHoverMix: 40, turnHoverColor: "#3b82f6", turnHover: false, goTo: "button",
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

test("files saved before turn settings get the default turn marks, on", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    const { turns: _turns, turnClock: _clock, turnStripe: _stripe, turnBackground: _background, turnSeparator: _separator, turnClockMix: _clockMix,
      turnStripeMix: _stripeMix, turnBackgroundMix: _backgroundMix, turnHoverMix: _hoverMix, turnHoverColor: _hoverColor, turnHover: _hover, goTo: _goTo, ...older } = arrangement;
    await writeFile(file, JSON.stringify(older));
    expect(await loadPreferences(file)).toMatchObject({
      turns: true, turnClock: true, turnStripe: "block", turnBackground: false, turnSeparator: true, turnClockMix: 10, turnStripeMix: 20,
      turnBackgroundMix: 8, turnHoverMix: 10, turnHoverColor: "#808080", turnHover: true, goTo: "both",
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([{ turns: "on" }, { turnHoverMix: 200 }, { turnHoverColor: "blue" }, { turnHoverColor: "#12345" }, { turnClock: "yes" }, { turnStripe: "rainbow" }, { turnBackground: 1 }, { turnSeparator: "on" }, { turnClockMix: 0 }, { turnStripeMix: 101 }, { turnBackgroundMix: 2.5 }, { turnHover: "yes" }, { goTo: "elsewhere" }])("rejects an invalid turn setting %o", async invalid => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    await writeFile(file, JSON.stringify({ ...arrangement, ...invalid }));
    await expect(loadPreferences(file)).rejects.toThrow("Invalid pi-stereo-view preferences");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
