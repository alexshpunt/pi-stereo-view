import { expect, test } from "vitest";
import { parseGuiRequest } from "../src/gui-protocol.ts";

test("accepts bounded pages for the two panes", () => {
  expect(parseGuiRequest({ v: 1, op: "page", pane: "chat", start: 20, count: 32, width: 80 })).toEqual({
    v: 1, op: "page", pane: "chat", start: 20, count: 32, width: 80,
  });
  expect(parseGuiRequest({ v: 1, op: "page", pane: "activity", start: 0, count: 1, width: 10 })).toEqual({ v: 1, op: "page", pane: "activity", start: 0, count: 1, width: 10 });
  expect(parseGuiRequest({ v: 1, op: "page", pane: "chat", start: 0, count: 0, width: 80 })).toEqual({ v: 1, op: "page", pane: "chat", start: 0, count: 0, width: 80 });
});

test("rejects malformed or unbounded requests", () => {
  const valid = { v: 1, op: "page", pane: "chat", start: 0, count: 1, width: 80 };
  for (const invalid of [null, [], {}, { ...valid, pane: "other" }, { ...valid, start: -1 },
    { ...valid, start: 0.5 }, { ...valid, count: -1 }, { ...valid, count: 65 },
    { ...valid, width: 9 }, { ...valid, width: 301 }, { ...valid, v: 2 }, { ...valid, op: "execute" }]) {
    expect(parseGuiRequest(invalid)).toBeUndefined();
  }
});

test("accepts only known GUI controls", () => {
  expect(parseGuiRequest({ v: 1, op: "view", pane: "chat", top: 10, height: 20, width: 80, following: false }))
    .toEqual({ v: 1, op: "view", pane: "chat", top: 10, height: 20, width: 80, following: false });
  expect(parseGuiRequest({ v: 1, op: "view", pane: "chat", top: 10, height: 257, width: 80, following: false })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "mouse", pane: "chat", frame: 2, event: { type: "press", button: "left", x: 3, y: 4 } }))
    .toEqual({ v: 1, op: "mouse", pane: "chat", frame: 2, event: { type: "press", button: "left", x: 3, y: 4 } });
  expect(parseGuiRequest({ v: 1, op: "mouse", pane: "chat", frame: 2, event: { type: "press", button: "left", x: 3, y: 1e15 } })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "setting", key: "compactTools", value: false })).toEqual({ v: 1, op: "setting", key: "compactTools", value: false });
  expect(parseGuiRequest({ v: 1, op: "setting", key: "showPaneHeaders", value: "auto" })).toEqual({ v: 1, op: "setting", key: "showPaneHeaders", value: "auto" });
  expect(parseGuiRequest({ v: 1, op: "setting", key: "turnHoverMix", value: 999 })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "setting", key: "chatWidth", value: 45 })).toEqual({ v: 1, op: "setting", key: "chatWidth", value: 45 });
  expect(parseGuiRequest({ v: 1, op: "setting", key: "chatWidth", value: 2 })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "setting", key: "__proto__", value: true })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "setting", key: "showToolbar", value: "yes" })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "state" })).toEqual({ v: 1, op: "state" });
  for (const action of ["swap", "layout", "mode", "zoom-chat", "zoom-activity", "compact", "settings", "headers"]) {
    expect(parseGuiRequest({ v: 1, op: "action", action })).toEqual({ v: 1, op: "action", action });
  }
  for (const action of ["execute", "", null, 1]) {
    expect(parseGuiRequest({ v: 1, op: "action", action })).toBeUndefined();
  }
});
