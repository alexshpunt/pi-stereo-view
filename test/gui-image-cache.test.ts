import { expect, test } from "vitest";
// @ts-expect-error The mod has no TypeScript declarations.
import { createBoundedImageStore } from "../herdr/mods/stereo-view/image-pruner.js";

test("evicts old invisible images and reloads them on demand", async () => {
  const files = new Set<string>();
  const pinned = new Set(["a"]);
  const store = createBoundedImageStore(2, async (path: string) => { files.delete(path); }, (id: string) => pinned.has(id));
  const load = (id: string) => store.load(id, async () => { files.add(id); return { path: id, size: 1 }; });
  await load("a"); await load("b"); await load("c");
  expect([...files].sort()).toEqual(["a", "c"]);
  expect(store.get("b")).toBeUndefined();
  pinned.delete("a"); pinned.add("b");
  await load("b");
  expect(files.has("b")).toBe(true);
  expect(store.get("b")).toBe("b");
});

test("deduplicates concurrent writers and waits for an eviction before rewriting", async () => {
  let finishDelete!: () => void;
  const deleted = new Promise<void>(resolve => { finishDelete = resolve; });
  const store = createBoundedImageStore(1, async () => { await deleted; }, () => false);
  let writes = 0;
  const load = (id: string) => store.load(id, async () => { writes++; return { path: id, size: 1 }; });
  await Promise.all([load("a"), load("a")]);
  expect(writes).toBe(1);
  const eviction = load("b");
  await Promise.resolve(); await Promise.resolve();
  const reload = load("a");
  await Promise.resolve();
  expect(writes).toBe(2);
  finishDelete();
  await Promise.all([eviction, reload]);
  expect(writes).toBe(3);
  expect(store.get("a")).toBe("a");
});

test("preserves visible images over budget and prunes them when no longer visible", async () => {
  const pinned = new Set(["a", "b"]), removed: string[] = [];
  const store = createBoundedImageStore(1, async (path: string) => { removed.push(path); }, (id: string) => pinned.has(id));
  await Promise.all(["a", "b"].map(id => store.load(id, async () => ({ path: id, size: 1 }))));
  expect(removed).toEqual([]);
  pinned.delete("a");
  await store.prune();
  expect(removed).toEqual(["a"]);
  expect(store.get("b")).toBe("b");
});

test("scrolling back during eviction waits for deletion and restores the image", async () => {
  let finishDelete!: () => void;
  let enteredDelete!: () => void;
  const entered = new Promise<void>(resolve => { enteredDelete = resolve; });
  const deleted = new Promise<void>(resolve => { finishDelete = resolve; });
  const files = new Set<string>(), pinned = new Set<string>();
  const store = createBoundedImageStore(1, async (path: string) => { enteredDelete(); await deleted; files.delete(path); }, (id: string) => pinned.has(id));
  let writes = 0;
  const load = (id: string) => store.load(id, async () => { writes++; files.add(id); return { path: id, size: 1 }; });
  await load("a");
  const eviction = load("b");
  await entered;
  pinned.add("a");
  const firstView = load("a"), secondView = load("a");
  finishDelete();
  await Promise.all([eviction, firstView, secondView]);
  expect(writes).toBe(3);
  expect(files.has("a")).toBe(true);
  expect(store.get("a")).toBe("a");
});

test("retains accounting when deleting a cache file fails", async () => {
  let fail = true;
  const removed: string[] = [];
  const store = createBoundedImageStore(1, async (path: string) => { if (fail) throw new Error("failure"); removed.push(path); }, () => false);
  await store.load("a", async () => ({ path: "a", size: 1 }));
  await expect(store.load("b", async () => ({ path: "b", size: 1 }))).rejects.toThrow();
  fail = false;
  await store.prune();
  expect(removed).toHaveLength(1);
});
