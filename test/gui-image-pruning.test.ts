import { expect, test } from "vitest";
// @ts-expect-error The mod has no TypeScript declarations.
import { createImagePruner } from "../herdr/mods/stereo-view/image-pruner.js";

test("all image writes wait for the single startup prune", async () => {
  let finish!: () => void;
  let calls = 0;
  const prune = createImagePruner(() => { calls++; return new Promise<void>(resolve => { finish = resolve; }); });
  const completed: number[] = [];
  const first = prune().then(() => completed.push(1));
  const second = prune().then(() => completed.push(2));
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(completed).toEqual([]);
  finish();
  await Promise.all([first, second]);
  expect(completed).toEqual([1, 2]);
  await prune();
  expect(calls).toBe(1);
});

test("a failed startup prune does not prevent image writes", async () => {
  let calls = 0;
  const prune = createImagePruner(async () => { calls++; throw new Error("unavailable"); });
  await expect(prune()).resolves.toBeUndefined();
  await expect(prune()).resolves.toBeUndefined();
  expect(calls).toBe(1);
});
