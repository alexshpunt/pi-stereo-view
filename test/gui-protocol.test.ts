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

test("limits dialog frames and input", () => {
  expect(parseGuiRequest({ v: 1, op: "surface", width: 80 })).toEqual({ v: 1, op: "surface", width: 80 });
  expect(parseGuiRequest({ v: 1, op: "surface", width: 301 })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "surface-key", frame: 1, data: "\u001b[A" }))
    .toEqual({ v: 1, op: "surface-key", frame: 1, data: "\u001b[A" });
  expect(parseGuiRequest({ v: 1, op: "surface-key", frame: -1, data: "a" })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "surface-key", frame: 1, data: "x".repeat(1025) })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "surface-key", frame: 1, data: "\0" })).toBeUndefined();
  const pointer = { v: 1, op: "surface-mouse", frame: 3, event: { type: "press", button: "left", x: 5, y: 2 } };
  expect(parseGuiRequest(pointer)).toEqual(pointer);
  expect(parseGuiRequest({ ...pointer, event: { ...pointer.event, x: 300 } })).toBeUndefined();
  expect(parseGuiRequest({ ...pointer, event: { ...pointer.event, type: "click" } })).toBeUndefined();
});

test("targets dock surfaces without allowing arbitrary targets", () => {
  const page = { v: 1, op: "surface", target: "dock", width: 80 };
  const key = { v: 1, op: "surface-key", target: "dock", frame: 3, data: "a" };
  const mouse = { v: 1, op: "surface-mouse", target: "dock", frame: 3,
    event: { type: "press", button: "left", x: 1, y: 0 } };
  for (const request of [page, key, mouse]) {
    expect(parseGuiRequest(request)).toEqual(request);
    expect(parseGuiRequest({ ...request, target: "unknown" })).toBeUndefined();
  }
});
test("accepts bounded overlay layer requests and rejects invalid identifiers", () => {
  const page = { v: 1, op: "overlays" };
  const key = { v: 1, op: "overlay-key", revision: 2, id: 1, frame: 1, data: "a" };
  const mouse = { v: 1, op: "overlay-mouse", revision: 2, id: 1, frame: 1,
    event: { type: "press", button: "left", x: 3, y: 1 } };
  for (const request of [page, key, mouse]) expect(parseGuiRequest(request)).toEqual(request);
  expect(parseGuiRequest({ ...key, id: 0 })).toBeUndefined();
  expect(parseGuiRequest({ ...mouse, event: { ...mouse.event, y: 256 } })).toBeUndefined();
});
test("accepts bounded surface pointer types, buttons, modifiers and wheel steps", () => {
  for (const target of [{ v: 1, op: "surface-mouse", frame: 1 },
    { v: 1, op: "overlay-mouse", revision: 1, id: 1, frame: 1 }]) {
    const events = [
      { type: "move", button: "none", x: 1, y: 1, shift: true },
      { type: "wheel", button: "none", x: 1, y: 1, wheelDelta: -3, ctrl: true },
      { type: "press", button: "right", x: 1, y: 1, clickCount: 2, alt: true },
      { type: "drag", button: "middle", x: -3, y: 350 },
      { type: "release", button: "left", x: 400, y: -1, cancel: true },
    ];
    for (const event of events) expect(parseGuiRequest({ ...target, event })).toEqual({ ...target, event });
    for (const event of [
      { type: "move", button: "left", x: 1, y: 1 },
      { type: "wheel", button: "none", x: 1, y: 1, wheelDelta: 0 },
      { type: "wheel", button: "none", x: 1, y: 1, wheelDelta: 1.5 },
      { type: "press", button: "none", x: 1, y: 1 },
      { type: "press", button: "left", x: 1, y: 1, clickCount: 4 },
      { type: "release", button: "left", x: 1, y: 1, shift: 1 },
    ]) expect(parseGuiRequest({ ...target, event })).toBeUndefined();
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
  expect(parseGuiRequest({ v: 1, op: "search", pane: "chat", action: "query", query: "hello" })).toEqual({ v: 1, op: "search", pane: "chat", action: "query", query: "hello" });
  expect(parseGuiRequest({ v: 1, op: "search", pane: "combined", action: "query", query: "hello" })).toBeUndefined();
  expect(parseGuiRequest({ v: 1, op: "search", pane: "chat", action: "query", query: "x".repeat(3000) })).toBeUndefined();
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
