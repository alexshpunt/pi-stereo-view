import { HStack, MouseRegion, ScrollView, stripTerminalSequences, VStack, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { activeBackground, SplitSurface } from "../src/surface.ts";

const surfaces: SplitSurface[] = [];
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose(); });

function lines(count: number, prefix: string, fill = false): Component {
  return { render: width => Array.from({ length: count }, (_, row) => {
    const text = `${prefix}${row}`;
    return fill ? `\x1b[48;5;22m${text.padEnd(width)}\x1b[49m` : text;
  }), invalidate() {} };
}

// Pi's selection commands are prototype methods; the surface adds and removes own wrappers.
class FakeHost {
  terminal = { rows: 10, columns: 40 };
  requestRender = vi.fn();
  copyTextToClipboard = vi.fn(async (_text: string) => true);
  getCopyOnSelect(): boolean { return true; }
  hasActiveSelection(): boolean { return false; }
  async copyActiveSelectionToClipboard(): Promise<boolean> { return false; }
  resetTextSelection(): void {}
}

function host(): FakeHost & TUI {
  return new FakeHost() as unknown as FakeHost & TUI;
}

function surface(tui: TUI, model: Component, options: { height?: number; fill?: boolean; active?: () => ScrollView | undefined } = {}): SplitSurface {
  const created = new SplitSurface(tui, {
    model: () => ({ component: model, fill: options.fill ?? true, minSize: 1 }),
    height: () => options.height ?? 6,
    active: options.active ?? (() => undefined),
  });
  surfaces.push(created);
  return created;
}

function mouse(type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return { type, button: type === "wheel" ? "none" : "left", x, y, screenX: x, screenY: y + 1, width: 40, height: 6,
    shift: false, alt: false, ctrl: false, ...extra };
}

test("joins panel rows at their allocated columns without the native compositor", () => {
  const left = lines(3, "L");
  const right = lines(2, "R");
  const columns = new HStack([{ component: left, basis: 10, shrink: 0 }, { component: lines(6, "|"), basis: 1, shrink: 0 },
    { component: right, basis: 0, grow: 1 }]);
  const output = surface(host(), columns).render(30);
  expect(output).toHaveLength(6);
  expect(output.map(stripTerminalSequences)).toEqual([
    "L0        |R0" + " ".repeat(17),
    "L1        |R1" + " ".repeat(17),
    "L2        |",
    " ".repeat(10) + "|",
    " ".repeat(10) + "|",
    " ".repeat(10) + "|",
  ]);
});

test("sizes content-height splits to their content within the available rows", () => {
  const rows = new VStack([lines(2, "a"), lines(1, "b")]);
  expect(surface(host(), rows, { fill: false, height: 8 }).render(20)).toHaveLength(3);
  expect(surface(host(), rows, { fill: false, height: 2 }).render(20)).toHaveLength(2);
});

test("scrolls panels and draws their scrollbars over the row background", () => {
  const view = new ScrollView(lines(20, "row", true), { follow: "end", scrollbar: "auto" });
  const pane = new VStack([{ component: lines(1, "head"), basis: 1, shrink: 0 }, { component: view, basis: 0, grow: 1 }]);
  const split = surface(host(), new HStack([{ component: pane, basis: 0, grow: 1 }]));
  let output = split.render(20);
  expect(view.viewportHeight).toBe(5);
  expect(view.scrollTop).toBe(15);
  expect(stripTerminalSequences(output[5]).trimEnd()).toBe("row19");
  view.scrollBy(-3);
  output = split.render(20);
  expect(stripTerminalSequences(output[1]).trimEnd().startsWith("row12")).toBe(true);
  // The transient auto scrollbar replaces the last panel cell and keeps that row's fill color.
  const cell = stripTerminalSequences(output[1]).at(19);
  expect(["│", "┃", "█"]).toContain(cell);
  expect(output[1]).toMatch(/\x1b\[48;5;22m(?:\x1b\[[0-9;]*m)*[│┃█]/);
});

test("routes mouse events to nested components with exact capture targets", () => {
  const handler = vi.fn(() => ({ capture: true }));
  const button = new MouseRegion(lines(1, "button"), handler);
  const columns = new HStack([{ component: lines(6, "x"), basis: 5, shrink: 0 }, { component: button, basis: 0, grow: 1 }]);
  const split = surface(host(), columns);
  split.render(20);
  const result = split.handleMouse(mouse("press", 7, 0));
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ x: 2, y: 0, width: 15, height: 6 }));
  expect(result?.target).toMatchObject({ component: button, originX: 5, originY: 1, width: 15, height: 6 });
});

test("selects panel text across scrolled rows and exposes it through Pi's selection commands", async () => {
  const tui = host();
  const view = new ScrollView(lines(20, "line"), { follow: "end" });
  const split = surface(tui, new VStack([{ component: view, basis: 0, grow: 1 }]));
  split.render(20);
  view.scrollTo(2);
  split.render(20);
  expect(split.handleMouse(mouse("press", 0, 0))?.capture).toBe(true);
  split.handleMouse(mouse("drag", 2, 1));
  const output = split.render(20);
  expect(output[0]).toContain("\x1b[7m");
  expect(tui.hasActiveSelection()).toBe(true);
  split.handleMouse(mouse("release", 2, 1));
  expect(tui.copyTextToClipboard).toHaveBeenCalledWith("line2\nlin");
  tui.resetTextSelection();
  expect(tui.hasActiveSelection()).toBe(false);
});

test("wheel scrolls the panel under the pointer and the proxy follows the active panel", () => {
  const first = new ScrollView(lines(30, "a"), { follow: "end", overscroll: "contain" });
  const second = new ScrollView(lines(30, "b"), { follow: "end", overscroll: "contain" });
  const columns = new HStack([{ component: first, basis: 10, shrink: 0 }, { component: second, basis: 0, grow: 1 }]);
  const split = surface(host(), columns, { active: () => second });
  split.render(30);
  split.handleMouse(mouse("wheel", 2, 2, { wheelDelta: -3 }));
  expect(first.scrollTop).toBe(21);
  expect(second.scrollTop).toBe(24);
  split.proxy.scrollBy(-4);
  expect(second.scrollTop).toBe(20);
  expect(split.proxy.isFollowingEnd).toBe(false);
  split.proxy.scrollToEnd();
  expect(second.isFollowingEnd).toBe(true);
});

test("restores Pi's selection commands on dispose", () => {
  const tui = host();
  const original = tui.hasActiveSelection;
  const split = surface(tui, lines(2, "x"));
  expect(tui.hasActiveSelection).not.toBe(original);
  split.dispose();
  expect(Object.hasOwn(tui, "hasActiveSelection")).toBe(false);
});

test("tracks the active background of a styled prefix", () => {
  expect(activeBackground("\x1b[48;2;1;2;3mabc")).toBe("\x1b[48;2;1;2;3m");
  expect(activeBackground("\x1b[41mabc\x1b[0m")).toBe("");
  expect(activeBackground("\x1b[38;5;3;48;5;9mx")).toBe("\x1b[48;5;9m");
});

test("reports a panel error while painting or routing the mouse instead of throwing into Pi's render loop", () => {
  const failed = vi.fn();
  let broken = false;
  const panel: Component = {
    render: width => { if (broken) throw new Error("PAINT"); return ["ok".padEnd(width)]; },
    handleMouse: () => { throw new Error("MOUSE"); },
    invalidate() {},
  } as Component;
  const split = new SplitSurface(host(), {
    model: () => ({ component: panel, fill: true, minSize: 1 }), height: () => 2, active: () => undefined, failed,
  });
  surfaces.push(split);
  split.render(10);
  expect(split.handleMouse(mouse("press", 1, 0))).toBeUndefined();
  expect(failed).toHaveBeenLastCalledWith(expect.objectContaining({ message: "MOUSE" }));
  broken = true;
  expect(split.render(10)).toEqual([]);
  expect(failed).toHaveBeenLastCalledWith(expect.objectContaining({ message: "PAINT" }));
});
