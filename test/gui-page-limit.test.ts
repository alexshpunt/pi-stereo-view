import { expect, test } from "vitest";
import { encodeGuiPage } from "../src/gui-bridge.ts";

test("shortens a page without losing the remaining history", () => {
  const page = { v: 1 as const, revision: 1, total: 20, start: 7, entries: Array.from({ length: 5 }, (_, id) => ({ id: String(id), lines: ["é".repeat(30)] })) };
  const output = encodeGuiPage(page, 200);
  const decoded = JSON.parse(output);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(200);
  expect(decoded.total).toBe(20);
  expect(decoded.start).toBe(7);
  expect(decoded.entries.length).toBeGreaterThan(0);
  expect(decoded.entries.length).toBeLessThan(5);
  expect(decoded.entries).toEqual(page.entries.slice(0, decoded.entries.length));
});

test("reports an individual entry too large for a response", () => {
  expect(() => encodeGuiPage({ v: 1, revision: 1, total: 1, start: 0, entries: [{ id: "1", lines: ["a".repeat(300)] }] }, 200)).toThrow();
});
