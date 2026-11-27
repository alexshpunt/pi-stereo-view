import { expect, test } from "vitest";
import { lineRange } from "../herdr/mods/stereo-view/line-range.js";

test("renders only lines near the viewport in a very long entry", () => {
  expect(lineRange(100_000, 0, 170_000, 510, 17)).toEqual({ first: 9995, last: 10035 });
  expect(lineRange(100_000, 0, 0, 510, 17)).toEqual({ first: 0, last: 35 });
  expect(lineRange(10, 100, 0, 50, 17)).toEqual({ first: 0, last: 3 });
});
