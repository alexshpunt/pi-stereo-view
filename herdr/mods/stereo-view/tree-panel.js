// LPT-1943: the GPUI side of the element tree. One TreeClient + TreeView per pane; `list()` returns a virtual list
// whose items are drawn from the local tree: wrapping, heights and scroll position are computed here, so a scroll or
// a resize never waits for Pi. Item kinds: user, md, think, tool, bash (native), rows (Pi's own rendered rows).
import { TreeClient } from "./tree-client.js";
import { TreeView } from "./tree-view.js";
import { imageCols, imageRows } from "./tree-layout.js";
import { styleMarkdown } from "./md-style.js";
import { TreeInteraction } from "./tree-interact.js";

/**
 * @param {{ div: any, h_flex: any, v_flex: any, v_virtual_list: any }} gpui
 * @param {{ spawnStream: any, target: (name: string) => ({ socket: string, on?: string } | null), parseAnsi?: (line: string) => any[] }} deps
 */
export function createTreePanels(gpui, deps) {
  const { div, h_flex, v_flex, v_virtual_list } = gpui;
  const COPIED_MS = 1500;
  /** The host's virtual list takes at most 10000 sizes: past this many items, runs of `group` items share one list entry. */
  const MAX_ENTRIES = 8000;
  /** @type {Map<string, any>} */
  const panes = new Map();

  const RETRIES = 5, RETRY_MS = 1500;

  /** A stream that died (Pi was still starting, a restart) is opened again, a few times with growing pauses. */
  function revive(name) {
    const entry = panes.get(name);
    if (!entry?.dead || (entry.retries ?? 0) >= RETRIES || Date.now() - entry.deadAt < RETRY_MS * ((entry.retries ?? 0) + 1)) return entry;
    panes.delete(name);
    const next = ensure(name, entry.notify);
    if (next) next.retries = (entry.retries ?? 0) + 1;
    return next ?? entry;
  }

  function ensure(name, notify) {
    let entry = panes.get(name);
    if (entry) return entry;
    const target = deps.target(name);
    if (!target) return null;
    entry = { name, view: null, client: null, sizes: [], version: -1, lastTotal: 0, notify };
    const client = new TreeClient(deps.spawnStream, { ...target, on: target.on ?? target.machine, pane: name }, {
      change: change => { entry.view.changed(change); entry.ui.changed(); entry.dirty = true; entry.notify?.(); },
      bodies: () => { entry.ui.changed(); entry.dirty = true; entry.notify?.(); },
      heights: message => { if (entry.view.applyHeights(message)) { entry.dirty = true; entry.notify?.(); } },
      // A stream that ends stays as a dead entry: the old list draws and nothing retries in a loop.
      exit: (code, why) => { entry.dead = true; entry.deadAt = Date.now(); entry.error = `exit ${code ?? "?"}${why ? `: ${why}` : ""}`; entry.notify?.(); },
      error: text => { entry.error = text; },
    });
    entry.client = client;
    entry.view = new TreeView(client, { viewport: 40, cols: 100 });
    entry.ui = new TreeInteraction(entry.view);
    client.start();
    panes.set(name, entry);
    return entry;
  }

  /** Colors of the highlights: the selection, other find hits, the current hit. */
  function markColor(kind, t) {
    return kind === "sel" ? t.selection ?? t.accent ?? "#526b83" : kind === "cur" ? t.findCurrent ?? t.warning ?? "#b8891a" : t.findMatch ?? "#6b5a1f";
  }

  /**
   * Text rows of one body part, as GPUI lines. `opts.marks[i]` lists the highlighted cell ranges of row i
   * (`{ c0, c1, kind }`, from tree-select / tree-find): each is an absolute rectangle under the text.
   */
  function lines(rows, ctx, color, opts = {}) {
    return rows.map((text, i) => {
      const marks = opts.marks?.[i];
      let el = div().h(ctx.lineHeight).flex_none().whitespace_nowrap().font_family(ctx.font).text_size(ctx.fontSize)
        .line_height(`${ctx.lineHeight}px`).text_color(color);
      if (marks) {
        el = el.relative();
        for (const mark of marks) el = el.child(div().absolute().top(0).h(ctx.lineHeight).left(mark.c0 * ctx.cellWidth).w((mark.c1 - mark.c0) * ctx.cellWidth).bg(markColor(mark.kind, ctx.theme)));
      }
      el = el.child(text || " ");
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
    if (entry.name !== "combined") bar.child(iconButton(ctx, item, "goto", "Go to the same point in the other panel", "go-to", false, () => goTo(entry, item, ctx)));
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
    const wrapped = layout.rowsOf(item, body);
    const rows = wrapped.parts;
    const marks = entry.ui.marks(index, item, body, wrapped); // selection and find highlights: { [part]: rows of { c0, c1, kind }[] }
    if (item.k === "user") {
      box.bg(t.raised ?? t.background);
      box.child(div().h(ctx.lineHeight).flex_none());
      for (const el of lines(rows.t ?? [], ctx, t.foreground, { marks: marks?.t })) box.child(el);
      box.child(div().h(ctx.lineHeight).flex_none());
    } else if (item.k === "md") {
      let n = 0;
      for (const { text, style } of styleMarkdown(rows.t ?? [])) {
        const own = { marks: marks?.t?.[n] ? [marks.t[n]] : undefined };
        n++;
        const [el] = style === "h1" || style === "h2" ? lines([text], ctx, t.accent ?? t.foreground, { bold: true, ...own })
          : style === "h3" ? lines([text], ctx, t.foreground, { bold: true, ...own })
          : style === "quote" ? lines([text], ctx, t.muted, { italic: true, ...own })
          : style === "fence" || style === "rule" ? lines([text], ctx, t.muted, own)
          : lines([text], ctx, t.foreground, own);
        box.child(style === "code" ? el.bg(t.raised ?? t.background) : el);
      }
    } else if (item.k === "think") {
      for (const el of lines(["thinking"], ctx, t.muted, { bold: true })) box.child(el);
      for (const el of lines(rows.t ?? [], ctx, t.muted, { italic: true, marks: marks?.t })) box.child(el);
    } else {
      // tool and bash: a header line with the name or "$", the call text, then the output.
      const title = item.k === "bash" ? "$ shell" : `${item.m?.name ?? "tool"}${item.m?.status && item.m.status !== "success" ? ` (${item.m.status})` : ""}`;
      for (const el of lines([title], ctx, t.accent ?? t.foreground, { bold: true })) box.child(el);
      for (const el of lines(rows.a ?? [], ctx, t.muted, { marks: marks?.a })) box.child(el);
      for (const el of lines(rows.o ?? [], ctx, t.foreground, { marks: marks?.o })) box.child(el);
    }
    // Images of a tool result under its text (their rows are part of the item's height: layout.chrome).
    if (item.im) for (const im of item.im) box.child(ctx.image ? ctx.image(im, imageCols(im, layout.cols), imageRows(im, layout.cols) - 1) : div().h(ctx.lineHeight).text_color(t.muted).child("[image]"));
    if (model.isFolded(item)) for (const el of lines([`… ${item.x} more line${item.x === 1 ? "" : "s"}`], ctx, t.muted, { italic: true })) box.child(el);
    return box;
  }

  return {
    /** Whether the pane's tree is in use (its stream exists); the old per-page polling stays off then. */
    active(name) { const entry = panes.get(name); return !!entry && !entry.dead; },
    /** Like `active`, but opens the stream first: the old per-page request of a huge history must never run ahead of it. */
    claim(name) { const entry = revive(name) ?? ensure(name, undefined); return !!entry && (!entry.dead || (entry.retries ?? 0) < RETRIES); },
    /** True while a stream delivered something the next frame must draw, or heights/bodies are still settling. */
    wantsRender() {
      for (const entry of panes.values()) {
        if (entry.dead) continue;
        if (entry.dirty || !entry.view.model.ready || !entry.view.exact || entry.view.busy || entry.jump || entry.ui.busy) return true;
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
    // LPT-1943 selection and find (tree-interact.js). Positions are px of the list box, already divided by the zoom.
    /** Press in the list: starts a selection gesture. `pos`: `{ x, y, count, shift, maxX? }`. Returns whether it did. */
    pointerDown(name, state, pos, cx) { const entry = panes.get(name); return !!entry && !entry.dead && entry.ui.down(state, pos, cx); },
    /** Whether a selection gesture is running (the panel then routes window mouse moves and the release here). */
    dragging(name) { return !!panes.get(name)?.ui.dragging; },
    /** Pointer move during the gesture. `pos`: `{ x, y, pressed }`. */
    pointerMove(name, state, pos, cx) { return !!panes.get(name)?.ui.move(state, pos, cx); },
    /** Release: the gesture ends. */
    pointerUp(name) { panes.get(name)?.ui.up(); },
    hasSelection(name) { return !!panes.get(name)?.ui.hasSelection; },
    /** Copy the selected text to the clipboard. Returns whether there was a selection. */
    copySelection(name, cx) { return !!panes.get(name)?.ui.copy(cx); },
    clearSelection(name) { panes.get(name)?.ui.clear(); },
    /**
     * The find bar's callbacks for a tree pane (pass them to `createSearchBar`), or null when the pane has no tree.
     * `hooks`: `{ state(s), closed(cx) }`: `s` is `{ query, count, current, pending, error }` for `bar.render(s, theme)`.
     */
    findActions(name, hooks) { const entry = panes.get(name); return entry && !entry.dead ? entry.ui.findActions(hooks) : null; },
    /** The tree view of a pane, for operations (scroll to, search) and the benchmark. */
    view(name) { return panes.get(name)?.view; },
    /** Time spent building the items of each visible range (ms), for the live frame check. */
    ranges(name) { return panes.get(name)?.rangeMs?.slice(-300) ?? []; },
    status(name) { const entry = panes.get(name); return entry ? { prof: entry.prof ? entry.prof.s.map(v => +(v / entry.prof.n).toFixed(3)) : null, ready: entry.view.model.ready, items: entry.view.layout.count, totalRows: entry.view.layout.totalRows, top: entry.frame?.top, pending: entry.frame?.pending, marks: entry.client.marks, exact: entry.view.exact, awaitingPi: !!entry.view.awaitingPi, dead: !!entry.dead, error: entry.error } : null; },
    close() { for (const entry of panes.values()) entry.client.close(); panes.clear(); },

    /**
     * The panel's list for pane `name`, or null when its tree is not available (the caller draws its old list).
     * @param {string} name @param {{ width: number, height: number, handle: any }} state
     * @param {{ theme: any, lineHeight: number, font: string, fontSize: number, gutter: number, notify: () => void, ansiRow?: (line: string) => any }} ctx
     */
    list(name, state, ctx) {
      const entry = revive(name) ?? ensure(name, ctx.notify);
      if (!entry || entry.dead || !entry.view.model.ready || !state.handle) return null;
      entry.notify = ctx.notify;
      entry.lineHeight = ctx.lineHeight;
      entry.dirty = false;
      const { view } = entry;
      const lineHeight = ctx.lineHeight;
      // GPUI owns the scroll offset; the view follows it (rows from the handle), then plans around it.
      const P = [performance.now()]; // TEMPORARY profile marks
      const group = Math.max(1, Math.ceil(view.layout.count / MAX_ENTRIES));
      entry.ui.group = group;
      view.setViewport(Math.max(1, Math.floor(state.height / lineHeight)));
      if (state.width > 0) view.setCols(Math.max(10, state.width - 2));
      if (entry.jump) {
        // Go to: the item's top row, then GPUI follows (the view stops reading the handle for two frames).
        const index = view.model.indexOf(entry.jump);
        entry.jump = null;
        if (index >= 0) { view.toItemId(view.model.items[index].id); state.handle.scroll_to_item?.(Math.floor(index / group)); entry.bottomRequests = 2; }
      }
      P.push(performance.now());
      entry.ui.metrics = { lineHeight, cellWidth: ctx.cellWidth ?? 8, textLeft: ctx.gutter };
      // Find: one 4 ms slice per render while a pass runs; a hit to show brings its item on screen (a tall item shows its top).
      const found = entry.ui.frame();
      if (found) {
        const fits = view.layout.heights[found.index] <= view.viewport;
        view.toItem(found.index);
        state.handle.scroll_to_item?.(Math.floor(found.index / group), fits && group === 1 ? "center" : "top");
        entry.bottomRequests = 2;
      }
      P.push(performance.now());
      const placed = state.handle.content_size().height > 0;
      if (entry.bottomRequests > 0) entry.bottomRequests--;
      else if (placed && entry.settled) view.scrollTo(Math.round(state.handle.offset().y / lineHeight));
      if (placed) entry.settled = true;
      P.push(performance.now());
      const frame = view.frame();
      P.push(performance.now());
      // Heights settle and bodies arrive over several frames: the mod's tick asks for the next render (wantsRender).
      const layout = view.layout;
      const groups = Math.ceil(layout.count / group);
      if (entry.version !== layout.version && group === 1 && layout.touched && entry.sizes.length === groups && entry.group === group) {
        for (const i of layout.touched) entry.sizes[i] = layout.heights[i] * lineHeight; // measuring changes a few heights per frame
        layout.touched.clear();
        entry.version = layout.version;
      } else if (entry.version !== layout.version || entry.sizes.length !== groups || entry.group !== group) {
        layout.touched = new Set();
        const sizes = new Array(groups).fill(0);
        for (let i = 0; i < layout.count; i++) sizes[Math.floor(i / group)] += layout.heights[i] * lineHeight;
        entry.sizes = sizes;
        entry.version = layout.version;
        entry.group = group;
      }
      if (view.following && (frame.total !== entry.lastTotal || !entry.settled)) { state.handle.scroll_to_bottom?.(); entry.bottomRequests = 2; }
      P.push(performance.now());
      entry.lastTotal = frame.total;
      entry.frame = frame;
      const items = view.model.items;
      P.push(performance.now());
      const profAdd = () => { const prof = (entry.prof ??= { n: 0, s: [0, 0, 0, 0, 0, 0] }); prof.n++; for (let i = 1; i < P.length; i++) prof.s[i - 1] += P[i] - P[i - 1]; };
      profAdd();
      return v_virtual_list(`stereo-tree-${name}`, groups, entry.sizes, index => items[index * group]?.id ?? String(index),
        range => {
          const started = typeof performance !== "undefined" ? performance.now() : Date.now();
          const out = [];
          for (let g = range.start; g < range.end; g++) {
            if (group === 1) { out.push(renderItem(entry, g, ctx)); continue; }
            const run = v_flex().id(`stereo-tree-${name}-run-${g}`).w_full().flex_none();
            for (let i = g * group; i < Math.min(layout.count, (g + 1) * group); i++) run.child(renderItem(entry, i, ctx));
            out.push(run);
          }
          const spent = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
          (entry.rangeMs ??= []).push({ spent, items: range.end - range.start }); if (entry.rangeMs.length > 600) entry.rangeMs.splice(0, 300);
          return out;
        })
        .h(state.height).track_scroll(state.handle);
    },
  };
}
