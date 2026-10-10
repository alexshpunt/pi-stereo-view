import { Container, Text, type Component } from "@earendil-works/pi-tui";
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
