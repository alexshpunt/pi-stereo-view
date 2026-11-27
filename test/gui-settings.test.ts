import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Native GPUI modules are available only inside Herdr. The setting model is independent of them.
function settingsModule() {
  const source = readFileSync(new URL("../herdr/mods/stereo-view/settings.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "") + "\nreturn { settingGroups, nextSetting, parseSettingInput };";
  return new Function(source)();
}

test("offers all saved display settings with their current values", () => {
  const { settingGroups } = settingsModule();
  const values = { showTimestamps: true, showCopyButtons: false, buttonStyle: "text", showModelUsage: false,
    compactTools: true, groupTools: true, nestedTree: true, streamTools: true, streamDelay: 5,
    showToolDurations: false, chatHeight: null, showToolbar: true, showPaneHeaders: "auto",
    autoPaneHeaderRows: 32, piWindows: "combined", turns: true, turnClock: true, turnClockMix: 10,
    turnStripe: "block", turnStripeMix: 20, turnBackground: false, turnBackgroundMix: 8,
    turnSeparator: true, turnHover: true, turnHoverMix: 10, turnHoverColor: "#123456", goTo: "both" };
  const rows = settingGroups(values).flatMap((group: any) => group.rows);
  const keys = rows.map((row: any) => row.key);
  for (const key of Object.keys(values)) expect(keys).toContain(key);
  expect(rows.find((row: any) => row.key === "turnHoverColor").values).toContain("#123456");
});

test("cycles choices in both directions including existing custom strengths", () => {
  const { nextSetting } = settingsModule();
  expect(nextSetting([true, false], true, 1)).toBe(false);
  expect(nextSetting([true, false], true, -1)).toBe(false);
  expect(nextSetting([2, 5, 7, 8], 7, 1)).toBe(8);
  expect(nextSetting([2, 5, 7, 8], 2, -1)).toBe(8);
});

test("validates typed threshold and hover color without changing them on invalid input", () => {
  const { parseSettingInput } = settingsModule();
  expect(parseSettingInput("autoPaneHeaderRows", " 42 ")).toBe(42);
  for (const value of ["0", "-1", "1.5", "9007199254740992", "a"]) expect(parseSettingInput("autoPaneHeaderRows", value)).toBeUndefined();
  expect(parseSettingInput("turnHoverColor", "#AABBCC")).toBe("#aabbcc");
  for (const value of ["#abc", "red", "#12345g"]) expect(parseSettingInput("turnHoverColor", value)).toBeUndefined();
});

test("settings controls send typed changes and close without mutating preferences", () => {
  class Element {
    idValue?: string;
    children: Element[] = [];
    click?: (...args: any[]) => void;
    constructor() {
      return new Proxy(this, { get(target, prop, receiver) {
        if (prop in target) return (target as any)[prop];
        return (...args: any[]) => {
          if (prop === "id") target.idValue = args[0];
          if (prop === "child" && args[0] instanceof Element) target.children.push(args[0]);
          if (prop === "on_click") target.click = args[0];
          return receiver;
        };
      } });
    }
  }
  const inputs: any[] = [];
  const InputState = { new: ({ value }: any) => {
    const events: Record<string, Function> = {};
    const input = { current: value, on: (key: string, fn: Function) => { events[key] = fn; }, value() { return this.current; }, events };
    inputs.push(input); return input;
  } };
  const source = readFileSync(new URL("../herdr/mods/stereo-view/settings.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export /gm, "") + "\nreturn { createSettingsPanel };";
  const element = () => new Element();
  const { createSettingsPanel } = new Function("div", "h_flex", "v_flex", "Input", "InputState", source)
    (element, element, element, { new: element }, InputState);
  const preferences = { showTimestamps: true, autoPaneHeaderRows: 32, turnHoverColor: "#808080" };
  const changes: any[] = [];
  let closed = 0;
  const cx = { notify() {} };
  const panel = createSettingsPanel(preferences, (key: string, value: unknown) => changes.push([key, value]), () => { closed++; });
  const root = panel.render(preferences, {});
  const find = (node: Element, id: string): Element | undefined => node.idValue === id ? node : node.children.flatMap(child => find(child, id) ?? [])[0];
  find(root, "stereo-setting-showTimestamps-next")!.click!({}, cx);
  expect(changes).toEqual([["showTimestamps", false]]);
  expect(preferences.showTimestamps).toBe(true);
  inputs[0].current = "15";
  find(root, "stereo-setting-autoPaneHeaderRows-apply")!.click!({}, cx);
  inputs[0].current = "0";
  find(root, "stereo-setting-autoPaneHeaderRows-apply")!.click!({}, cx);
  expect(changes).toEqual([["showTimestamps", false], ["autoPaneHeaderRows", 15]]);
  find(root, "stereo-settings-close")!.click!({}, cx);
  expect(closed).toBe(1);
});
