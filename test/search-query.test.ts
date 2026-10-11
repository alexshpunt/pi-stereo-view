import { expect, test } from "vitest";
import { compileSearchQuery, compileSearchCondition, satisfiesSearchCondition } from "../src/search-query.js";

test("ordinary phrases and punctuation stay literal unless regex is explicitly enabled", () => {
  expect(compileSearchQuery("ready now")).toBe("ready now");
  expect(compileSearchQuery("a.b (ready)")).toBe("a\\.b \\(ready\\)");
  expect(compileSearchQuery("(foo|bar)[ ]+\\d+", true)).toBe("(foo|bar)[ ]+\\d+");
  expect(compileSearchCondition("(foo|bar)", true)).toBeUndefined();
});
test("AND and infix NOT bind before OR, with grouped and implicit conjunctions", () => {
  const condition = compileSearchCondition('"ready" worker OR other NOT failed')!;
  const matches = (terms: string[]) => satisfiesSearchCondition(condition, term => terms.includes(term));
  expect(matches(["ready", "worker"])).toBe(true);
  expect(matches(["worker"])).toBe(false);
  expect(matches(["other"])).toBe(true);
  expect(matches(["other", "failed"])).toBe(false);
  expect(compileSearchQuery("(worker OR other) AND ready")).toBe("(?:(?:worker|other)|ready)");
});
test("both Boolean pipe spellings work while unspaced regex alternation stays intact", () => {
  expect(compileSearchQuery("a || b")).toBe("(?:a|b)");
  expect(compileSearchQuery("a | b")).toBe("(?:a|b)");
  expect(compileSearchQuery("a|b", true)).toBe("a|b");
  expect(compileSearchQuery("a|b")).toBe("a\\|b");
});
test("quoted phrases stay literal even in regex mode, with escaped quotes and backslashes", () => {
  expect(compileSearchQuery('"a.b" AND \\d+', true)).toBe("(?:a\\.b|\\d+)");
  expect(compileSearchQuery('"worker \\"ready\\""')).toBe('worker "ready"');
});
test("excluded terms never enter the positive matching pattern", () => {
  expect(compileSearchQuery("ready NOT failed")).toBe("ready");
  expect(compileSearchCondition("ready NOT failed")).toEqual({ kind: "not",
    left: { kind: "term", value: "ready" }, right: { kind: "term", value: "failed" } });
});
test.each(["ready AND", "OR ready", "NOT ready", '(ready OR other', '"unfinished', '""'])
  ("reports an incomplete or invalid expression: %s", query => {
    expect(() => compileSearchQuery(query)).toThrow(SyntaxError);
  });
