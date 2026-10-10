import { Box, Container, Text, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeRenderCache } from "../src/render-cache.js";

test("reuses unchanged native output and honors direct component invalidation", () => {
  let text = "first";
  let renders = 0;
  const component: Component = { render: width => { renders++; return [text + width]; }, invalidate() {} };
  const invalidate = component.invalidate;
  const cache = new NativeRenderCache(component);
  const theme = {};
  const first = cache.render(30, theme);
  expect(cache.render(30, theme)).toBe(first);
  expect(renders).toBe(1);
  text = "second";
  component.invalidate();
  expect(cache.render(30, theme)).toEqual(["second30"]);
  expect(renders).toBe(2);
  cache.render(20, theme);
  cache.render(20, {});
  expect(renders).toBe(4);
  cache.dispose();
  expect(component.invalidate).toBe(invalidate);
});

test("sees native text setters, child replacement and nested invalidation", () => {
  const text = new Text("first", 0, 0);
  const root = new Container();
  root.addChild(text);
  const cache = new NativeRenderCache(root);
  const theme = {};
  cache.render(30, theme);
  text.setText("second");
  expect(cache.render(30, theme).join("\n")).toContain("second");
  let value = "third";
  const child: Component = { render: () => [value], invalidate() {} };
  const original = child.invalidate;
  root.children = [child];
  expect(cache.render(30, theme)).toEqual(["third"]);
  value = "fourth";
  child.invalidate();
  expect(cache.render(30, theme)).toEqual(["fourth"]);
  root.clear();
  expect(cache.render(30, theme)).toEqual([]);
  expect(child.invalidate).toBe(original);
  cache.dispose();
});

test.each(["text", "box"])("honors %s background refresh with the same callback", kind => {
  let color = 41;
  const background = (text: string) => "\x1b[" + color + "m" + text + "\x1b[0m";
  const text = new Text("body", 0, 0, background);
  const box = new Box(0, 0, background);
  box.addChild(new Text("body", 0, 0));
  const component = kind === "text" ? text : box;
  const cache = new NativeRenderCache(component);
  const theme = {};
  expect(cache.render(20, theme).join("")).toContain("\x1b[41m");
  color = 42;
  if (kind === "text") text.setCustomBgFn(background);
  expect(cache.render(20, theme).join("")).toContain("\x1b[42m");
  cache.dispose();
});

test("does not retain a new child's first output before its invalidation is observable", () => {
  let renders = 0;
  const child: Component = {
    render() { if (++renders === 1) this.invalidate(); return [String(renders)]; },
    invalidate() {},
  };
  const root = new Container();
  root.render = width => {
    if (!root.children.length) root.addChild(child);
    return child.render(width);
  };
  const cache = new NativeRenderCache(root);
  const theme = {};
  expect(cache.render(20, theme)).toEqual(["1"]);
  expect(cache.render(20, theme)).toEqual(["2"]);
  cache.dispose();
});

test("shared native children notify both caches and restore only after the last subscriber", () => {
  let value = "first";
  const child: Component = { render: () => [value], invalidate() {} };
  const original = child.invalidate;
  const left = new Container();
  const right = new Container();
  left.addChild(child);
  right.addChild(child);
  const one = new NativeRenderCache(left);
  const two = new NativeRenderCache(right);
  const theme = {};
  one.render(20, theme);
  two.render(20, theme);
  one.dispose();
  expect(child.invalidate).not.toBe(original);
  value = "second";
  child.invalidate();
  expect(two.render(20, theme)).toEqual(["second"]);
  two.dispose();
  expect(child.invalidate).toBe(original);
});

test("replacing a shared child keeps the other cache subscribed until removal", () => {
  let oldValue = "old";
  let newValue = "new";
  const oldChild: Component = { render: () => [oldValue], invalidate() {} };
  const replacement: Component = { render: () => [newValue], invalidate() {} };
  const original = oldChild.invalidate;
  const replacementOriginal = replacement.invalidate;
  const left = new Container();
  const right = new Container();
  left.addChild(oldChild);
  right.addChild(oldChild);
  const one = new NativeRenderCache(left);
  const two = new NativeRenderCache(right);
  const theme = {};
  try {
    one.render(20, theme);
    two.render(20, theme);
    left.children = [replacement];
    expect(one.render(20, theme)).toEqual(["new"]);
    expect(oldChild.invalidate).not.toBe(original);
    oldValue = "old refreshed";
    oldChild.invalidate();
    expect(two.render(20, theme)).toEqual(["old refreshed"]);
    newValue = "replacement refreshed";
    replacement.invalidate();
    expect(one.render(20, theme)).toEqual(["replacement refreshed"]);
    right.clear();
    expect(two.render(20, theme)).toEqual([]);
    expect(oldChild.invalidate).toBe(original);
    expect(replacement.invalidate).not.toBe(replacementOriginal);
  } finally {
    one.dispose();
    two.dispose();
  }
  expect(replacement.invalidate).toBe(replacementOriginal);
});

test("a renderer that invalidates during rendering is refreshed on the next frame", () => {
  let renders = 0;
  const component: Component = {
    render() { this.invalidate(); return [String(++renders)]; },
    invalidate() {},
  };
  const cache = new NativeRenderCache(component);
  const theme = {};
  expect(cache.render(20, theme)).toEqual(["1"]);
  expect(cache.render(20, theme)).toEqual(["2"]);
  cache.dispose();
});
test("maintains stable-tree subscriptions only once when the width changes", () => {
  const root = new Container();
  root.addChild(new Text("body", 0, 0));
  const cache = new NativeRenderCache(root);
  const maintenance = cache as unknown as { watch(nodes: Component[]): boolean };
  const watch = maintenance.watch;
  let passes = 0;
  maintenance.watch = function (nodes) { passes++; return watch.call(this, nodes); };
  const theme = {};
  try {
    cache.render(20, theme);
    passes = 0;
    expect(cache.render(30, theme).join("\n")).toContain("body");
    expect(passes, "A stable width miss must not rebuild the same subscription set twice").toBe(1);
  } finally { cache.dispose(); }
});

test("reads each structural link only before and after a cold native render", () => {
  const child: Component = { render: () => ["body"], invalidate() {} };
  const original = child.invalidate;
  const links = [child];
  const reads = { children: 0, child: 0, component: 0 };
  const root: Component & { children: Component[]; child: undefined; component: undefined } = {
    get children() { reads.children++; return links; },
    get child() { reads.child++; return undefined; },
    get component() { reads.component++; return undefined; },
    render: width => links.flatMap(component => component.render(width)),
    invalidate() {},
  };
  const cache = new NativeRenderCache(root);
  const theme = {};
  try {
    cache.render(20, theme);
    reads.children = reads.child = reads.component = 0;
    expect(cache.render(30, theme)).toEqual(["body"]);
    expect(reads, "Snapshot creation must reuse the post-render structural observation").toEqual({
      children: 2, child: 2, component: 2,
    });
    links.length = 0;
    child.invalidate();
    expect(cache.render(30, theme)).toEqual([]);
    expect(child.invalidate).toBe(original);
  } finally { cache.dispose(); }
});
test.each(["child", "component"] as const)("refreshes changed %s links captured after rendering", key => {
  const first: Component = { render: () => ["first"], invalidate() {} };
  let value = "second";
  const second: Component = { render: () => [value], invalidate() {} };
  const original = first.invalidate;
  const root: Component & { child?: Component; component?: Component } = {
    [key]: first,
    render: width => root[key]!.render(width),
    invalidate() {},
  };
  const cache = new NativeRenderCache(root);
  const theme = {};
  try {
    expect(cache.render(20, theme)).toEqual(["first"]);
    root[key] = second;
    expect(cache.render(20, theme)).toEqual(["second"]);
    expect(first.invalidate).toBe(original);
    const output = cache.render(20, theme);
    expect(cache.render(20, theme)).toBe(output);
    value = "updated";
    second.invalidate();
    expect(cache.render(20, theme)).toEqual(["updated"]);
  } finally { cache.dispose(); }
});
test("does not sweep unchanged subscriptions during a width miss", () => {
  const child = new Text("body", 0, 0);
  const original = child.invalidate;
  const root = new Container();
  root.addChild(child);
  const cache = new NativeRenderCache(root);
  const theme = {};
  const watched = (cache as unknown as { watched: Map<Component, () => void> }).watched;
  const iterate = watched[Symbol.iterator];
  let visits = 0;
  try {
    cache.render(20, theme);
    Object.defineProperty(watched, Symbol.iterator, { value: function* () {
      for (const entry of iterate.call(watched)) { visits++; yield entry; }
    } });
    expect(cache.render(30, theme).join("\n")).toContain("body");
    expect(visits, "An unchanged subscription set must not scan for removed children").toBe(0);
    root.clear();
    expect(cache.render(30, theme)).toEqual([]);
    expect(child.invalidate).toBe(original);
    expect(visits).toBeGreaterThan(0);
  } finally { cache.dispose(); }
});

test("prunes an old observer when an unobservable child takes its place", () => {
  const child: Component = { render: () => ["first"], invalidate() {} };
  const original = child.invalidate;
  let renders = 0;
  const replacement = Object.freeze({ render: () => [String(++renders)], invalidate() {} });
  const root = new Container();
  root.addChild(child);
  const cache = new NativeRenderCache(root);
  const theme = {};
  try {
    cache.render(20, theme);
    root.children = [replacement];
    expect(cache.render(20, theme)).toEqual(["1"]);
    expect(child.invalidate).toBe(original);
    expect(cache.render(20, theme)).toEqual(["2"]);
  } finally { cache.dispose(); }
});
test("does not cache when rendering replaces an observed invalidate method", () => {
  let renders = 0;
  const replacement = (): void => {};
  const component: Component = {
    render() { this.invalidate = replacement; return [String(++renders)]; },
    invalidate() {},
  };
  const cache = new NativeRenderCache(component);
  const theme = {};
  expect(cache.render(20, theme)).toEqual(["1"]);
  expect(cache.render(20, theme)).toEqual(["2"]);
  cache.dispose();
  expect(component.invalidate).toBe(replacement);
});
test("never caches image protocol placement or components that cannot be observed", () => {
  let renders = 0;
  const image: Component = { render: () => { renders++; return ["\x1b_Ga=T;AAAA\x1b\\"]; }, invalidate() {} };
  const frozen = Object.freeze({ render: () => { renders++; return ["opaque"]; }, invalidate() {} });
  for (const component of [image, frozen]) {
    const cache = new NativeRenderCache(component);
    const theme = {};
    cache.render(20, theme);
    cache.render(20, theme);
    cache.dispose();
  }
  expect(renders).toBe(4);
});
