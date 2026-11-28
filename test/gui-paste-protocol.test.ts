import { expect, test } from "vitest";
import { parseGuiRequest } from "../src/gui-protocol.ts";

test("accepts bounded paste chunks and rejects invalid transactions and content", () => {
  const chunk = { v: 1, op: "surface-paste", frame: 3, transaction: "paste_1", index: 0, count: 2, data: "😀".repeat(256) };
  expect(parseGuiRequest(chunk)).toEqual(chunk);
  const overlay = { ...chunk, op: "overlay-paste", revision: 2, id: 7 };
  expect(parseGuiRequest(overlay)).toEqual(overlay);
  for (const invalid of [{ ...chunk, data: "x".repeat(257) }, { ...chunk, data: "\x1b" }, { ...chunk, data: "\0" },
    { ...chunk, transaction: "bad/id" }, { ...chunk, index: 2 }, { ...chunk, count: 4097 },
    { ...chunk, target: "other" }, { ...overlay, revision: 0 }]) expect(parseGuiRequest(invalid)).toBeUndefined();
});

test("accepts history cancellation only for a pointer release", () => {
  const release = { v: 1, op: "mouse", pane: "chat", frame: 4, event: { type: "release", button: "left", x: 2, y: 0, cancel: true } };
  expect(parseGuiRequest(release)).toEqual(release);
  expect(parseGuiRequest({ ...release, event: { ...release.event, cancel: false } })).toEqual({ ...release, event: { ...release.event, cancel: false } });
  expect(parseGuiRequest({ ...release, event: { ...release.event, type: "press" } })).toBeUndefined();
  expect(parseGuiRequest({ ...release, event: { ...release.event, cancel: "yes" } })).toBeUndefined();
});
