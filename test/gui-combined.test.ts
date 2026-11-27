import { Container, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { GuiCombinedDocument } from "../src/gui-combined.ts";

class WidthSensitive implements Component {
  width = 0;
  events: Array<{ type: string; width: number }> = [];
  constructor(private readonly wraps: boolean) {}
  render(width: number): string[] {
    this.width = width;
    return this.wraps && width < 20 ? ["first", "second"] : ["single"];
  }
  invalidate(): void {}
  handleMouse(event: TuiMouseEvent) {
    this.events.push({ type: event.type, width: this.width });
    return { handled: true, capture: event.type === "press" };
  }
}

function mouse(y: number): TuiMouseEvent {
  return { type: "press", button: "left", x: 0, y, screenX: 0, screenY: y, width: 10, height: 3,
    shift: false, alt: false, ctrl: false };
}

test("renders the original combined history at GUI width and restores the terminal width", () => {
  const source = new Container(), first = new WidthSensitive(true), second = new WidthSensitive(false);
  source.addChild(first); source.addChild(second);
  source.render(30);
  const combined = new GuiCombinedDocument(source, () => 30);
  combined.beginFrame();
  expect(combined.render(10)).toEqual(["first", "second", "single"]);
  expect(first.width).toBe(30);
  expect(second.width).toBe(30);
  expect(source.render(30)).toEqual(["single", "single"]);
  combined.dispose();
  expect(source.children).toEqual([first, second]);
});

test("routes a captured mouse gesture using GUI geometry after the terminal repaints", () => {
  const source = new Container(), first = new WidthSensitive(true), second = new WidthSensitive(false);
  source.addChild(first); source.addChild(second);
  const combined = new GuiCombinedDocument(source, () => 30);
  combined.render(10);
  source.render(30);
  const hit = combined.handleMouse(mouse(2));
  expect(hit?.target).toBeDefined();
  expect(first.events).toEqual([]);
  expect(second.events).toEqual([{ type: "press", width: 10 }]);
  expect(second.width).toBe(30);
  hit!.target.component.handleMouse!({ ...mouse(2), type: "release", y: 0, height: 1 });
  expect(second.events).toEqual([{ type: "press", width: 10 }, { type: "release", width: 10 }]);
  expect(second.width).toBe(30);
  combined.dispose();
});

test("restores terminal geometry even when a native handler throws", () => {
  class Throwing extends WidthSensitive {
    override handleMouse(event: TuiMouseEvent): ReturnType<WidthSensitive["handleMouse"]> {
      super.handleMouse(event);
      throw new Error("test failure");
    }
  }
  const source = new Container(), item = new Throwing(false);
  source.addChild(item);
  const combined = new GuiCombinedDocument(source, () => 30);
  combined.render(10);
  expect(() => combined.handleMouse({ ...mouse(0), height: 1 })).toThrow();
  expect(item.width).toBe(30);
  combined.dispose();
});
