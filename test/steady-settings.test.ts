import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { SteadySettings } from "../src/steady-settings.ts";

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
  const steady = new SteadySettings(list, items, 10);
  const frames: string[][] = [];
  for (let index = 0; index < items.length; index++) {
    frames.push(steady.render(30));
    steady.handleInput(DOWN);
  }
  expect(new Set(frames.map(frame => frame.length)).size).toBe(1);
  // The longest description fills the list, so nothing is padded there.
  list.selectItem("long");
  expect(steady.render(30)).toEqual(list.render(30));
  for (const frame of frames) expect(frame.at(-1)).toContain("Enter/Space to change");
  // Items stay on the same rows, so pointer rows still map to items.
  for (const frame of frames) expect(frame.slice(0, 3).map(row => row.replace("→ ", "  ").trim().split(/\s+/)[0])).toEqual(["Short", "Long", "None"]);
});
