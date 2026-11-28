import { expect, test } from "vitest";
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

test("sends typed text and ignores system shortcuts", () => {
  expect(dialogKey({ key: "a", key_char: "А" })).toBe("А");
  expect(dialogKey({ key: "s", key_char: "" })).toBe("s");
  expect(dialogKey({ key: "x", modifiers: { alt: true } })).toBe("\x1bx");
  expect(dialogKey({ key: "s", modifiers: { platform: true } })).toBeUndefined();
});
