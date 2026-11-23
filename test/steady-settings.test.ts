import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { SteadySettings } from "../src/steady-settings.ts";
import { HexInput } from "../src/hex-input.ts";

const plain = (text: string): string => text;
const theme = { label: plain, value: plain, description: plain, cursor: "→ ", hint: plain };
const DOWN = "\x1b[B";

test("the settings list keeps one height and keeps its hint on the last row while the selection moves", () => {
  const items: SettingItem[] = [
    { id: "short", label: "Short", description: "One line.", currentValue: "on", values: ["on", "off"] },
    { id: "long", label: "Long", description: "A description long enough to wrap over several rows at this narrow width of the list.", currentValue: "on", values: ["on", "off"] },
    { id: "none", label: "None", currentValue: "on", values: ["on", "off"] },
  ];
  const list = new SettingsList(items, 10, theme, () => {}, () => {});
  const steady = new SteadySettings(list, items, 10, () => {});
  const frames: (readonly string[])[] = [];
  for (let index = 0; index < items.length; index++) {
    frames.push(steady.render(30));
    steady.handleInput(DOWN);
  }
  expect(new Set(frames.map(frame => frame.length)).size).toBe(1);
  // The longest description fills the list, so nothing is padded there.
  list.selectItem("long");
  expect(steady.render(30)).toEqual(list.render(30).map(row => row.replace("Enter/Space", "←/→ or Enter/Space")));
  for (const frame of frames) expect(frame.at(-1)).toContain("Enter/Space to change");
  // Items stay on the same rows, so pointer rows still map to items.
  for (const frame of frames) expect(frame.slice(0, 3).map(row => row.replace("→ ", "  ").trim().split(/\s+/)[0])).toEqual(["Short", "Long", "None"]);
});

test("left and right step the selected value around in both directions, and up and down still move the selection", () => {
  const items: SettingItem[] = [
    { id: "strength", label: "Strength", currentValue: "10%", values: ["5%", "10%", "15%"] },
    { id: "header", label: "Header", currentValue: "", values: [] },
  ];
  const changes: string[] = [];
  const list = new SettingsList(items, 10, theme, (id, value) => changes.push("cycle " + id + "=" + value), () => {});
  const steady = new SteadySettings(list, items, 10, (id, value) => changes.push(id + "=" + value));
  const LEFT = "\x1b[D";
  const RIGHT = "\x1b[C";
  steady.handleInput(RIGHT);
  steady.handleInput(RIGHT);
  // Past the last value, Right starts over at the first.
  expect(items[0].currentValue).toBe("5%");
  steady.handleInput(LEFT);
  steady.handleInput(LEFT);
  // Before the first value, Left continues from the last.
  expect(items[0].currentValue).toBe("10%");
  expect(changes).toEqual(["strength=15%", "strength=5%", "strength=15%", "strength=10%"]);
  expect(steady.render(40).at(-1)).toContain("←/→ or Enter/Space to change");
  // On an item without values the arrows change nothing; Down still moves the selection.
  steady.handleInput("\x1b[B");
  steady.handleInput(RIGHT);
  expect(changes).toHaveLength(4);
  expect(steady.render(40)[1]).toContain("→ Header");
});

test("a hex color submenu takes a typed color, rejects an invalid one and keeps the list's height", () => {
  const items: SettingItem[] = [
    { id: "color", label: "Hover color", description: "One line.", currentValue: "turn", values: ["turn", "#808080"],
      submenu: (current, done) => new HexInput(current, { title: text => text, hint: text => text, error: text => text }, done) },
  ];
  const changes: string[] = [];
  const list = new SettingsList(items, 10, theme, (id, value) => changes.push(id + "=" + value), () => {});
  const steady = new SteadySettings(list, items, 10, (id, value) => changes.push(id + "=" + value));
  const height = steady.render(40).length;
  steady.handleInput("\r");
  // The input starts with "#"; Left moves its cursor instead of changing the setting.
  expect(steady.render(40).join("\n")).toContain("Hover color");
  expect(steady.render(40)).toHaveLength(height);
  for (const key of "zz") steady.handleInput(key);
  steady.handleInput("\r");
  expect(steady.render(40).join("\n")).toContain("Enter a color as #rrggbb");
  for (let index = 0; index < 2; index++) steady.handleInput("\x7f");
  for (const key of "3B82F6") steady.handleInput(key);
  steady.handleInput("\x1b[D");
  expect(changes).toEqual([]);
  // A typed color opens with that color in the input, ready to edit.
  expect(new HexInput("#a855f7", { title: text => text, hint: text => text, error: text => text }, () => {}).render(40)[1]).toContain("#a855f7");
  steady.handleInput("\r");
  expect(changes).toEqual(["color=#3b82f6"]);
  expect(items[0].currentValue).toBe("#3b82f6");
  expect(HexInput.normalize("ABCDEF")).toBe("#abcdef");
  expect(HexInput.normalize("#abcde")).toBeUndefined();
});
