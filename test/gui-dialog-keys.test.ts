import { expect, test } from "vitest";
import { matchesKey } from "@earendil-works/pi-tui";
// @ts-expect-error The Herdr mod is plain JavaScript.
import { dialogKey } from "../herdr/mods/stereo-view/dialog-keys.js";

test("translates navigation and editing keys for Pi dialogs", () => {
  expect(dialogKey({ key: "enter" })).toBe("\r");
  expect(dialogKey({ key: "escape" })).toBe("\x1b");
  expect(dialogKey({ key: "down" })).toBe("\x1b[B");
  expect(dialogKey({ key: "up", modifiers: { shift: true } })).toBe("\x1b[1;2A");
  expect(dialogKey({ key: "tab", modifiers: { shift: true } })).toBe("\x1b[Z");
  expect(dialogKey({ key: "c", modifiers: { control: true } })).toBe("\x03");
});

test("preserves modifiers on Enter, Backspace and Delete for Pi components", () => {
  const cases = [
    { key: "enter", modifiers: { shift: true }, expected: "shift+enter", plain: "enter" },
    { key: "return", modifiers: { control: true }, expected: "ctrl+enter", plain: "enter" },
    { key: "enter", modifiers: { platform: true }, expected: "super+enter", plain: "enter" },
    { key: "enter", modifiers: { alt: true, shift: true }, expected: "alt+shift+enter", plain: "enter" },
    { key: "backspace", modifiers: { control: true }, expected: "ctrl+backspace", plain: "backspace" },
    { key: "backspace", modifiers: { shift: true }, expected: "shift+backspace", plain: "backspace" },
    { key: "backspace", modifiers: { alt: true, shift: true }, expected: "alt+shift+backspace", plain: "backspace" },
    { key: "delete", modifiers: { shift: true }, expected: "shift+delete", plain: "delete" },
    { key: "delete", modifiers: { control: true, alt: true }, expected: "ctrl+alt+delete", plain: "delete" },
  ] as const;
  for (const { key, modifiers, expected, plain } of cases) {
    const data = dialogKey({ key, modifiers });
    expect(data).toBeDefined();
    expect(matchesKey(data!, expected)).toBe(true);
    expect(matchesKey(data!, plain)).toBe(false);
  }
  expect(dialogKey({ key: "backspace" })).toBe("\x7f");
  expect(dialogKey({ key: "delete" })).toBe("\x1b[3~");
});

test("sends typed text and ignores system shortcuts", () => {
  expect(dialogKey({ key: "a", key_char: "А" })).toBe("А");
  expect(dialogKey({ key: "s", key_char: "" })).toBe("s");
  expect(dialogKey({ key: "x", modifiers: { alt: true } })).toBe("\x1bx");
  expect(dialogKey({ key: "s", modifiers: { platform: true } })).toBeUndefined();
});
