import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { GuiDocuments } from "../src/gui-documents.ts";
import { NativeDocument } from "../src/native.ts";
import { TranscriptTimestamps } from "../src/timestamps.ts";

class UserMessageComponent extends Text {
  events: TuiMouseEvent[] = [];
  handleMouse(event: TuiMouseEvent) {
    this.events.push(event);
    return { handled: true, capture: event.type === "press" };
  }
}

function setup() {
  const item = new UserMessageComponent("hello", 0, 0);
  const history = new Container(); history.addChild(item);
  const source = new Container(); source.addChild(new Container()); source.addChild(new Container()); source.addChild(history);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const theme = { fg: (_name: string, value: string) => value } as Theme;
  const chat = new NativeDocument(source, "chat", timestamps, () => theme, () => 0, () => false);
  const activity = new NativeDocument(source, "activity", timestamps, () => theme, () => 0, () => false);
  const gui = new GuiDocuments({ chat, activity }, () => timestamps.beginFrame());
  return { gui, item, history };
}

test("following requests include the latest rows even when output grows before the reply", () => {
  const { gui, history } = setup();
  for (let i = 0; i < 20; i++) history.addChild(new UserMessageComponent(`message ${i}`, 0, 0));
  const page = gui.page("chat", { width: 30, top: 0, height: 5, following: true });
  expect(page.top).toBe(page.total - page.height);
  expect(page.lines.join("\n")).toContain("message 19");
});

test("exposes a jump to the target row in the GUI pane's own geometry", () => {
  const { gui, history } = setup();
  for (let i = 0; i < 15; i++) history.addChild(new UserMessageComponent(`message ${i}`, 0, 0));
  const target = new UserMessageComponent("jump destination", 0, 0);
  history.addChild(target);
  gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  gui.requestJump("chat", target);
  const page = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  expect(page.jump?.top).toBeGreaterThan(0);
  const destination = gui.page("chat", { width: 30, top: page.jump!.top, height: 5, following: false });
  expect(destination.lines.join("\n")).toContain("jump destination");
  expect(destination.jump).toEqual(page.jump);
});

test("projects native documents into bounded independent row viewports", () => {
  const { gui } = setup();
  const chat = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  expect(chat.lines.join("\n")).toContain("hello");
  const row = chat.lines.findIndex(line => line.includes("hello"));
  expect(chat.selection[row].cells.map(cell => cell.text).join("")).toContain("hello");
  expect(chat.lines.length).toBeLessThanOrEqual(5);
  const activity = gui.page("activity", { width: 20, top: 0, height: 3, following: false });
  expect(activity.lines.join("\n")).not.toContain("hello");
  expect(() => gui.page("chat", { width: 1000, top: 0, height: 5, following: false })).toThrow();
  expect(() => gui.page("chat", { width: 30, top: 0, height: 1000, following: false })).toThrow();
  gui.dispose();
});

test("routes a complete click to the rendered native component and rejects stale frames", () => {
  const { gui, item } = setup();
  const frame = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  const row = frame.lines.findIndex(line => line.includes("hello"));
  expect(row).toBeGreaterThanOrEqual(0);
  expect(gui.mouse("chat", frame.frame, { type: "press", button: "left", x: 0, y: row })).toBe(true);
  expect(gui.mouse("chat", frame.frame, { type: "release", button: "left", x: 0, y: row, clickCount: 2 })).toBe(true);
  expect(item.events.map(event => event.type)).toEqual(["press", "release", "click"]);
  expect(item.events[2]?.clickCount).toBe(2);
  expect(gui.mouse("chat", frame.frame, { type: "press", button: "left", x: 0, y: row })).toBe(false);
  const old = frame.frame;
  gui.page("chat", { width: 30, top: 1, height: 5, following: false });
  expect(gui.mouse("chat", old, { type: "press", button: "left", x: 0, y: row })).toBe(false);
  expect(item.events).toHaveLength(3);
  gui.dispose();
});

test("releasing a captured pointer outside a pane ends the gesture without clicking", () => {
  const { gui, item } = setup();
  const frame = gui.page("chat", { width: 30, top: 0, height: 5, following: false });
  const row = frame.lines.findIndex(line => line.includes("hello"));
  expect(gui.mouse("chat", frame.frame, { type: "press", button: "left", x: 0, y: row })).toBe(true);
  expect(gui.mouse("chat", frame.frame, { type: "release", button: "left", x: -1, y: row })).toBe(true);
  expect(item.events.map(event => event.type)).toEqual(["press", "release"]);
  gui.dispose();
});
