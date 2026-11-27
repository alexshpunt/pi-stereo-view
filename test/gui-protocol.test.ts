import { expect, test } from "vitest";
import { parseGuiRequest } from "../src/gui-protocol.ts";

test("accepts bounded pages for the two panes", () => {
  expect(parseGuiRequest({ v: 1, op: "page", pane: "chat", start: 20, count: 32, width: 80 })).toEqual({
    v: 1, op: "page", pane: "chat", start: 20, count: 32, width: 80,
  });
  expect(parseGuiRequest({ v: 1, op: "page", pane: "activity", start: 0, count: 1, width: 10 })?.pane).toBe("activity");
});

test("rejects malformed or unbounded requests", () => {
  const valid = { v: 1, op: "page", pane: "chat", start: 0, count: 1, width: 80 };
  for (const invalid of [null, [], {}, { ...valid, pane: "other" }, { ...valid, start: -1 },
    { ...valid, start: 0.5 }, { ...valid, count: 0 }, { ...valid, count: 65 },
    { ...valid, width: 9 }, { ...valid, width: 301 }, { ...valid, v: 2 }, { ...valid, op: "execute" }]) {
    expect(parseGuiRequest(invalid)).toBeUndefined();
  }
});
