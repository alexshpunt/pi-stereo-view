import { describe, expect, it } from "vitest";
// @ts-expect-error The mod is JavaScript loaded directly by Herdr.
import { composerAlive, composerFieldCommand, composerRoute } from "../herdr/mods/stereo-view/composer-route.js";

describe("composer navigation", () => {
  it("accepts a navigation request only for its own pane", () => {
    expect(composerRoute("composer:pane%2Fone:pageup", "pane/one")).toBe("pageup");
    expect(composerRoute("composer:pane%2Fone:pageup", "pane/two")).toBeUndefined();
    expect(composerRoute("composer:pane%2Fone:dialog-focus", "pane/one")).toBe("dialog-focus");
    expect(composerRoute("composer:pane%2Fone:dialog-focus", "pane/two")).toBeUndefined();
    expect(composerRoute("composer:pane%2Fone:delete", "pane/one")).toBeUndefined();
    expect(composerRoute("composer:%invalid:pageup", "pane/one")).toBeUndefined();
    for (const action of ["pageup", "pagedown", "home", "end", "search"]) {
      expect(composerRoute(`composer:pane%2Fone:${action}`, "pane/one")).toBe(action);
    }
  });
  it("addresses the keyboard handover to one pane's composer, only while its label is fresh", () => {
    expect(composerFieldCommand("pane/one")).toBe("paste-composer.field:pane%2Fone:focus");
    expect(composerFieldCommand(undefined)).toBeUndefined();
    expect(composerAlive({ "herdr.composer": "100000" }, 105000)).toBe(true);
    expect(composerAlive({ "herdr.composer": "100000" }, 200000)).toBe(false);
    expect(composerAlive({}, 105000)).toBe(false);
    expect(composerAlive({ "herdr.composer": "x" }, 105000)).toBe(false);
  });
});
