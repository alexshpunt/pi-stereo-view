// LPT-1943: pointer selection and find of one tree pane, in one object the panel owns (`entry.ui`).
//
// Design. Everything GPUI-specific is injected, so the logic runs in unit tests: the caller passes pointer positions
// in px of the list box (already divided by the window zoom), a scroll handle (`offset()`, `viewport_size()`,
// `scroll_to_item(index)`) and a `cx` with `notify()`, `timer.after(ms, cb)` and `write_to_clipboard(text)`.
//   down / move / up    one drag gesture: press starts a selection (double click: word, triple: line, shift: extend),
//                       moving extends it, leaving the list at the top or bottom edge scrolls it by item on a timer
//                       (`autoScrollTarget`) and keeps extending; a press and release without moving leaves nothing
//                       selected. Handlers live at panel level, never in the virtual list's rows.
//   copy                the selection as text, synchronously (the mod holds every body).
//   findActions         the callbacks of the find bar (query / next / previous / close) and the state it shows.
//   frame               called once per render: steps the find slice (4 ms) and returns the hit to bring on screen.
//   marks               selection and find highlights of the item being drawn, merged.
// The pane's mod-wide geometry comes from `metrics`, set every render: row height, cell width, and the x where
// the text starts inside the list box.
import { TreeSelection } from "./tree-select.js";
import { TreeFind } from "./tree-find.js";
import { SpanCache, mergeMarks } from "./tree-text.js";

const AUTO_SCROLL_MS = 70;
const FIND_BUDGET_MS = 4;

/**
 * The item to scroll to for one step of auto-scroll: up reveals the rest of the top item, then the one above; down
 * moves on to the next item. `top` is the first visible pane row.
 */
export function autoScrollTarget(layout, top, direction) {
  const { index, offset } = layout.locate(Math.max(0, top));
  if (direction < 0) return offset > 0 ? index : Math.max(0, index - 1);
  return Math.min(layout.count - 1, index + 1);
}

export class TreeInteraction {
  /** @param view TreeView */
  constructor(view) {
    this.view = view;
    this.spans = new SpanCache();
    this.selection = new TreeSelection(view, this.spans);
    this.find = new TreeFind(view, this.spans);
    this.metrics = { lineHeight: 1, cellWidth: 1, textLeft: 0 };
    this.drag = null;
    this.sink = null;
    this.published = "";
  }

  /** A body or the tree changed (streaming, splice, expansion): find results rebuild after a quiet moment. */
  changed() { this.find.changed(); }

  /** Whether the next frames must keep rendering for the find (a pass is running). */
  get busy() { return this.find.busy; }

  get dragging() { return !!this.drag; }
  get hasSelection() { return this.selection.range() !== undefined; }

  /** Pane row and fractional cell column under a pointer at (x, y) px of the list box. */
  place(state, x, y) {
    const { lineHeight, cellWidth, textLeft } = this.metrics;
    return { row: Math.floor((state.handle.offset().y + y) / lineHeight), col: (x - textLeft) / cellWidth };
  }

  /**
   * Press. `pos`: `{ x, y, count, shift, maxX? }`; a press at or right of `maxX` (the scrollbar lane) is not ours.
   * Returns whether the press started a gesture.
   */
  down(state, pos, cx) {
    if (!state.handle || !this.view.model.ready || (pos.maxX !== undefined && pos.x >= pos.maxX)) return false;
    const { row, col } = this.place(state, pos.x, pos.y);
    const point = this.selection.pointAt(row, col);
    if (!point) return false;
    const mode = pos.count >= 3 ? "line" : pos.count === 2 ? "word" : "char";
    if (pos.shift && mode === "char" && this.selection.anchor) this.selection.extend(point);
    else this.selection.start(point, mode);
    this.drag = { state, x: pos.x, y: pos.y, auto: 0, timer: false };
    cx.notify();
    return true;
  }

  /** Pointer motion during a gesture. `pos`: `{ x, y, pressed }`; `pressed` false means the button was released elsewhere. */
  move(state, pos, cx) {
    const drag = this.drag;
    if (!drag) return false;
    if (!pos.pressed) { this.up(); cx.notify(); return false; }
    drag.x = pos.x; drag.y = pos.y; drag.state = state;
    const viewport = state.handle.viewport_size().height || state.height;
    drag.auto = pos.y < 0 ? -1 : pos.y >= viewport ? 1 : 0;
    this.extendTo(drag, viewport, cx);
    if (drag.auto) this.autoScroll(drag, cx);
    return true;
  }

  /** Extend the focus to the pointer (clamped into the list); redraw only when the focus moved. */
  extendTo(drag, viewport, cx) {
    const y = Math.max(0, Math.min(viewport - 1, drag.y));
    const { row, col } = this.place(drag.state, drag.x, y);
    const point = this.selection.pointAt(row, col);
    if (point && !this.selection.atFocus(point)) { this.selection.extend(point); cx.notify(); }
  }

  /** While the pointer stays past an edge: scroll one item per tick and keep extending. */
  autoScroll(drag, cx) {
    if (drag.timer) return;
    drag.timer = true;
    cx.timer.after(AUTO_SCROLL_MS, next => {
      drag.timer = false;
      if (this.drag !== drag || !drag.auto) return;
      const { state } = drag;
      const { lineHeight } = this.metrics;
      const top = Math.round(state.handle.offset().y / lineHeight);
      const viewport = state.handle.viewport_size().height || state.height;
      state.handle.scroll_to_item(autoScrollTarget(this.view.layout, top, drag.auto));
      this.extendTo(drag, viewport, next);
      next.notify();
      this.autoScroll(drag, next);
    });
  }

  /** Release: the gesture ends; a plain click has selected nothing. */
  up() { this.drag = null; }

  /** Copy the selection. Returns whether there was one. */
  copy(cx) {
    const text = this.selection.text();
    if (!text) return false;
    cx.write_to_clipboard(text);
    return true;
  }

  clear() { this.selection.clear(); this.drag = null; }

  /** Selection and find highlights of one item: `{ [part]: (Mark[] | undefined)[] }` or null. */
  marks(index, item, body, rows) {
    return mergeMarks(this.find.marks(index, item, body, rows), this.selection.marks(index, item, body, rows));
  }

  /**
   * Callbacks for the find bar (`createSearchBar(pane, actions)`). `hooks`: `state(s)` receives the bar state after every
   * change, `closed(cx)` is called after the find closed so the owner can drop the bar.
   */
  findActions(hooks) {
    this.sink = hooks.state;
    this.find.begin();
    this.publish(true);
    return {
      query: (text, cx) => { this.find.setQuery(text); this.publish(true); cx.notify(); },
      next: cx => { this.find.move(1); this.publish(true); cx.notify(); },
      previous: cx => { this.find.move(-1); this.publish(true); cx.notify(); },
      close: cx => { this.find.close(); this.sink = null; hooks.closed?.(cx); cx.notify(); },
    };
  }

  /** Hand the bar state to its owner when it changed. */
  publish(force = false) {
    if (!this.sink) return;
    const state = this.find.state();
    const key = `${state.query}|${state.count}|${state.current}|${state.pending}|${state.error ?? ""}`;
    if (!force && key === this.published) return;
    this.published = key;
    this.sink(state);
  }

  /** One render: step the find and return the hit to scroll to (once), or null. */
  frame() {
    if (this.find.step(FIND_BUDGET_MS)) this.publish();
    else if (this.sink) this.publish();
    return this.find.takeJump();
  }
}
