import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { GuiSurface } from "../src/gui-surface.ts";

test("restores terminal mouse geometry after borrowing a different GUI width", () => {
  class Geometry extends Dialog {
    width = 0;
    override render(width: number): string[] { this.width = width; return ["click"]; }
    handleMouse(): { handled: boolean } { return { handled: true }; }
  }
  const dialog = new Geometry("click", 0, 0);
  dialog.render(100);
  const surface = new GuiSurface(() => dialog, () => dialog, () => {}, () => {}, false, () => 100);
  const page = surface.page(40);
  expect(dialog.width).toBe(100);
  expect(surface.mouse(page.mouseFrame, { type: "press", button: "left", x: 1, y: 0 })).toBe(true);
  expect(dialog.width).toBe(100);
});

test("restores terminal geometry even if GUI rendering fails", () => {
  class Geometry extends Dialog {
    width = 0;
    override render(width: number): string[] {
      this.width = width;
      if (width === 40) throw new Error("render failure");
      return ["ok"];
    }
  }
  const dialog = new Geometry("x", 0, 0);
  const surface = new GuiSurface(() => dialog, () => dialog, () => {}, () => {}, false, () => 100);
  expect(() => surface.page(40)).toThrow();
  expect(dialog.width).toBe(100);
});

test("routes a widget click while the editor owns keyboard focus", () => {
  class Widget extends Text {
    clicks = 0;
    handleMouse(event: any) { if (event.type === "click") this.clicks++; return { handled: true }; }
  }
  const widget = new Widget("action", 0, 0), editor = new Dialog("editor", 0, 0);
  const surface = new GuiSurface(() => widget, () => editor, () => {}, () => {}, true);
  const page = surface.page(40);
  expect(surface.key(page.frame, "a")).toBe(false);
  expect(surface.mouse(page.mouseFrame, { type: "press", button: "left", x: 1, y: 0 })).toBe(true);
  expect(surface.mouse(page.mouseFrame, { type: "release", button: "left", x: 1, y: 0 })).toBe(true);
  expect(widget.clicks).toBe(1);
});

test("delivers wheel and hover with modifiers to the live surface", () => {
  class Widget extends Text {
    events: any[] = [];
    handleMouse(event: any) { this.events.push(event); return { handled: true }; }
  }
  const widget = new Widget("action", 0, 0), editor = new Dialog("editor", 0, 0);
  const surface = new GuiSurface(() => widget, () => editor, () => {}, () => {}, true);
  const page = surface.page(40);
  expect(surface.mouse(page.mouseFrame, { type: "move", button: "none", x: 1, y: 0, shift: true } as any)).toBe(true);
  expect(surface.mouse(page.mouseFrame, { type: "wheel", button: "none", x: 1, y: 0, wheelDelta: -3, ctrl: true } as any)).toBe(true);
  expect(widget.events.map(({ type, button, wheelDelta, shift, ctrl }) => ({ type, button, wheelDelta, shift, ctrl }))).toEqual([
    { type: "move", button: "none", wheelDelta: undefined, shift: true, ctrl: false },
    { type: "wheel", button: "none", wheelDelta: -3, shift: false, ctrl: true },
  ]);
  widget.setText("updated");
  expect(surface.mouse(page.mouseFrame, { type: "move", button: "none", x: 1, y: 0 } as any)).toBe(false);
});

test("routes a right-button gesture and preserves its click count without accepting mismatched releases", () => {
  class Widget extends Text {
    events: any[] = [];
    handleMouse(event: any) { this.events.push(event); return { handled: true, capture: true }; }
  }
  const widget = new Widget("action", 0, 0), editor = new Dialog("editor", 0, 0);
  const surface = new GuiSurface(() => widget, () => editor, () => {}, () => {}, true);
  const frame = surface.page(40).mouseFrame;
  expect(surface.mouse(frame, { type: "press", button: "right", x: 1, y: 0, clickCount: 2 } as any)).toBe(true);
  expect(surface.mouse(frame, { type: "release", button: "left", x: 1, y: 0 } as any)).toBe(false);
  expect(surface.mouse(frame, { type: "release", button: "right", x: 1, y: 0 } as any)).toBe(true);
  expect(widget.events.map(({ type, button, clickCount }) => ({ type, button, clickCount }))).toEqual([
    { type: "press", button: "right", clickCount: 2 },
    { type: "release", button: "right", clickCount: undefined },
    { type: "click", button: "right", clickCount: 2 },
  ]);
});

test("keeps button captures independent and never clicks a cancelled or dragged gesture", () => {
  class Widget extends Text {
    events: any[] = [];
    handleMouse(event: any) { this.events.push([event.type, event.button]); return { handled: true, capture: true }; }
  }
  const widget = new Widget("action", 0, 0), editor = new Dialog("editor", 0, 0);
  const surface = new GuiSurface(() => widget, () => editor, () => {}, () => {}, true);
  const frame = surface.page(40).mouseFrame;
  expect(surface.mouse(frame, { type: "press", button: "left", x: 0, y: 0 })).toBe(true);
  expect(surface.mouse(frame, { type: "press", button: "right", x: 1, y: 0 })).toBe(true);
  expect(surface.mouse(frame, { type: "drag", button: "left", x: 1, y: 0 })).toBe(true);
  expect(surface.mouse(frame, { type: "release", button: "right", x: 1, y: 0, cancel: true })).toBe(true);
  expect(surface.mouse(frame, { type: "release", button: "left", x: 1, y: 0 })).toBe(true);
  expect(widget.events).toEqual([["press", "left"], ["press", "right"], ["drag", "left"], ["release", "right"], ["release", "left"]]);
});

test("delivers captured drag coordinates beyond the painted surface", () => {
  class Widget extends Text {
    events: any[] = [];
    handleMouse(event: any) { this.events.push(event); return { handled: true, capture: true }; }
  }
  const widget = new Widget("action", 0, 0), editor = new Dialog("editor", 0, 0);
  const surface = new GuiSurface(() => widget, () => editor, () => {}, () => {}, true);
  const frame = surface.page(40).mouseFrame;
  expect(surface.mouse(frame, { type: "press", button: "left", x: 1, y: 0 })).toBe(true);
  expect(surface.mouse(frame, { type: "drag", button: "left", x: -3, y: 9 })).toBe(true);
  expect(surface.mouse(frame, { type: "release", button: "left", x: -3, y: 9, cancel: true })).toBe(true);
  expect(widget.events.map(event => [event.type, event.x, event.y])).toEqual([["press", 1, 0], ["drag", -3, 9], ["release", -3, 9]]);
});

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

test("routes a click only to the unchanged live dialog", () => {
  class Clickable extends Dialog {
    clicks = 0;
    handleMouse(event: any) {
      if (event.type === "click") this.clicks++;
      return { handled: true, capture: event.type === "press" };
    }
  }
  const dialog = new Clickable("choice", 0, 0);
  const surface = new GuiSurface(() => dialog, () => dialog);
  const page = surface.page(40);
  expect(surface.mouse(page.mouseFrame, { type: "press", button: "left", x: 1, y: 0 })).toBe(true);
  expect(surface.mouse(page.mouseFrame, { type: "release", button: "left", x: 1, y: 0 })).toBe(true);
  expect(dialog.clicks).toBe(1);
  expect(surface.mouse(page.mouseFrame, { type: "release", button: "left", x: 1, y: 0 })).toBe(false);
  expect(surface.mouse(page.mouseFrame, { type: "press", button: "left", x: 1, y: 0 })).toBe(true);
  expect(surface.mouse(page.mouseFrame, { type: "release", button: "left", x: 1, y: 0, cancel: true })).toBe(true);
  expect(dialog.clicks).toBe(1);
});

test("rejects a widget replaced by a different component with identical text", () => {
  class Widget extends Text {
    clicks = 0;
    handleMouse(event: any) { if (event.type === "click") this.clicks++; return { handled: true }; }
  }
  const first = new Widget("action", 0, 0), second = new Widget("action", 0, 0);
  const root = new Container(); root.addChild(first);
  const editor = new Dialog("editor", 0, 0);
  const surface = new GuiSurface(() => root, () => editor, () => {}, () => {}, true);
  const page = surface.page(40);
  root.clear(); root.addChild(second);
  expect(surface.mouse(page.mouseFrame, { type: "press", button: "left", x: 0, y: 0 })).toBe(false);
  expect(second.clicks).toBe(0);
  expect(surface.page(40).mouseFrame).not.toBe(page.mouseFrame);
});
test("rejects a pointer from an older surface even when dialog focus is unchanged", () => {
  const dialog = new Dialog("initial", 0, 0);
  const surface = new GuiSurface(() => dialog, () => dialog);
  const old = surface.page(40);
  dialog.setText("changed");
  const updated = surface.page(40);
  expect(updated.frame).toBe(old.frame);
  expect(updated.mouseFrame).not.toBe(old.mouseFrame);
  expect(surface.mouse(old.mouseFrame, { type: "press", button: "left", x: 0, y: 0 })).toBe(false);
});

test("delivers a bounded complete bracketed paste as one input", () => {
  const dialog = new Dialog("input", 0, 0);
  const surface = new GuiSurface(() => dialog, () => dialog);
  const frame = surface.page(40).frame;
  const value = "😀".repeat(800);
  expect(surface.key(frame, `\x1b[200~${value}\x1b[201~`)).toBe(true);
  expect(dialog.inputs).toEqual([`\x1b[200~${value}\x1b[201~`]);
  expect(surface.key(frame, `\x1b[200~abc\x1b[A\x1b[201~`)).toBe(false);
  expect(surface.key(frame, `\x1b[200~${"x".repeat(1024 * 1024 + 1)}\x1b[201~`)).toBe(false);
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
