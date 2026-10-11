import { expect, test } from "vitest";
import { matchSearchLines } from "../src/search-matcher.js";

const ranges = (start: number, end: number) => [{ start, end }];

test("literal search never uses fuzzy, regex, or any-word fallback", async () => {
  expect(await matchSearchLines(["ready now", "r-e-a-d-y", "ready later"], "rdy")).toEqual([]);
  expect(await matchSearchLines(["ready now", "ready later"], "ready now")).toEqual([{ index: 0, ranges: ranges(0, 9) }]);
  expect(await matchSearchLines(["a.b", "axb"], "a.b")).toEqual([{ index: 0, ranges: ranges(0, 3) }]);
  expect(await matchSearchLines(["İ then SEARCH / search"], "search")).toEqual([
    { index: 0, ranges: [{ start: 7, end: 13 }, { start: 16, end: 22 }] },
  ]);
});

test("Boolean conditions apply to each line and highlight only positive terms", async () => {
  const lines = ["worker ready", "worker failed", "other ready", "ready failed"];
  expect(await matchSearchLines(lines, "worker AND ready")).toEqual([{ index: 0, ranges: [{ start: 0, end: 6 }, { start: 7, end: 12 }] }]);
  expect(await matchSearchLines(lines, "ready NOT worker")).toEqual([
    { index: 2, ranges: ranges(6, 11) }, { index: 3, ranges: ranges(0, 5) },
  ]);
  expect((await matchSearchLines(lines, '(worker OR other) AND "ready"')).map(hit => hit.index)).toEqual([0, 2]);
  expect((await matchSearchLines(lines, "worker || other")).map(hit => hit.index)).toEqual([0, 1, 2]);
  expect((await matchSearchLines(lines, "worker | other")).map(hit => hit.index)).toEqual([0, 1, 2]);
});

test("explicit regex supports PCRE2 and maps UTF-8 byte offsets to native UTF-16 spans", async () => {
  expect(await matchSearchLines(["界 ✅ Запуск worker ready", "worker failed"], "regex:worker(?= ready)")).toEqual([
    { index: 0, ranges: ranges(11, 17) },
  ]);
  expect(await matchSearchLines(["ready 12", "ready 34", "gone 12"], "regex:ready AND \\d+ NOT 34")).toEqual([
    { index: 0, ranges: [{ start: 0, end: 5 }, { start: 6, end: 8 }] },
  ]);
  expect(await matchSearchLines(["a.b", "axb"], 'regex:"a.b"')).toEqual([{ index: 0, ranges: ranges(0, 3) }]);
});

test("invalid and incomplete expressions report errors rather than matching another query", async () => {
  await expect(Promise.resolve().then(() => matchSearchLines(["ready"], "ready AND"))).rejects.toThrow("expected a term");
  await expect(Promise.resolve().then(() => matchSearchLines(["ready"], "regex:["))).rejects.toThrow();
  await expect(Promise.resolve().then(() => matchSearchLines(["ready"], "regex:"))).rejects.toThrow("Enter a regex");
});

test("regex can be cancelled or timed out without blocking the UI thread", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(Promise.resolve().then(() => matchSearchLines(["ready"], "regex:ready", controller.signal))).rejects.toMatchObject({ name: "AbortError" });
  const job = matchSearchLines(["a".repeat(500_000) + "!"], "regex:(a+)+$", undefined, 1);
  await expect(job).rejects.toThrow(/timed out/);
});
