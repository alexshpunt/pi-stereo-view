import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { GuiSurface } from "../src/gui-surface.ts";

class Dialog extends Text {
  inputs: string[] = [];
  handleInput(data: string): void { this.inputs.push(data); }
}

test("shows the live dialog and forwards keys only while its owner keeps focus", () => {
  const first = new Dialog("hello", 0, 0);
  const slot = new Container(); slot.addChild(first);
  let current: Component | undefined = slot;
  let focus: Component | null = first;
  let renders = 0;
  const surface = new GuiSurface(() => current, () => focus, () => renders++);
  const page = surface.page(40);
  expect(page.active).toBe(true);
  expect(page.lines.join("\n")).toContain("hello");
  expect(surface.key(page.frame, "a")).toBe(true);
  expect(surface.page(40).frame).toBe(page.frame);
  expect(surface.key(page.frame, "b")).toBe(true);
  const resized = surface.page(41);
  expect(resized.frame).not.toBe(page.frame);
  expect(surface.key(page.frame, "c")).toBe(false);
  expect(first.inputs).toEqual(["a", "b"]);
  expect(renders).toBeGreaterThan(0);
  focus = new Dialog("elsewhere", 0, 0);
  expect(surface.key(resized.frame, "b")).toBe(false);
  current = undefined;
  expect(surface.key(resized.frame, "c")).toBe(false);
  expect(surface.page(40).active).toBe(false);
  expect(first.inputs).toEqual(["a", "b"]);
});

test("rejects old frames after a dialog is replaced and bounds incoming data", () => {
  const first = new Dialog("first", 0, 0), second = new Dialog("second", 0, 0);
  let current: Component | undefined = first;
  let focus: Component | null = first;
  const surface = new GuiSurface(() => current, () => focus);
  const old = surface.page(40);
  current = second; focus = second;
  expect(surface.key(old.frame, "x")).toBe(false);
  const now = surface.page(40);
  expect(now.frame).not.toBe(old.frame);
  expect(surface.key(now.frame, "x".repeat(1025))).toBe(false);
  expect(surface.key(now.frame, "\0")).toBe(false);
  expect(surface.key(now.frame, "x")).toBe(true);
  expect(second.inputs).toEqual(["x"]);
});
