// LPT-1943: the GPUI side of the element tree. One TreeClient + TreeView per pane; `list()` returns a virtual list
// whose items are drawn from the local tree: wrapping, heights and scroll position are computed here, so a scroll or
// a resize never waits for Pi. Item kinds: user, md, think, tool, bash (native), rows (Pi's own rendered rows).
import { TreeClient } from "./tree-client.js";
import { TreeView } from "./tree-view.js";
import { styleMarkdown } from "./md-style.js";

/**
 * @param {{ div: any, h_flex: any, v_flex: any, v_virtual_list: any }} gpui
 * @param {{ spawnStream: any, target: (name: string) => ({ socket: string, on?: string } | null), parseAnsi?: (line: string) => any[] }} deps
 */
export function createTreePanels(gpui, deps) {
  const { div, h_flex, v_flex, v_virtual_list } = gpui;
  const COPIED_MS = 1500;
  /** @type {Map<string, any>} */
  const panes = new Map();

  function ensure(name, notify) {
    let entry = panes.get(name);
    if (entry) return entry;
    const target = deps.target(name);
    if (!target) return null;
    entry = { name, view: null, client: null, sizes: [], version: -1, lastTotal: 0, notify };
    const client = new TreeClient(deps.spawnStream, { ...target, on: target.on ?? target.machine, pane: name }, {
      change: change => { entry.view.changed(change); entry.dirty = true; entry.notify?.(); },
      bodies: () => { entry.dirty = true; entry.notify?.(); },
      // A stream that ends stays as a dead entry: the old list draws and nothing retries in a loop.
      exit: (code, why) => { entry.dead = true; entry.error = `exit ${code ?? "?"}${why ? `: ${why}` : ""}`; entry.notify?.(); },
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

  /** Text of one item as the user would paste it: the source text, not the wrapped rows. */
  function itemText(body) {
    if (!body) return "";
    return body.t ?? [body.a, body.o].filter(Boolean).join("\n");
  }

  /** Copy one item's full text; a folded item fetches its full body first. */
  function copyItem(entry, item, cx, ctx) {
    const done = text => {
      entry.copied = { id: item.id, at: Date.now() };
      ctx.notify();
      cx.timer?.after?.(COPIED_MS, next => next.notify());
      return text;
    };
    cx.spawn(async next => {
      const text = itemText(await entry.view.fullBody(item.id));
      if (text) next.write_to_clipboard(done(text));
    });
  }

  /** Go to: Pi names the element of the other pane at the same point; that pane scrolls to it locally. */
  function goTo(entry, item, ctx) {
    entry.client.counterpart(item.id).then(found => {
      const other = found && panes.get(found.pane);
      if (!other?.view.model.ready) return;
      ctx.beforeGoTo?.(found.pane);
      other.jump = found.id;
      other.notify?.();
      ctx.notify();
    });
  }

  /** One small icon button of the floating bar. */
  function iconButton(ctx, item, which, label, icon, active, onClick) {
    const t = ctx.theme;
    return h_flex().id(`stereo-tree-${which}-${item.id}`).accessibility_label(label).tooltip(label)
      .items_center().justify_center().w(22).h(22).rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => onClick(cx))
      .child(ctx.svg(`mods/stereo-view/icons/${icon}.svg`).id(`stereo-tree-${which}-icon-${item.id}`).size(14)
        .text_color(active ? t.accent ?? t.foreground : t.foreground));
  }

  /** Expand/fold, Go to and Copy of one item. */
  function buildBar(entry, item, ctx) {
    const t = ctx.theme;
    const copied = entry.copied?.id === item.id && Date.now() - entry.copied.at < COPIED_MS;
    const model = entry.view.model;
    const bar = h_flex().id(`stereo-tree-bar-${item.id}`).items_center().gap(2).p(2).rounded(6).bg(t.raised ?? t.surface).border_1().border_color(t.border);
    if (item.x) {
      const folded = model.isFolded(item);
      bar.child(iconButton(ctx, item, "expand", folded ? `Show ${item.x} more lines` : "Fold", folded ? "full" : "compact", false,
        () => { if (folded) entry.view.expand(item.id).then(() => ctx.notify()); else { entry.view.fold(item.id); ctx.notify(); } }));
    }
    bar.child(iconButton(ctx, item, "goto", "Go to the same point in the other panel", "go-to", false, () => goTo(entry, item, ctx)));
    bar.child(iconButton(ctx, item, "copy", copied ? "Copied" : "Copy this item", copied ? "check" : "copy", copied, cx => copyItem(entry, item, cx, ctx)));
    return bar;
  }

  function renderItem(entry, index, ctx) {
    const { view } = entry;
    const model = view.model, layout = view.layout;
    const item = model.items[index];
    const height = layout.heights[index] * ctx.lineHeight;
    const box = v_flex().id(`stereo-tree-${entry.name}-${item.id}`).relative().w_full().h(height).flex_none().overflow_hidden().px(ctx.gutter);
    const body = model.bodies.get(item.id);
    const t = ctx.theme;
    if (item.k === "rows") {
      const fallback = layout.fallbackRows.get(item.id);
      for (const line of fallback?.lines ?? []) box.child(ctx.ansiRow ? ctx.ansiRow(line) : div().h(ctx.lineHeight).child(line));
      return box;
    }
    if (!body) return box; // only a Pi-rows item waiting for its rows can lack one
    const rows = layout.rowsOf(item, body).parts;
    if (item.k === "user") {
      box.bg(t.raised ?? t.background);
      box.child(div().h(ctx.lineHeight).flex_none());
      for (const el of lines(rows.t ?? [], ctx, t.foreground)) box.child(el);
      box.child(div().h(ctx.lineHeight).flex_none());
    } else if (item.k === "md") {
      for (const { text, style } of styleMarkdown(rows.t ?? [])) {
        const [el] = style === "h1" || style === "h2" ? lines([text], ctx, t.accent ?? t.foreground, { bold: true })
          : style === "h3" ? lines([text], ctx, t.foreground, { bold: true })
          : style === "quote" ? lines([text], ctx, t.muted, { italic: true })
          : style === "fence" || style === "rule" ? lines([text], ctx, t.muted)
          : lines([text], ctx, t.foreground);
        box.child(style === "code" ? el.bg(t.raised ?? t.background) : el);
      }
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
    if (model.isFolded(item)) for (const el of lines([`… ${item.x} more line${item.x === 1 ? "" : "s"}`], ctx, t.muted, { italic: true })) box.child(el);
    return box;
  }

  return {
    /** Whether the pane's tree is in use (its stream exists); the old per-page polling stays off then. */
    active(name) { const entry = panes.get(name); return !!entry && !entry.dead; },
    /** True while a stream delivered something the next frame must draw, or heights/bodies are still settling. */
    wantsRender() {
      for (const entry of panes.values()) {
        if (entry.dead) continue;
        if (entry.dirty || !entry.view.model.ready || !entry.view.exact || entry.view.busy || entry.jump) return true;
      }
      return false;
    },
    /**
     * Follow the pointer to the item it is over (handlers cannot live in the virtual list's rows, so the panel calls this).
     * @param {string} name @param {{ handle: any }} state @param {number | null} localY pointer y inside the list, or null when outside
     */
    track(name, state, localY, notify) {
      const entry = panes.get(name);
      if (!entry || entry.dead || !entry.view.model.ready) return;
      let id = null;
      if (localY !== null && state.handle) {
        const lineHeight = entry.lineHeight ?? 1;
        const row = Math.floor((state.handle.offset().y + localY) / lineHeight);
        const hit = entry.view.layout.locate(Math.max(0, row));
        const item = entry.view.model.items[hit.index];
        if (item && item.k !== "rows") id = item.id;
      }
      if (entry.hover !== id) { entry.hover = id; notify?.(); }
    },
    /** The buttons (expand, Go to, Copy) floating over the right edge of the hovered item, or null. */
    copyButton(name, state, ctx) {
      const entry = panes.get(name);
      if (!entry || entry.dead || !entry.hover || !ctx.svg || !state.handle) return null;
      const index = entry.view.model.indexOf(entry.hover);
      if (index < 0) return null;
      const item = entry.view.model.items[index];
      const size = 28;
      const viewport = state.handle.viewport_size().height || state.height;
      const itemTop = entry.view.layout.prefix(index) * ctx.lineHeight - state.handle.offset().y;
      const top = Math.max(2, Math.min(viewport - size - 2, itemTop + 2));
      return buildBar(entry, item, ctx).absolute().top(top).right(ctx.scrollbarLane ?? 14);
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
      entry.lineHeight = ctx.lineHeight;
      entry.dirty = false;
      const { view } = entry;
      const lineHeight = ctx.lineHeight;
      // GPUI owns the scroll offset; the view follows it (rows from the handle), then plans around it.
      view.setViewport(Math.max(1, Math.floor(state.height / lineHeight)));
      if (state.width > 0) view.setCols(Math.max(10, state.width - 2));
      if (entry.jump) {
        // Go to: the item's top row, then GPUI follows (the view stops reading the handle for two frames).
        const index = view.model.indexOf(entry.jump);
        entry.jump = null;
        if (index >= 0) { view.toItemId(view.model.items[index].id); state.handle.scroll_to_item?.(index); entry.bottomRequests = 2; }
      }
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
