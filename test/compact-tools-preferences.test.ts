import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences } from "../src/preferences.ts";

test("compacts tools by default for new installations and files without the setting", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    expect(await loadPreferences(file)).toMatchObject({ compactTools: true });
    await writeFile(file, JSON.stringify({ side: "right", chatWidth: 73, showTimestamps: false }));
    expect(await loadPreferences(file)).toMatchObject({ compactTools: true, side: "right", chatWidth: 73, showTimestamps: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([true, false])("persists compact tools set to %s across reloads", async compactTools => {
  const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    await savePreferences(file, { ...defaults, compactTools });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ compactTools });
    expect(await loadPreferences(file)).toEqual({ ...defaults, compactTools });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["on", null, 1])("rejects invalid compact tool preference %s", async compactTools => {
  const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    await writeFile(file, JSON.stringify({ ...defaults, compactTools }));
    await expect(loadPreferences(file)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("streams latest tools after five seconds by default", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    expect(await loadPreferences(file)).toMatchObject({ streamTools: true, streamDelay: 5 });
    await writeFile(file, JSON.stringify({ side: "right", chatWidth: 73, compactTools: true }));
    expect(await loadPreferences(file)).toMatchObject({ streamTools: true, streamDelay: 5 });
    await savePreferences(file, { ...defaults, streamTools: false, streamDelay: 10 });
    expect(await loadPreferences(file)).toEqual({ ...defaults, streamTools: false, streamDelay: 10 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([["streamTools", "on"], ["streamTools", 1], ["streamDelay", 0], ["streamDelay", 1.5], ["streamDelay", 301], ["streamDelay", "5"]])(
  "rejects invalid %s preference %s", async (key, value) => {
    const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
    const file = path.join(directory, "transcript.json");
    try {
      await writeFile(file, JSON.stringify({ ...defaults, [key]: value }));
      await expect(loadPreferences(file)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test("ships the compact side-by-side defaults", () => {
  expect(defaults).toMatchObject({
    layout: "columns", side: "left", chatWidth: null, chatHeight: null, showTimestamps: true, showCopyButtons: true,
    buttonStyle: "text", compactTools: true, streamTools: true, streamDelay: 5,
  });
});
