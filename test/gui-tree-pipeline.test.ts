import { describe, expect, it } from "vitest";
import { GuiTree } from "../src/gui-tree.ts";
import { TreeClient } from "../herdr/mods/stereo-view/tree-client.js";
import { TreeModel } from "../herdr/mods/stereo-view/tree-model.js";
import { TreeLayout } from "../herdr/mods/stereo-view/tree-layout.js";
import { TreeView } from "../herdr/mods/stereo-view/tree-view.js";
import { TreeSearch } from "../herdr/mods/stereo-view/tree-search.js";
import { cellWidth, wrapRows } from "../herdr/mods/stereo-view/wrap.js";
import { styleMarkdown } from "../herdr/mods/stereo-view/md-style.js";

class UserMessageComponent { constructor(public text: string) {} render() { return [this.text]; } }
class BashExecutionComponent { constructor(public command: string, public outputLines: string[]) {} render() { return ["$ " + this.command]; } }

/** A native index with the surface GuiTree reads: entries() and beginFrame(). */
function fakeIndex(sources: object[]) {
  const entries = sources.map(source => ({
    source, owner: source, component: source, spacing: [], compact: false,
    kind: source instanceof BashExecutionComponent ? "shell" : "dialogue",
    search: () => ({}),
  }));
  return { beginFrame() {}, entries: () => entries, set(next: object[]) { sources = next; } } as never;
}
/** Pi's tree and the mod's client joined by an in-memory stream, in the shape of herdr-app's `spawnStream`. */
function connect(tree: GuiTree, pane: "chat" | "activity" = "chat") {
  const stream = tree.open(pane);
  const lines: ((line: string) => void)[] = [];
  const out = (messages: unknown) => { for (const message of Array.isArray(messages) ? messages : [messages]) lines.forEach(cb => cb(JSON.stringify(message))); };
  const spawnStream = () => ({
    onLine: (cb: (line: string) => void) => lines.push(cb), onExit: () => {}, kill: () => {},
    write: (line: string) => {
      const request = JSON.parse(line);
      if (request.op === "get") out(stream.bodies(request.rq, request.ids, request.full !== false));
      else if (request.op === "counterpart") out(stream.counterpart(request.rq, request.id));
      else if (request.op === "rows") out(stream.rows(request.rq, request.id, request.width));
      else if (request.op === "resync") out(stream.snapshot());
    },
  });
  const client = new TreeClient(spawnStream, { socket: "unused", pane });
  client.start();
  out(stream.snapshot());
  return { client, push: () => { const delta = stream.delta(); if (delta) out(delta); return delta; } };
}

describe("wrap", () => {
  it("wraps at words, breaks long words, counts wide characters as two cells", () => {
    expect(wrapRows("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapRows("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(cellWidth("世".codePointAt(0)!)).toBe(2);
    expect(wrapRows("世世世", 4)).toEqual(["世世", "世"]);
    expect(wrapRows("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
});

describe("tree pipeline", () => {
  const sources = () => [new UserMessageComponent("hello\nworld"), new BashExecutionComponent("ls", ["a", "b", "c"]), new UserMessageComponent("x".repeat(250))];

  it("sends headers and tail bodies, then loads the rest on request", async () => {
    const index = fakeIndex(sources());
    const tree = new GuiTree(() => index);
    const { client } = connect(tree);
    expect(client.model.ready).toBe(true);
    expect(client.model.items.map(item => item.k)).toEqual(["user", "bash", "user"]);
    expect(client.model.items[1]).toMatchObject({ n: 4, c: 7 });
    expect(JSON.stringify(client.model.items)).not.toContain("selection");
    const loaded = await client.get(client.model.items.map(item => item.id));
    expect(loaded).toHaveLength(3);
    expect(client.model.body(1)).toEqual({ a: "ls", o: "a\nb\nc" });
  });

  it("strips colour and link escapes from item text", async () => {
    const index = fakeIndex([new UserMessageComponent("\u001b[38;2;1;2;3mUpdate\u001b[0m \u001b]8;;https://x.y\u0007link\u001b]8;;\u0007 ok")]);
    const { client } = connect(new GuiTree(() => index));
    await client.get(client.model.items.map(item => item.id));
    expect(client.model.body(0)).toEqual({ t: "Update link ok" });
  });

  it("applies a streaming change as one splice and keeps ids stable", () => {
    const list = sources();
    const index = fakeIndex(list);
    const tree = new GuiTree(() => index);
    const { client, push } = connect(tree);
    const ids = client.model.items.map(item => item.id);
    (list[2] as UserMessageComponent).text += " more";
    expect(push()).toMatchObject([{ t: "delta", at: 2, remove: 1 }]);
    expect(client.model.items.map(item => item.id)).toEqual(ids);
    expect(client.model.items[2]!.c).toBe(255);
    expect(client.model.body(2)).toEqual({ t: "x".repeat(250) + " more" });
    expect(push()).toBeUndefined();
  });

  it("resyncs after a gap and ignores stale deltas", () => {
    const model = new TreeModel();
    model.apply({ t: "snap", pane: "chat", epoch: 1, rev: 1, total: 1, at: 0, items: [{ id: "a", k: "md", n: 1, c: 1, b: { t: "a" } }], last: true });
    expect(model.apply({ t: "delta", pane: "chat", epoch: 1, rev: 1, at: 0, remove: 0, items: [] })).toMatchObject({ kind: "ignored" });
    expect(model.apply({ t: "delta", pane: "chat", epoch: 2, rev: 5, at: 0, remove: 0, items: [] })).toMatchObject({ resync: true });
    model.apply({ t: "delta", pane: "chat", epoch: 1, rev: 2, at: 1, remove: 0, items: [{ id: "b", k: "md", n: 1, c: 1, b: { t: "b" } }] });
    expect(model.items.map(item => item.id)).toEqual(["a", "b"]);
    expect(model.indexOf("b")).toBe(1);
  });
});

describe("layout, view and search", () => {
  const model = new TreeModel();
  const count = 2000;
  model.apply({ t: "snap", pane: "chat", epoch: 1, rev: 1, total: count, at: 0, last: true,
    items: Array.from({ length: count }, (_, i) => ({ id: `i${i}`, k: "md", n: 3, c: 30, b: { t: `item ${i}\nsecond line\nthird` } })) });

  it("locates rows through prefix sums and keeps the anchored item while heights change", () => {
    const layout = new TreeLayout(model);
    layout.rebuild(80);
    expect(layout.locate(layout.prefix(500) + 1)).toEqual({ index: 500, offset: 1 });
    const before = layout.prefix(900);
    layout.setHeight(10, layout.heights[10] + 5);
    expect(layout.prefix(900)).toBe(before + 5);
  });

  it("measures visible items, scrolls without gaps and re-wraps on a width change", () => {
    const client = { model, closed: true, get: () => Promise.resolve([]), rows: () => Promise.resolve([]) };
    const view = new TreeView(client as never, { viewport: 30, cols: 80 });
    view.changed({ kind: "snapshot", at: 0, removed: 0, inserted: count, last: true });
    expect(view.frame().pending).toEqual([]);
    view.scrollTo(1234);
    const frame = view.frame();
    expect(frame.window.length).toBeGreaterThan(0);
    expect(frame.pending).toEqual([]);
    const anchored = view.anchor.index;
    view.setCols(10);
    expect(view.anchor.index).toBe(anchored);
    expect(view.frame().pending).toEqual([]);
  });

  it("folds big items on the wire, expands to the full body and folds back", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const index = fakeIndex([new BashExecutionComponent(big.slice(0, 40), big.split("\n")), ...Array.from({ length: 20 }, (_, i) => new UserMessageComponent(`hi ${i}`))]); // the last 16 items are the tail and are never folded
    const tree = new GuiTree(() => index, () => 80);
    const { client } = connect(tree);
    const model = client.model;
    const item = model.items.find(entry => entry.k === "bash")!;
    expect(item.x).toBeGreaterThan(300);
    expect(model.isFolded(item)).toBe(true);
    expect(model.bodies.get(item.id)!.o!.split("\n").length).toBeLessThanOrEqual(10);
    const view = new TreeView(client, { viewport: 10, cols: 40 });
    view.changed({ kind: "snapshot", at: 0, removed: 0, inserted: model.items.length, last: true });
    view.layout.remeasure(item.id); // the exact folded height, not the estimate
    const folded = view.layout.heights[model.indexOf(item.id)];
    const expanded = await view.expand(item.id);
    expect(expanded).toBe(true);
    expect(model.isFolded(item)).toBe(false);
    expect(view.layout.heights[model.indexOf(item.id)]).toBeGreaterThan(folded);
    expect(view.fold(item.id)).toBe(true);
    expect(view.layout.heights[model.indexOf(item.id)]).toBe(folded);
  });

  it("styles markdown rows line by line, carrying the code fence down", () => {
    const styled = styleMarkdown(["# Title", "text", "```ts", "# not a heading", "```", "> quote", "---", "### small"]);
    expect(styled.map(row => row.style)).toEqual(["h1", "plain", "fence", "code", "fence", "quote", "rule", "h3"]);
  });

  it("searches in slices", () => {
    const search = new TreeSearch(model);
    search.start("ITEM 77");
    while (!search.done) search.step(1);
    expect(search.hits.map(hit => hit.id)).toContain("i77");
  });
});
