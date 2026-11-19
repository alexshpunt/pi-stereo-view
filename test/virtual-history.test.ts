import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeDocument, type DocumentViewport } from "../src/native.ts";
import { CompactMessage, TranscriptTimestamps } from "../src/timestamps.ts";
import type { SearchHit } from "../src/search.ts";

class UserMessageComponent extends Text {
  renders = 0;
  delay = 0;
  clicks: number[] = [];
  override render(width: number): string[] {
    this.renders++;
    const until = performance.now() + this.delay;
    while (performance.now() < until) { /* simulate an expensive native renderer */ }
    return super.render(width);
  }
  handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
    if (event.type !== "press") return undefined;
    this.clicks.push(event.y);
    return { handled: true };
  }
}

const colors = { fg: (_name: string, value: string) => value, style: (value: string) => value } as unknown as Theme;

function history(count: number) {
  const users = Array.from({ length: count }, (_, index) => new UserMessageComponent("MSG " + index, 0, 0));
  const chat = new Container();
  for (const user of users) chat.addChild(user);
  const source = new Container();
  source.addChild(new Container());
  source.addChild(new Container());
  source.addChild(chat);
  const timestamps = new TranscriptTimestamps({
    buildContextEntries: () => [], getBranch: () => [],
  } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "chat", timestamps, () => colors, () => 0, () => false);
  let viewport: DocumentViewport | undefined;
  let requested = 0;
  document.setViewport(() => viewport, () => requested++);
  const frame = (width = 40): string[] => {
    timestamps.beginFrame();
    document.beginFrame();
    return document.render(width);
  };
  // Native render caches hide repeated renders; count entries the document prepares instead.
  const prepared = new Map<Component, number>();
  const spied = new WeakSet<object>();
  const reset = (): void => {
    for (const user of users) user.renders = 0;
    prepared.clear();
    for (const child of document.children) {
      if (!(child instanceof CompactMessage) || spied.has(child)) continue;
      spied.add(child);
      const owner = Reflect.get(child, "component") as Component;
      const prepare = child.prepare;
      child.prepare = (width, separate) => {
        prepared.set(owner, (prepared.get(owner) ?? 0) + 1);
        return prepare.call(child, width, separate);
      };
    }
  };
  const rendered = (): number[] => users.flatMap((user, index) => prepared.has(user) || user.renders ? [index] : []);
  return {
    users, document, frame, reset, rendered, requests: () => requested,
    view(value: DocumentViewport | undefined) { viewport = value; },
  };
}

/** Row where an entry's text starts in the document. */
const rowOf = (lines: string[], text: string): number => lines.findIndex(line => line.trimEnd() === text);

test("without a viewport every entry renders each frame", () => {
  const { frame, reset, rendered } = history(50);
  frame();
  reset();
  frame();
  expect(rendered()).toHaveLength(50);
});

test("renders only entries near the viewport and reuses offscreen rows", () => {
  const { frame, reset, rendered, view } = history(200);
  const full = frame();
  // Each message is one row plus a separator row.
  expect(full.length).toBe(399);
  view({ top: 200, height: 20, following: false });
  reset();
  const lines = frame();
  expect(lines).toEqual(full);
  const shown = rendered();
  // The 20-row viewport plus half a viewport on each side: about 20 two-row entries.
  expect(shown.length).toBeGreaterThan(15);
  expect(shown.length).toBeLessThan(30);
  expect(Math.min(...shown)).toBeGreaterThanOrEqual(90);
  expect(Math.max(...shown)).toBeLessThanOrEqual(120);
});

test("a following panel renders only the end of a long history", () => {
  const { frame, reset, rendered, view } = history(1000);
  frame();
  view({ top: 0, height: 30, following: true });
  reset();
  frame();
  const shown = rendered();
  expect(shown.length).toBeLessThan(40);
  expect(Math.min(...shown)).toBeGreaterThan(950);
});

test("an offscreen entry that changes renders again and keeps the rows in view in place", () => {
  const { frame, users, view, document } = history(200);
  frame();
  view({ top: 300, height: 20, following: false });
  frame();
  users[10].setText("CHANGED\nSECOND\nTHIRD");
  users[10].invalidate();
  const lines = frame();
  expect(lines).toContain("CHANGED" + " ".repeat(33));
  // The changed entry grew by two rows above the viewport.
  expect(document.takeScrollShift()).toBe(2);
  expect(document.takeScrollShift()).toBe(0);
});

test("offscreen native changes without invalidation are found by the rotating check", () => {
  const { frame, users, view } = history(200);
  frame();
  view({ top: 0, height: 20, following: false });
  frame();
  // Native setters can change shell inputs and text without invalidating, as tool updates do.
  users[150].setText("SWEPT");
  Reflect.set(users[150], "expanded", true);
  let lines = frame();
  for (let pass = 0; pass < 5 && !lines.some(line => line.startsWith("SWEPT")); pass++) lines = frame();
  expect(lines.some(line => line.startsWith("SWEPT"))).toBe(true);
});

test("growth below the viewport does not shift the panel", () => {
  const { frame, users, view, document } = history(200);
  frame();
  view({ top: 0, height: 20, following: false });
  frame();
  users[150].setText("A\nB\nC");
  users[150].invalidate();
  frame();
  expect(document.takeScrollShift()).toBe(0);
});

test("after a width change offscreen entries are measured lazily within a frame budget", async () => {
  const { frame, users, reset, rendered, view, requests } = history(300);
  frame(40);
  for (const user of users) user.delay = 0.2;
  view({ top: 0, height: 20, following: false });
  reset();
  const first = frame(30);
  // 4 ms of 0.2 ms renders plus the window, far from all 300.
  expect(rendered().length).toBeLessThan(80);
  expect(first.length).toBe(599);
  await new Promise(resolve => setImmediate(resolve));
  expect(requests()).toBe(1);
  // Each follow-up frame measures another batch until nothing is left.
  let lines = first;
  let frames = 0;
  for (let seen = requests(); frames < 100; frames++) {
    lines = frame(30);
    await new Promise(resolve => setImmediate(resolve));
    if (requests() === seen) break;
    seen = requests();
  }
  expect(frames).toBeGreaterThan(2);
  expect(rendered()).toHaveLength(300);
  for (const user of users) user.delay = 0;
  view(undefined);
  const settled = frame(30);
  expect(lines).toEqual(settled);
});

test("search keeps every entry rendered so matches can be located", () => {
  const { frame, users, reset, rendered, view, document } = history(200);
  frame();
  view({ top: 0, height: 20, following: false });
  frame();
  const entry = { source: users[150], label: "User", text: "MSG 150" };
  const hit: SearchHit = { entry, text: "MSG 150", line: 0, occurrence: 0 } as unknown as SearchHit;
  expect(document.reveal(hit, "MSG 150")).toBe(true);
  reset();
  const lines = frame();
  expect(rendered()).toHaveLength(200);
  expect(document.searchRow(hit)).toBe(rowOf(lines, "MSG 150"));
  document.clearSearch();
  reset();
  frame();
  expect(rendered().length).toBeLessThan(40);
});

test("mouse events reach an entry far outside the rendered window", () => {
  const { frame, users, view, document } = history(200);
  const lines = frame();
  view({ top: 0, height: 20, following: false });
  frame();
  const row = rowOf(lines, "MSG 180");
  document.handleMouse({ type: "press", button: "left", x: 1, y: row, screenX: 1, screenY: 5, width: 40, height: lines.length,
    shift: false, alt: false, ctrl: false });
  expect(users[180].clicks).toEqual([0]);
});

test("settings and theme changes re-render offscreen entries over the next frames", () => {
  const { frame, users, reset, rendered, view, document } = history(100);
  frame();
  view({ top: 0, height: 10, following: false });
  frame();
  document.invalidate();
  const measured = new Set<number>();
  for (let pass = 0; pass < 50 && measured.size < 100; pass++) {
    reset();
    frame();
    for (const index of rendered()) measured.add(index);
  }
  expect(measured.size).toBe(100);
  reset();
  frame();
  expect(rendered().length).toBeLessThan(20);
  expect(users[99].renders).toBe(0);
});
