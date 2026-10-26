import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences } from "../src/preferences.js";

test("keeps tools in normal view for new and existing installations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    expect(await loadPreferences(file)).toMatchObject({ compactTools: false });
    await writeFile(file, JSON.stringify({ side: "right", chatWidth: 73, showTimestamps: false }));
    expect(await loadPreferences(file)).toMatchObject({ compactTools: false, side: "right", chatWidth: 73, showTimestamps: false });
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
