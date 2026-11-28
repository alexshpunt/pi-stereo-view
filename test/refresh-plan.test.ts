import { describe, expect, it } from "vitest";
// @ts-expect-error The mod is JavaScript loaded directly by Herdr.
import { dropStaleRows, HIDDEN_MS, LIVE_MS, pageUsable, paneDimensions, refreshPlan, rowHasText } from "../herdr/mods/stereo-view/refresh-plan.js";

describe("refresh plan", () => {
  it("reads at once when a copy appears, then once per live interval", () => {
    expect(refreshPlan({ shown: true, prefetchable: true, wasShown: false, elapsed: 0 })).toBe("live");
    expect(refreshPlan({ shown: true, prefetchable: true, wasShown: true, elapsed: LIVE_MS - 1 })).toBe("idle");
    expect(refreshPlan({ shown: true, prefetchable: true, wasShown: true, elapsed: LIVE_MS })).toBe("live");
  });
  it("keeps a hidden copy warm slowly, and only while its tab is on screen", () => {
    expect(refreshPlan({ shown: false, prefetchable: true, wasShown: false, elapsed: Infinity })).toBe("prefetch");
    expect(refreshPlan({ shown: false, prefetchable: true, wasShown: true, elapsed: HIDDEN_MS - 1 })).toBe("idle");
    expect(refreshPlan({ shown: false, prefetchable: true, wasShown: false, elapsed: HIDDEN_MS })).toBe("prefetch");
    expect(refreshPlan({ shown: false, prefetchable: false, wasShown: false, elapsed: Infinity })).toBe("idle");
  });
});

describe("panel size in cells", () => {
  it("fits whole cells beside the panel's chrome and clamps", () => {
    expect(paneDimensions({ width: 900, height: 500 }, 1, 10, 24)).toEqual({ width: 87, height: 500 });
    expect(paneDimensions({ width: 1800, height: 500 }, 2, 10, 24)).toEqual({ width: 87, height: 250 });
    expect(paneDimensions({ width: 20, height: 0 }, 1, 10, 24)).toEqual({ width: 10, height: 1 });
    expect(paneDimensions({ width: 9000, height: 5 }, 1, 10, 24)).toEqual({ width: 300, height: 5 });
  });
});

describe("rows from before a width change", () => {
  it("drops those outside the first page at the new width and keeps the page's own", () => {
    const items = new Map<number, string>([[0, "a"], [1, "b"], [5, "c"], [9, "d"]]);
    expect(dropStaleRows(items, 4, 3)).toEqual([0, 1, 9]);
    expect([...items.keys()]).toEqual([5]);
  });
});
describe("pages that must not replace rows on screen", () => {
  const page = (total: number, lines: string[], top = 0) => ({ total, lines, top });
  it("rejects an empty window past the end or only blank rows while the panel has content", () => {
    expect(pageUsable(page(500, [], 600), true)).toBe(false);
    expect(pageUsable(page(500, [], 500), true)).toBe(false);
    expect(pageUsable(page(500, ["", "  ", "\x1b[48;5;22m   \x1b[49m"]), true)).toBe(false);
  });
  it("accepts a page with text, and any page for a panel that shows nothing yet or a history with no rows", () => {
    expect(pageUsable(page(500, ["", "\x1b[32mwrite\x1b[39m"]), true)).toBe(true);
    expect(pageUsable(page(500, [], 10), true)).toBe(true);
    expect(pageUsable(page(500, [], 600), false)).toBe(true);
    expect(pageUsable(page(500, ["", ""]), false)).toBe(true);
    expect(pageUsable(page(0, []), true)).toBe(true);
  });
  it("tells text from styled blanks", () => {
    expect(rowHasText(undefined)).toBe(false);
    expect(rowHasText("\x1b[1m \x1b[22m")).toBe(false);
    expect(rowHasText("\x1b[1ma\x1b[22m")).toBe(true);
  });
});
