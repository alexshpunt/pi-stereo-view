import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences } from "../src/preferences.ts";

test("groups and compacts tools by default for new installations and files without the settings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    expect(await loadPreferences(file)).toMatchObject({ groupTools: true, compactTools: true });
    await writeFile(file, JSON.stringify({ side: "right", chatWidth: 73, showTimestamps: false }));
    expect(await loadPreferences(file)).toMatchObject({ groupTools: true, compactTools: true, side: "right", chatWidth: 73, showTimestamps: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([["compactTools", true], ["compactTools", false], ["groupTools", true], ["groupTools", false]] as const)("persists %s set to %s across reloads", async (key, value) => {
  const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    await savePreferences(file, { ...defaults, [key]: value });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ [key]: value });
    expect(await loadPreferences(file)).toEqual({ ...defaults, [key]: value });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["compactTools", "groupTools"])("rejects invalid %s preferences", async key => {
  const directory = await mkdtemp(path.join(tmpdir(), "compact-tools-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    for (const value of ["on", null, 1]) {
      await writeFile(file, JSON.stringify({ ...defaults, [key]: value }));
      await expect(loadPreferences(file)).rejects.toThrow();
    }
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
    buttonStyle: "text", groupTools: true, compactTools: true, streamTools: true, streamDelay: 5,
  });
});
