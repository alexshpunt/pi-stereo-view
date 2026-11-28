import { stripVTControlCharacters } from "node:util";
import { Text, type Component } from "@earendil-works/pi-tui";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { GuiOverlays } from "../src/gui-overlays.ts";

class Overlay extends Text {
  clicks = 0;
  inputs: string[] = [];
  handleInput(data: string) { this.inputs.push(data); }
  handleMouse(event: any) { if (event.type === "click") this.clicks++; return { handled: true }; }
}

test("uses Pi's actual overlay placement, visibility and focus order", () => {
  const terminal = { columns: 80, rows: 24, hideCursor() {}, write() {} };
  const tui = new TuiAltScreen(terminal as any);
  const first = new Overlay("first", 0, 0), second = new Overlay("second", 0, 0);
  const firstHandle = tui.showOverlay(first, { width: 20, row: 3, col: 5, nonCapturing: true });
  tui.showOverlay(second, { width: 10, row: 7, col: 9 });
  const host = tui as any;
  host.compositeOverlays([], 80, 24);
  const projected = new GuiOverlays(host);
  const page = projected.page();
  expect(page.overlays.map(layer => [layer.row, layer.col, layer.width, stripVTControlCharacters(layer.lines[0]).trim(), layer.focused])).toEqual([
    [3, 5, 20, "first", false], [7, 9, 10, "second", true],
  ]);
  firstHandle.setHidden(true);
  expect(projected.key(page.revision, page.overlays[1].id, page.overlays[1].frame, "a")).toBe(false);
  host.compositeOverlays([], 80, 24);
  expect(projected.page().overlays.map(layer => stripVTControlCharacters(layer.lines[0]).trim())).toEqual(["second"]);
  projected.dispose();
});

test("projects all visible overlay layers in Pi's order and native coordinates", () => {
  const a = new Overlay("first", 0, 0), b = new Overlay("second", 0, 0);
  const ea = { component: a }, eb = { component: b };
  const layouts = [
    { entry: ea, row: 2, col: 3, width: 20, height: 1 },
    { entry: eb, row: 4, col: 7, width: 12, height: 1 },
  ];
  const host = { terminal: { columns: 80, rows: 24 }, renderedOverlayLayouts: layouts,
    getFocusedComponent: (): Component => b, requestRender() {}, setFocus(_component: Component) {} };
  const surface = new GuiOverlays(host);
  const page = surface.page();
  expect(page.overlays.map(o => [o.row, o.col, o.width, o.height, o.lines[0].trim(), o.focused])).toEqual([
    [2, 3, 20, 1, "first", false], [4, 7, 12, 1, "second", true],
  ]);
  expect(surface.key(page.revision, page.overlays[1].id, page.overlays[1].frame, "x")).toBe(true);
  expect(b.inputs).toEqual(["x"]);
  expect(surface.key(page.revision, page.overlays[0].id, page.overlays[0].frame, "x")).toBe(false);
  layouts.reverse();
  expect(surface.key(page.revision, page.overlays[1].id, page.overlays[1].frame, "y")).toBe(false);
  expect(surface.page().overlays.map(o => o.lines[0].trim())).toEqual(["second", "first"]);
});

test("renders an overlay narrower than a dialog and keeps a drag through an unchanged poll", () => {
  const widget = new Overlay("x", 0, 0), editor = new Overlay("editor", 0, 0);
  const host = { terminal: { columns: 80, rows: 24 },
    renderedOverlayLayouts: [{ entry: { component: widget }, row: 2, col: 4, width: 1, height: 1 }],
    getFocusedComponent: (): Component => editor, requestRender() {}, setFocus(_component: Component) {} };
  const surface = new GuiOverlays(host), page = surface.page(), item = page.overlays[0];
  expect(item.width).toBe(1);
  const press = { type: "press" as const, button: "left" as const, x: 0, y: 0 };
  expect(surface.mouse(page.revision, item.id, item.mouseFrame, press)).toBe(true);
  expect(surface.page().overlays[0].mouseFrame).toBe(item.mouseFrame);
  expect(surface.mouse(page.revision, item.id, item.mouseFrame, { ...press, type: "release" })).toBe(true);
  expect(widget.clicks).toBe(1);
});

test("routes clicks to a non-capturing overlay and rejects obscured and stale targets", () => {
  const a = new Overlay("first", 0, 0), b = new Overlay("second", 0, 0), editor = new Overlay("editor", 0, 0);
  const layouts = [
    { entry: { component: a }, row: 1, col: 1, width: 20, height: 1 },
    { entry: { component: b }, row: 1, col: 10, width: 10, height: 1 },
  ];
  const host = { terminal: { columns: 80, rows: 24 }, renderedOverlayLayouts: layouts,
    getFocusedComponent: (): Component => editor, requestRender() {}, setFocus(_component: Component) {} };
  const surface = new GuiOverlays(host), page = surface.page(), first = page.overlays[0];
  const event = { type: "press" as const, button: "left" as const, x: 1, y: 0 };
  expect(surface.mouse(page.revision, first.id, first.mouseFrame, { ...event, x: 10 })).toBe(false);
  expect(surface.mouse(page.revision, first.id, first.mouseFrame, event)).toBe(true);
  expect(surface.mouse(page.revision, first.id, first.mouseFrame, { ...event, type: "release" })).toBe(true);
  expect(a.clicks).toBe(1);
  layouts[0].col = 2;
  expect(surface.mouse(page.revision, first.id, first.mouseFrame, event)).toBe(false);
});

test("only the topmost overlay receives hover and wheel", () => {
  const events: string[] = [];
  const a = new Overlay("first", 0, 0), b = new Overlay("second", 0, 0), editor = new Overlay("editor", 0, 0);
  a.handleMouse = event => { events.push(`a:${event.type}`); return { handled: true }; };
  b.handleMouse = event => { events.push(`b:${event.type}`); return { handled: true }; };
  const layouts = [
    { entry: { component: a }, row: 1, col: 1, width: 20, height: 1 },
    { entry: { component: b }, row: 1, col: 10, width: 10, height: 1 },
  ];
  const host = { terminal: { columns: 80, rows: 24 }, renderedOverlayLayouts: layouts,
    getFocusedComponent: (): Component => editor, requestRender() {}, setFocus(_component: Component) {} };
  const surface = new GuiOverlays(host), page = surface.page(), first = page.overlays[0], second = page.overlays[1];
  const move = { type: "move", button: "none", x: 10, y: 0 } as any;
  const wheel = { type: "wheel", button: "none", x: 1, y: 0, wheelDelta: -2 } as any;
  expect(surface.mouse(page.revision, first.id, first.mouseFrame, move)).toBe(false);
  expect(surface.mouse(page.revision, second.id, second.mouseFrame, wheel)).toBe(true);
  expect(events).toEqual(["b:wheel"]);
});

test("keeps a captured drag when the pointer crosses another overlay", () => {
  const events: string[] = [];
  const a = new Overlay("first", 0, 0), b = new Overlay("second", 0, 0), editor = new Overlay("editor", 0, 0);
  a.handleMouse = event => { events.push(event.type); return { handled: true }; };
  const layouts = [
    { entry: { component: a }, row: 1, col: 1, width: 20, height: 1 },
    { entry: { component: b }, row: 1, col: 10, width: 10, height: 1 },
  ];
  const host = { terminal: { columns: 80, rows: 24 }, renderedOverlayLayouts: layouts,
    getFocusedComponent: (): Component => editor, requestRender() {}, setFocus(_component: Component) {} };
  const surface = new GuiOverlays(host), page = surface.page(), first = page.overlays[0];
  const event = { type: "press" as const, button: "left" as const, x: 1, y: 0 };
  expect(surface.mouse(page.revision, first.id, first.mouseFrame, event)).toBe(true);
  expect(surface.mouse(page.revision, first.id, first.mouseFrame, { ...event, type: "drag", x: 10 })).toBe(true);
  expect(surface.mouse(page.revision, first.id, first.mouseFrame, { ...event, type: "release", x: 10 })).toBe(true);
  expect(events).toEqual(["press", "drag", "release"]);
});
test("projects focus only inside a visible overlay that takes keys", () => {
  const keyed = new Overlay("keyed", 0, 0);
  const inert = new Text("inert", 0, 0);
  const hidden = new Overlay("hidden", 0, 0);
  const layouts = [
    { entry: { component: keyed }, row: 1, col: 1, width: 10, height: 1 },
    { entry: { component: inert }, row: 2, col: 1, width: 10, height: 1 },
  ];
  const host = { terminal: { columns: 80, rows: 24 }, renderedOverlayLayouts: layouts,
    getFocusedComponent: (): Component => keyed, requestRender() {}, setFocus(_component: Component) {} };
  const surface = new GuiOverlays(host);
  expect(surface.projects(keyed)).toBe(true);
  expect(surface.projects(inert)).toBe(false);
  expect(surface.projects(hidden)).toBe(false);
  surface.dispose();
  expect(surface.projects(keyed)).toBe(false);
});
