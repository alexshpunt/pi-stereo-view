import { describe, expect, it } from "vitest";
import { TreeClient } from "../herdr/mods/stereo-view/tree-client.js";
import { TreeView } from "../herdr/mods/stereo-view/tree-view.js";
import { TreeSelection } from "../herdr/mods/stereo-view/tree-select.js";
import { TreeFind } from "../herdr/mods/stereo-view/tree-find.js";
import { TreeInteraction, autoScrollTarget } from "../herdr/mods/stereo-view/tree-interact.js";
import { caretAt, cellsBetween, lineRange, mergeMarks, rowOfOffset, rowSpans, wordRange } from "../herdr/mods/stereo-view/tree-text.js";
import { wrapRows } from "../herdr/mods/stereo-view/wrap.js";

type Body = { t?: string; a?: string; o?: string };
type Source = { id: string; k: string; body: Body; x?: number };

/** A view over a local tree of the given items, every height exact (as after a few frames). */
function build(sources: Source[], cols = 20, viewport = 10) {
  const hooks: Record<string, (change: unknown) => void> = {};
  const client = new TreeClient((() => ({})) as never, { socket: "unused", pane: "chat" }, hooks as never);
  const view = new TreeView(client, { viewport, cols });
  hooks.change = change => view.changed(change as never);
  const items = sources.map(source => {
    const text = Object.values(source.body).join("\n");
    return { id: source.id, k: source.k, n: text.split("\n").length, c: text.length, ...(source.x ? { x: source.x } : {}), b: source.body };
  });
  client.line(JSON.stringify({ t: "snap", pane: "chat", epoch: 1, rev: 1, total: items.length, at: 0, items, last: true }));
  for (let i = 0; i < view.layout.count; i++) view.layout.measure(i);
  return { client, view };
}

/** The point under a pointer; the tree is never empty in these tests. */
const pt = (select: TreeSelection, row: number, col: number) => select.pointAt(row, col)!;

/** Row of the pane where item `id` starts. */
const itemRow = (view: TreeView, id: string) => view.layout.prefix(view.model.indexOf(id));

describe("row spans", () => {
  const samples = ["", "hello", "aaa bbb ccc ddd", "a  b   c    d", "averyveryverylongwordwithoutspaces here", "世世世 mixed 世 width", "line one\nline two is a bit longer than the width\n\nlast", "crlf line\r\nsecond\r\n", "  leading and trailing  ", "x\ny"];
  it("gives one span per wrapped row, in order, covering the row's text", () => {
    for (const text of samples) for (const cols of [4, 7, 10, 20, 80]) {
      const rows = wrapRows(text, cols);
      const spans = rowSpans(text, cols);
      expect(spans.length / 2).toBe(rows.length);
      for (let k = 0; k < rows.length; k++) {
        expect(text.slice(spans[2 * k], spans[2 * k + 1]).replace(/\r$/, "")).toBe(rows[k]);
        if (k) expect(spans[2 * k]).toBeGreaterThanOrEqual(spans[2 * k - 1]);
      }
    }
  });

  it("keeps tabs in the source and counts them as four cells", () => {
    const text = "a\tb";
    const spans = rowSpans(text, 20);
    expect([spans[0], spans[1]]).toEqual([0, 3]);
    expect(cellsBetween(text, 0, 2)).toBe(5);
    expect(wrapRows(text, 20)).toEqual(["a    b"]);
  });

  it("maps a pointer column to the nearer side of the char under it, wide chars take two cells", () => {
    expect(caretAt("hello", 0, 5, 1.4)).toEqual({ off: 1, ch: 1 });
    expect(caretAt("hello", 0, 5, 1.6)).toEqual({ off: 2, ch: 1 });
    expect(caretAt("hello", 0, 5, 9)).toEqual({ off: 5, ch: 5 });
    expect(caretAt("hello", 0, 5, -3)).toEqual({ off: 0, ch: 0 });
    expect(caretAt("a世b", 0, 3, 1.8)).toEqual({ off: 1, ch: 1 }); // the left half of the wide char (cells 1..3)
    expect(caretAt("a世b", 0, 3, 2.2)).toEqual({ off: 2, ch: 1 }); // the right half
    expect(caretAt("a世b", 0, 3, 3.2)).toEqual({ off: 2, ch: 2 });
    expect(caretAt("a世b", 0, 3, 3.8)).toEqual({ off: 3, ch: 2 });
    expect(rowOfOffset(rowSpans("aaa bbb ccc", 4), 5)).toBe(1);
  });

  it("selects the word, a path, or the logical line for double and triple click", () => {
    const text = "run src/app.ts, then\nnext line";
    expect(wordRange(text, 6)).toEqual([4, 14]); // src/app.ts, without the comma
    expect(wordRange(text, 3)).toEqual([3, 4]); // the space
    expect(wordRange(text, 20)).toEqual([20, 20]); // the newline: nothing
    expect(lineRange(text, 8)).toEqual([0, 20]);
    expect(lineRange(text, 25)).toEqual([21, 30]);
  });
});

describe("selection across items", () => {
  const sources = (): Source[] => [
    { id: "u", k: "user", body: { t: "hello world foo" } },
    { id: "m", k: "md", body: { t: "line one\nline two" } },
    { id: "b", k: "bash", body: { a: "ls -la", o: "alpha\nbeta" } },
  ];

  it("copies the text between two points of different items, as the source text", () => {
    const { view } = build(sources());
    const select = new TreeSelection(view);
    const from = pt(select, itemRow(view, "u") + 1, 6.3); // first text row of the user item sits under one padding row
    const to = pt(select, itemRow(view, "m") + 1, 4.2);
    select.start(from);
    select.extend(to);
    expect(select.text()).toBe("world foo\n\nline one\nline");
  });

  it("selects backwards the same way and joins the call and the output of a tool", () => {
    const { view } = build(sources());
    const select = new TreeSelection(view);
    const end = pt(select, itemRow(view, "b") + 3, 3); // header, call, output row 0, output row 1 -> "beta"
    const begin = pt(select, itemRow(view, "b") + 1, 3);
    select.start(end);
    select.extend(begin);
    expect(select.text()).toBe("-la\nalpha\nbet");
  });

  it("does not turn a soft wrap into a line break", () => {
    const { view } = build([{ id: "u", k: "user", body: { t: "aaaa bbbb cccc" } }], 9);
    expect(wrapRows("aaaa bbbb cccc", 9)).toEqual(["aaaa bbbb", "cccc"]);
    const select = new TreeSelection(view);
    select.start(pt(select, 1, 0));
    select.extend(pt(select, 2, 10));
    expect(select.text()).toBe("aaaa bbbb cccc");
  });

  it("snaps to the text from the padding rows and past the last row", () => {
    const { view } = build(sources());
    const select = new TreeSelection(view);
    select.start(pt(select, 0, 5)); // the padding row above the user text
    select.extend(pt(select, view.layout.totalRows + 50, 0));
    expect(select.text()).toBe("hello world foo\n\nline one\nline two\n\nls -la\nalpha\nbeta");
  });

  it("selects a word on double click and a line on triple click, and grows by whole units while dragging", () => {
    const { view } = build(sources());
    const select = new TreeSelection(view);
    const row = itemRow(view, "u") + 1;
    select.start(pt(select, row, 7.2), "word");
    expect(select.text()).toBe("world");
    select.extend(pt(select, row, 13));
    expect(select.text()).toBe("world foo");
    select.extend(pt(select, row, 0.2));
    expect(select.text()).toBe("hello world");
    select.start(pt(select, itemRow(view, "m") + 1, 2), "line");
    expect(select.text()).toBe("line two");
  });

  it("shows nothing for a click without a drag", () => {
    const { view } = build(sources());
    const select = new TreeSelection(view);
    select.start(pt(select, itemRow(view, "u") + 1, 3));
    expect(select.range()).toBeUndefined();
    expect(select.text()).toBeUndefined();
  });

  it("draws marks per wrapped row in cells, whole rows in between and one cell for an empty line", () => {
    const { view } = build([{ id: "m", k: "md", body: { t: "alpha beta\n\ngamma delta" } }, { id: "n", k: "md", body: { t: "tail text" } }], 8);
    const select = new TreeSelection(view);
    // rows of "m" at 8 cols: "alpha", "beta", "", "gamma", "delta"
    select.start(pt(select, 1, 2));
    select.extend(pt(select, itemRow(view, "n"), 4));
    const item = view.model.items[0], body = view.model.bodies.get("m")!;
    const marks = select.marks(0, item, body, view.layout.rowsOf(item, body))!;
    expect(marks.t.map((row: unknown) => row && (row as { c0: number; c1: number }[]).map(m => [m.c0, m.c1]))).toEqual([undefined, [[2, 4]], [[0, 1]], [[0, 5]], [[0, 5]]]);
    const next = view.model.items[1], nextBody = view.model.bodies.get("n")!;
    expect(select.marks(1, next, nextBody, view.layout.rowsOf(next, nextBody))!.t).toEqual([[{ c0: 0, c1: 4, kind: "sel" }], undefined]); // "tail" / "text" at 8 cols: the selection ends after "tail"
  });

  it("outlives a resize, an expansion and a streamed append, and drops with a removed endpoint", () => {
    const { view, client } = build([{ id: "u", k: "user", body: { t: "hello world foo bar baz" } }, { id: "m", k: "md", body: { t: "one\ntwo" }, x: 3 }], 12);
    const select = new TreeSelection(view);
    select.start(pt(select, 1, 6));
    select.extend(pt(select, itemRow(view, "m"), 3)); // "one" is the first of the two lines shown, 3 more are hidden
    const before = select.text();
    expect(before).toBe("world foo bar baz\n\none");
    view.setCols(7);
    for (let i = 0; i < view.layout.count; i++) view.layout.measure(i);
    expect(select.text()).toBe(before);
    // the full body arrives: the folded one is its prefix, the selection still ends where it did
    client.model.storeBodies({ m: { t: "one\ntwo\nthree\nfour\nfive" } });
    view.layout.remeasure("m");
    expect(select.text()).toBe(before);
    // streaming appends to the last item: ids stay, the end of the selection stays
    client.line(JSON.stringify({ t: "delta", pane: "chat", epoch: 1, rev: 2, at: 1, remove: 1, items: [{ id: "m", k: "md", n: 6, c: 30, b: { t: "one\ntwo\nthree\nfour\nfive\nsix" } }] }));
    expect(select.text()).toBe(before);
    // the endpoint's item disappears
    client.line(JSON.stringify({ t: "delta", pane: "chat", epoch: 1, rev: 3, at: 1, remove: 1, items: [] }));
    expect(select.range()).toBeUndefined();
  });

  it("copies exactly what is shown: a folded item gives its shown lines, an expanded one its full text", () => {
    const { view, client } = build([{ id: "b", k: "bash", body: { a: "cat big", o: "l1\nl2" }, x: 98 }]);
    const select = new TreeSelection(view);
    select.start(pt(select, 0, 0));
    select.extend(pt(select, 50, 0));
    expect(select.text()).toBe("cat big\nl1\nl2");
    client.model.storeBodies({ b: { a: "cat big", o: "l1\nl2\nl3" } });
    view.layout.remeasure("b");
    select.start(pt(select, 0, 0));
    select.extend(pt(select, 50, 0));
    expect(select.text()).toBe("cat big\nl1\nl2\nl3");
  });

  it("skips Pi-rows items and items without text", () => {
    const { view } = build([{ id: "u", k: "user", body: { t: "first" } }, { id: "r", k: "rows", body: {} }, { id: "m", k: "md", body: { t: "last" } }]);
    const select = new TreeSelection(view);
    select.start(pt(select, 1, 0));
    select.extend(pt(select, view.layout.totalRows, 0));
    expect(select.text()).toBe("first\n\nlast");
  });
});

describe("cost per frame", () => {
  it("builds the marks of a screenful of items inside a selection over thousands of items in a few ms", () => {
    const sources: Source[] = Array.from({ length: 5000 }, (_, i) => ({ id: `i${i}`, k: "md", body: { t: `item ${i} needle\nsecond line of item ${i} with some more words to wrap around` } }));
    const { view } = build(sources, 40, 50);
    const ui = new TreeInteraction(view);
    ui.selection.start(ui.selection.pointAt(10, 3)!);
    ui.selection.extend(ui.selection.pointAt(view.layout.totalRows - 5, 3)!);
    ui.find.begin(); ui.find.setQuery("needle");
    while (ui.find.busy) ui.find.step(4);
    expect(ui.find.search.hits).toHaveLength(5000);
    const frame = () => {
      const started = performance.now();
      for (let i = 2000; i < 2030; i++) { const item = view.model.items[i], body = view.model.bodies.get(item.id)!; ui.marks(i, item, body, view.layout.rowsOf(item, body)); }
      return performance.now() - started;
    };
    frame(); // spans are built once per item and width
    expect(Math.min(frame(), frame(), frame())).toBeLessThan(4);
  });
});

describe("find", () => {
  const sources = (): Source[] => [
    { id: "u", k: "user", body: { t: "Find the needle here" } },
    { id: "m", k: "md", body: { t: "nothing\nsecond NEEDLE and a needle" } },
    { id: "b", k: "bash", body: { a: "grep needle", o: "x\nthe needle line" } },
  ];
  const run = (find: TreeFind, query: string) => { find.begin(); find.setQuery(query); for (let i = 0; i < 50 && find.busy; i++) find.step(4); };

  it("counts hits, starts at the first one and walks forward and back with wrap-around", () => {
    const { view } = build(sources());
    const find = new TreeFind(view);
    run(find, "needle");
    expect(find.state()).toMatchObject({ count: 5, current: 1, pending: false, error: undefined });
    expect(find.takeJump()).toMatchObject({ index: 0 });
    find.move(1); find.move(1);
    expect(find.state().current).toBe(3);
    expect(find.takeJump()).toMatchObject({ id: "m", key: "t" });
    find.move(-1); find.move(-1); find.move(-1);
    expect(find.state().current).toBe(5);
    expect(find.takeJump()).toMatchObject({ id: "b", key: "o" });
    find.move(1);
    expect(find.state().current).toBe(1);
  });

  it("starts at the first hit at or after the item on screen", () => {
    const { view } = build(sources());
    view.toItem(1);
    const find = new TreeFind(view);
    run(find, "needle");
    expect(find.takeJump()).toMatchObject({ id: "m" });
  });

  it("says when there is nothing and when the query is empty", () => {
    const { view } = build(sources());
    const find = new TreeFind(view);
    run(find, "zzz");
    expect(find.state()).toMatchObject({ count: 0, current: 0, error: "No results" });
    expect(find.move(1)).toBe(false);
    run(find, "");
    expect(find.state()).toMatchObject({ count: 0, pending: false, error: undefined });
  });

  it("maps a hit to the item, the part, the row inside the item and the column", () => {
    const { view } = build(sources());
    const find = new TreeFind(view);
    run(find, "needle");
    const hits = find.search.hits;
    // user: one padding row, then "Find the needle here" (20 cols: one row) -> column 9
    expect(find.target(hits[0])).toMatchObject({ index: 0, key: "t", row: 0, rowInItem: 1, col: 9 });
    // md second line "second NEEDLE and a needle" wraps at 20: "second NEEDLE and a" / "needle"
    expect(find.target(hits[2])).toMatchObject({ index: 1, key: "t", row: 2, rowInItem: 2, col: 0 });
    // bash: header, call row, then the output rows: "x", "the needle line"
    expect(find.target(hits[3])).toMatchObject({ index: 2, key: "a", row: 0, rowInItem: 1, col: 5 });
    expect(find.target(hits[4])).toMatchObject({ index: 2, key: "o", row: 1, rowInItem: 3, col: 4 });
  });

  it("highlights hits in the rows drawn, the current one differently, also across a soft wrap", () => {
    const { view } = build([{ id: "m", k: "md", body: { t: "aa needle aa\nxx need le" } }], 9);
    const find = new TreeFind(view);
    run(find, "needle");
    const item = view.model.items[0], body = view.model.bodies.get("m")!;
    const marks = find.marks(0, item, body, view.layout.rowsOf(item, body))!;
    expect(marks.t[0]).toEqual([{ c0: 3, c1: 9, kind: "cur" }]);
    expect(find.search.hits).toHaveLength(1);
    run(find, "need le");
    const wrapped = find.marks(0, item, body, view.layout.rowsOf(item, body))!;
    expect(wrapRows(body.t!, 9)).toEqual(["aa needle", "aa", "xx need", "le"]);
    expect(wrapped.t[2]).toEqual([{ c0: 3, c1: 7, kind: "cur" }]);
    expect(wrapped.t[3]).toEqual([{ c0: 0, c1: 2, kind: "cur" }]);
  });

  it("rebuilds after the bodies change, keeps the current hit, and never jumps by itself", () => {
    const { view, client } = build(sources());
    const find = new TreeFind(view);
    run(find, "needle");
    find.move(1); find.move(1); // third hit
    find.takeJump();
    client.line(JSON.stringify({ t: "delta", pane: "chat", epoch: 1, rev: 2, at: 0, remove: 1, items: [{ id: "u", k: "user", n: 1, c: 30, b: { t: "needle needle Find the needle here" } }] }));
    find.changed(1000);
    expect(find.busy).toBe(true);
    find.step(4, 1100); // not quiet yet: the old results stay
    expect(find.search.hits).toHaveLength(5);
    for (let i = 0; i < 20 && find.busy; i++) find.step(4, 2000);
    expect(find.search.hits).toHaveLength(7);
    expect(find.state().current).toBeGreaterThan(0);
    expect(find.search.hits[find.current].id).toBe("m"); // still on the md item's hit
    expect(find.takeJump()).toBeNull();
  });
});

describe("pointer gestures", () => {
  const sources = (): Source[] => [
    { id: "u", k: "user", body: { t: "hello world foo" } },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, k: "md", body: { t: `item ${i} text\nsecond line ${i}` } })),
  ];
  function rig(viewportRows = 10) {
    const { view } = build(sources(), 30, viewportRows);
    const ui = new TreeInteraction(view);
    ui.metrics = { lineHeight: 20, cellWidth: 10, textLeft: 8 };
    const timers: ((cx: unknown) => void)[] = [];
    const scrolls: number[] = [];
    const written: string[] = [];
    let top = 0;
    const handle = { offset: () => ({ x: 0, y: top }), viewport_size: () => ({ width: 400, height: viewportRows * 20 }), scroll_to_item: (i: number) => { scrolls.push(i); } };
    const state = { handle, height: viewportRows * 20 };
    const cx: { notified: number; notify(): void; timer: { after(ms: number, cb: (cx: unknown) => void): void }; write_to_clipboard(text: string): void } = {
      notified: 0, notify() { this.notified++; }, timer: { after: (_ms, cb) => { timers.push(cb); } }, write_to_clipboard: text => { written.push(text); },
    };
    return { view, ui, state, cx, timers, scrolls, written, setTop: (value: number) => { top = value; } };
  }

  it("drags a selection over rows, copies it and clears with a plain click", () => {
    const r = rig();
    // y = 20 px is pane row 1 (the first text row of the user item); x = 8 + 6.3 cells * 10
    expect(r.ui.down(r.state, { x: 71, y: 25, count: 1, shift: false }, r.cx)).toBe(true);
    expect(r.ui.dragging).toBe(true);
    r.ui.move(r.state, { x: 200, y: 25 + 2 * 20, pressed: true }, r.cx); // two rows lower: item m0's first text row (rows 0-2 are the user item)
    expect(r.ui.hasSelection).toBe(true);
    expect(r.ui.copy(r.cx)).toBe(true);
    expect(r.written[0]).toBe("world foo\n\nitem 0 text");
    r.ui.up();
    expect(r.ui.dragging).toBe(false);
    expect(r.ui.hasSelection).toBe(true);
    r.ui.down(r.state, { x: 40, y: 25, count: 1, shift: false }, r.cx);
    r.ui.up();
    expect(r.ui.hasSelection).toBe(false);
    expect(r.ui.copy(r.cx)).toBe(false);
  });

  it("selects a word on double click and ignores presses on the scrollbar lane", () => {
    const r = rig();
    r.ui.down(r.state, { x: 8 + 7 * 10, y: 25, count: 2, shift: false }, r.cx);
    r.ui.up();
    r.ui.copy(r.cx);
    expect(r.written).toEqual(["world"]);
    expect(r.ui.down(r.state, { x: 390, y: 25, count: 1, shift: false, maxX: 386 }, r.cx)).toBe(false);
  });

  it("ends the gesture when the button was released outside the window", () => {
    const r = rig();
    r.ui.down(r.state, { x: 71, y: 25, count: 1, shift: false }, r.cx);
    expect(r.ui.move(r.state, { x: 90, y: 45, pressed: false }, r.cx)).toBe(false);
    expect(r.ui.dragging).toBe(false);
  });

  it("scrolls by item on a timer while the pointer is past the bottom edge and keeps extending", () => {
    const r = rig();
    r.ui.down(r.state, { x: 71, y: 25, count: 1, shift: false }, r.cx);
    r.ui.move(r.state, { x: 100, y: 10 * 20 + 30, pressed: true }, r.cx); // below the list
    expect(r.timers).toHaveLength(1);
    r.setTop(0);
    r.timers.shift()!(r.cx);
    expect(r.scrolls).toEqual([1]); // the item after the top one
    expect(r.timers).toHaveLength(1); // armed again while the pointer stays out
    r.setTop(r.view.layout.prefix(1) * 20);
    r.timers.shift()!(r.cx);
    expect(r.scrolls).toEqual([1, 2]);
    r.ui.move(r.state, { x: 100, y: 100, pressed: true }, r.cx); // back inside: no more scrolling
    r.timers.shift()?.(r.cx);
    expect(r.scrolls).toEqual([1, 2]);
  });

  it("picks the item to scroll to: up reveals the rest of the top item, then the one above", () => {
    const { view } = build(sources(), 30);
    const top = view.layout.prefix(5);
    expect(autoScrollTarget(view.layout, top + 1, -1)).toBe(5);
    expect(autoScrollTarget(view.layout, top, -1)).toBe(4);
    expect(autoScrollTarget(view.layout, 0, -1)).toBe(0);
    expect(autoScrollTarget(view.layout, top, 1)).toBe(6);
    expect(autoScrollTarget(view.layout, view.layout.totalRows - 1, 1)).toBe(view.layout.count - 1);
  });

  it("opens the find bar's actions, reports its state and closes", () => {
    const r = rig();
    const states: { count: number; current: number }[] = [];
    let closed = 0;
    const actions = r.ui.findActions({ state: s => states.push(s), closed: () => { closed++; } });
    actions.query("item 1", r.cx);
    for (let i = 0; i < 20 && r.ui.busy; i++) r.ui.frame();
    expect(states.at(-1)).toMatchObject({ count: 11, current: 1 });
    actions.next(r.cx);
    expect(states.at(-1)!.current).toBe(2);
    expect(r.ui.frame()).toMatchObject({ index: expect.any(Number) });
    actions.close(r.cx);
    expect(closed).toBe(1);
    expect(r.ui.find.open).toBe(false);
    // the highlights are gone after closing
    const item = r.view.model.items[2], body = r.view.model.bodies.get(item.id)!;
    expect(r.ui.marks(2, item, body, r.view.layout.rowsOf(item, body))).toBeNull();
  });

  it("merges selection and find marks of one row, the selection drawn last", () => {
    expect(mergeMarks({ t: [[{ c0: 0, c1: 2, kind: "hit" }]] }, { t: [[{ c0: 1, c1: 3, kind: "sel" }], [{ c0: 0, c1: 1, kind: "sel" }]] })).toEqual({
      t: [[{ c0: 0, c1: 2, kind: "hit" }, { c0: 1, c1: 3, kind: "sel" }], [{ c0: 0, c1: 1, kind: "sel" }]],
    });
    expect(mergeMarks(null, null)).toBeNull();
  });
});
