import { describe, expect, it } from "vitest";
// @ts-expect-error The mod is JavaScript loaded directly by Herdr.
import { composerRoute } from "../herdr/mods/stereo-view/composer-route.js";

describe("composer navigation", () => {
  it("accepts a navigation request only for its own pane", () => {
    expect(composerRoute("composer:pane%2Fone:pageup", "pane/one")).toBe("pageup");
    expect(composerRoute("composer:pane%2Fone:pageup", "pane/two")).toBeUndefined();
    expect(composerRoute("composer:pane%2Fone:delete", "pane/one")).toBeUndefined();
    expect(composerRoute("composer:%invalid:pageup", "pane/one")).toBeUndefined();
    for (const action of ["pageup", "pagedown", "home", "end", "search"]) {
      expect(composerRoute(`composer:pane%2Fone:${action}`, "pane/one")).toBe(action);
    }
  });
});
