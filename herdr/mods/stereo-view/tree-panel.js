// LPT-1943: the GPUI side of the element tree. One TreeClient + TreeView per pane; `list()` returns a virtual list
// whose items are drawn from the local tree: wrapping, heights and scroll position are computed here, so a scroll or
// a resize never waits for Pi. Item kinds: user, md, think, tool, bash (native), rows (Pi's own rendered rows).
import { TreeClient } from "./tree-client.js";
import { TreeView } from "./tree-view.js";
import { wrapRows } from "./wrap.js";

/**
 * @param {{ div: any, h_flex: any, v_flex: any, v_virtual_list: any }} gpui
 * @param {{ spawnStream: any, target: (name: string) => ({ socket: string, on?: string } | null), parseAnsi?: (line: string) => any[] }} deps
 */
export function createTreePanels(gpui, deps) {
  const { div, v_flex, v_virtual_list } = gpui;
  /** @type {Map<string, any>} */
  const panes = new Map();

  function ensure(name, notify) {
    let entry = panes.get(name);
    if (entry) return entry;
    const target = deps.target(name);
    if (!target) return null;
    entry = { name, view: null, client: null, sizes: [], version: -1, lastTotal: 0, notify };
    const client = new TreeClient(deps.spawnStream, { ...target, pane: name }, {
      change: change => { entry.view.changed(change); entry.dirty = true; entry.notify?.(); },
      bodies: () => { entry.dirty = true; entry.notify?.(); },
      // A stream that ends stays as a dead entry: the old list draws and nothing retries in a loop.
      exit: (_code, why) => { entry.dead = true; if (why) entry.error = why; entry.notify?.(); },
      error: text => { entry.error = text; },
    });
    entry.client = client;
    entry.view = new TreeView(client, { viewport: 40, cols: 100 });
    client.start();
    panes.set(name, entry);
    return entry;
  }

  /** Text rows of one body part, as GPUI lines. */
  function lines(rows, ctx, color, opts = {}) {
    return rows.map(text => {
      let el = div().h(ctx.lineHeight).flex_none().whitespace_nowrap().font_family(ctx.font).text_size(ctx.fontSize)
        .line_height(`${ctx.lineHeight}px`).text_color(color).child(text || " ");
      if (opts.italic) el = el.italic();
      if (opts.bold) el = el.font_semibold();
      return el;
    });
  }

  function renderItem(entry, index, ctx) {
    const { view } = entry;
    const model = view.model, layout = view.layout;
    const item = model.items[index];
    const height = layout.heights[index] * ctx.lineHeight;
    const box = v_flex().w_full().h(height).flex_none().overflow_hidden().px(ctx.gutter);
    const body = model.bodies.get(item.id);
    const t = ctx.theme;
    if (item.k === "rows") {
      const fallback = layout.fallbackRows.get(item.id);
      for (const line of fallback?.lines ?? []) box.child(ctx.ansiRow ? ctx.ansiRow(line) : div().h(ctx.lineHeight).child(line));
      return box;
    }
    if (!body) {
      // Not loaded (a far jump): the start of its text stands in, clipped to the estimated height, until the body arrives.
      if (item.p) for (const el of lines(wrapRows(item.p, layout.cols), ctx, t.foreground)) box.child(el);
      return box;
    }
    const rows = layout.rowsOf(item, body).parts;
    if (item.k === "user") {
      box.bg(t.raised ?? t.background);
      box.child(div().h(ctx.lineHeight).flex_none());
      for (const el of lines(rows.t ?? [], ctx, t.foreground)) box.child(el);
      box.child(div().h(ctx.lineHeight).flex_none());
    } else if (item.k === "md") {
      for (const el of lines(rows.t ?? [], ctx, t.foreground)) box.child(el);
    } else if (item.k === "think") {
      for (const el of lines(["thinking"], ctx, t.muted, { bold: true })) box.child(el);
      for (const el of lines(rows.t ?? [], ctx, t.muted, { italic: true })) box.child(el);
    } else {
      // tool and bash: a header line with the name or "$", the call text, then the output.
      const title = item.k === "bash" ? "$ shell" : `${item.m?.name ?? "tool"}${item.m?.status && item.m.status !== "success" ? ` (${item.m.status})` : ""}`;
      for (const el of lines([title], ctx, t.accent ?? t.foreground, { bold: true })) box.child(el);
      for (const el of lines(rows.a ?? [], ctx, t.muted)) box.child(el);
      for (const el of lines(rows.o ?? [], ctx, t.foreground)) box.child(el);
    }
    return box;
  }

  return {
    /** Whether the pane's tree is in use (its stream exists); the old per-page polling stays off then. */
    active(name) { const entry = panes.get(name); return !!entry && !entry.dead; },
    /** True while a stream delivered something the next frame must draw, or heights/bodies are still settling. */
    wantsRender() {
      for (const entry of panes.values()) {
        if (entry.dead) continue;
        if (entry.dirty || !entry.view.model.ready || !entry.view.exact || !entry.view.complete) return true;
      }
      return false;
    },
    /** The tree view of a pane, for operations (scroll to, search) and the benchmark. */
    view(name) { return panes.get(name)?.view; },
    /** Time spent building the items of each visible range (ms), for the live frame check. */
    ranges(name) { return panes.get(name)?.rangeMs?.slice(-300) ?? []; },
    status(name) { const entry = panes.get(name); return entry ? { ready: entry.view.model.ready, items: entry.view.layout.count, totalRows: entry.view.layout.totalRows, dead: !!entry.dead, error: entry.error } : null; },
    close() { for (const entry of panes.values()) entry.client.close(); panes.clear(); },

    /**
     * The panel's list for pane `name`, or null when its tree is not available (the caller draws its old list).
     * @param {string} name @param {{ width: number, height: number, handle: any }} state
     * @param {{ theme: any, lineHeight: number, font: string, fontSize: number, gutter: number, notify: () => void, ansiRow?: (line: string) => any }} ctx
     */
    list(name, state, ctx) {
      const entry = ensure(name, ctx.notify);
      if (!entry || entry.dead || !entry.view.model.ready || !state.handle) return null;
      entry.notify = ctx.notify;
      entry.dirty = false;
      const { view } = entry;
      const lineHeight = ctx.lineHeight;
      // GPUI owns the scroll offset; the view follows it (rows from the handle), then plans around it.
      view.setViewport(Math.max(1, Math.floor(state.height / lineHeight)));
      if (state.width > 0) view.setCols(Math.max(10, state.width - 2));
      const placed = state.handle.content_size().height > 0;
      if (entry.bottomRequests > 0) entry.bottomRequests--;
      else if (placed && entry.settled) view.scrollTo(Math.round(state.handle.offset().y / lineHeight));
      if (placed) entry.settled = true;
      const frame = view.frame();
      // Heights settle and bodies arrive over several frames: the mod's tick asks for the next render (wantsRender).
      const layout = view.layout;
      if (entry.version !== layout.version || entry.sizes.length !== layout.count) {
        const sizes = new Array(layout.count);
        for (let i = 0; i < sizes.length; i++) sizes[i] = layout.heights[i] * lineHeight;
        entry.sizes = sizes;
        entry.version = layout.version;
      }
      if (view.following && (frame.total !== entry.lastTotal || !entry.settled)) { state.handle.scroll_to_bottom?.(); entry.bottomRequests = 2; }
      entry.lastTotal = frame.total;
      entry.frame = frame;
      const items = view.model.items;
      return v_virtual_list(`stereo-tree-${name}`, layout.count, entry.sizes, index => items[index]?.id ?? String(index),
        range => {
          const started = typeof performance !== "undefined" ? performance.now() : Date.now();
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(renderItem(entry, i, ctx));
          const spent = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
          (entry.rangeMs ??= []).push({ spent, items: range.end - range.start }); if (entry.rangeMs.length > 600) entry.rangeMs.splice(0, 300);
          return out;
        })
        .h(state.height).track_scroll(state.handle);
    },
  };
}
