import { View, div } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { checking, exec, panes, props, run, settings, spaces, terminals, theme, window } from "herdr";
import { parseAnsi } from "./ansi.js";
import { createSettingsPanel } from "./settings.js";
import { createSearchBar } from "./search-bar.js";
import { createSelection } from "./selection.js";

const LABEL = "herdr.stereo.bridge";
const LINE_HEIGHT = 17;
const PAGE = 256;
const INTERVAL = 700;
// Fixed code, not a command or script read from the terminal label. The socket and
// request are arguments and never interpolated into this source.
const CLIENT = `const net=require('node:net');
const socket=process.argv[1], request=process.argv[2];
if(!/^\\/tmp\\/stereo-[A-Za-z0-9]{6}\\/s$/.test(socket)||Buffer.byteLength(request)>4096)process.exit(2);
let result='',done=false;const c=net.createConnection(socket);c.setEncoding('utf8');
const fail=()=>{if(!done){done=true;c.destroy();process.exitCode=1}};
c.setTimeout(3000,fail);c.on('error',fail);c.on('connect',()=>c.write(request+'\\n'));
c.on('data',b=>{result+=b;if(Buffer.byteLength(result)>4194304)return fail();let i=result.indexOf('\\n');if(i>=0&&!done){done=true;process.stdout.write(result.slice(0,i));c.end();}});
c.on('end',()=>{if(!done)fail()});`;

// A mod pane can remain alive after its tab is hidden or a sibling is zoomed.
function isShown() {
  if (!window()?.visible) return false;
  const ownPane = panes().find(p => p.pane === props()?.pane);
  if (!ownPane) return false;
  const space = spaces().find(s => s.active);
  const tab = space?.tabs.find(t => t.id === ownPane.tab && t.active);
  return !!tab && (!tab.zoomed || ownPane.zoomed);
}

function terminalAddress() {
  const p = props() ?? {};
  const origin = p.origin ?? p.terminal;
  if (typeof origin !== "string" || !origin) return null;
  const pane = String(p.pane ?? "");
  const cut = pane.indexOf("/");
  return cut < 0 || origin.includes("/") ? origin : `${pane.slice(0, cut + 1)}${origin}`;
}

function bridge() {
  const address = terminalAddress();
  const terminal = terminals().find(t => t.address === address);
  let label;
  try { label = JSON.parse(terminal?.labels?.[LABEL] ?? "null"); } catch { return null; }
  if (!address || terminal?.state !== "live" || label?.v !== 1 || !Number.isSafeInteger(label.pid) || label.pid <= 0 ||
      (terminal.pid !== label.pid && terminal.foreground?.pid !== label.pid) ||
      typeof label.socket !== "string" || !/^\/tmp\/stereo-[A-Za-z0-9]{6}\/s$/.test(label.socket)) return null;
  const split = address.indexOf("/");
  return { socket: label.socket, machine: split < 0 ? undefined : address.slice(0, split), address };
}

/** @returns {{total: number | null, revision: number, items: Map<number, {id: string, lines: string[]}>, heights: number[], width: number, height: number, handle: any, fetching: boolean, error: string | null, initial: boolean, lastSize: {width: number, height: number} | null, frameTop: number, frameHeight: number, pressed: boolean, searchState: any, searchBar: any, selectionRows: Map<number, any>, selection: any, selecting: boolean}} */
function paneState() {
  const selectionRows = new Map();
  return { total: null, revision: -1, items: new Map(), heights: [], width: 80, height: 300,
    handle: VirtualListScrollHandle.new(), fetching: false, error: null, initial: true, lastSize: null,
    frameTop: 0, frameHeight: 0, pressed: false, searchState: null, searchBar: null,
    selectionRows, selection: createSelection(index => selectionRows.get(index)), selecting: false };
}

/** Render the visible terminal rows, including one extra row for a partial scroll. */
/** @param {ReturnType<typeof paneState>} state */
function nextPage(state) {
  const offset = state.handle.offset().y;
  const viewport = state.handle.viewport_size().height || state.height;
  return { start: Math.max(0, Math.floor(offset / LINE_HEIGHT)),
    count: Math.min(PAGE, Math.max(1, Math.ceil(viewport / LINE_HEIGHT) + 1)) };
}

/** @param {any} data @param {number} start @param {number} count @param {number} width */
function validView(data, start, count, width) {
  return data?.v === 1 && Number.isSafeInteger(data.frame) && data.frame > 0 &&
    Number.isSafeInteger(data.total) && data.total >= 0 && data.total <= 1000000 &&
    data.top === start && data.height === count && data.width === width &&
    Number.isSafeInteger(data.scrollShift) && Array.isArray(data.lines) && data.lines.length <= count &&
    Array.isArray(data.selection) && data.selection.length === data.lines.length &&
    data.selection.every(/** @param {any} */ row => Array.isArray(row?.cells) && Array.isArray(row.words)) &&
    (start >= data.total ? data.lines.length === 0 : start + data.lines.length <= data.total) &&
    data.lines.every(/** @param {unknown} */ line => typeof line === "string");
}

/** Split styled runs at selected terminal cells without changing their text or ANSI styles. */
/** @param {any[]} runs @param {any} row @param {{start:number,end:number} | undefined} selection */
function selectedRuns(runs, row, selection) {
  if (!selection || !row?.cells?.length) return runs;
  if (row.cells.map(cell => cell.text).join("") !== runs.map(run => run.text).join("")) return runs;
  const result = [];
  let runIndex = 0, offset = 0;
  for (const cell of row.cells) {
    let left = cell.text.length;
    while (left > 0 && runIndex < runs.length) {
      const run = runs[runIndex];
      const length = Math.min(left, run.text.length - offset);
      if (length <= 0) { runIndex++; offset = 0; continue; }
      result.push({ ...run, text: run.text.slice(offset, offset + length),
        selected: cell.end > selection.start && cell.start < selection.end });
      offset += length; left -= length;
      if (offset === run.text.length) { runIndex++; offset = 0; }
    }
  }
  return result;
}

/** Validate state received from the Pi process before using it to build controls. */
function validState(value) {
  return value?.v === 1 && (value.layout === "columns" || value.layout === "rows") &&
    (value.side === "left" || value.side === "right") && (value.mode === "split" || value.mode === "combined") &&
    (value.zoom === null || value.zoom === "chat" || value.zoom === "activity") &&
    typeof value.showToolbar === "boolean" && typeof value.showHeaders === "boolean" && typeof value.compactTools === "boolean";
}

export default class StereoView extends View {
  /** @param {any} _props @param {any} cx */
  init(_props, cx) {
    this.chat = paneState();
    this.activity = paneState();
    this.combined = paneState();
    this.viewState = null;
    this.statePending = false;
    this.stateGeneration = 0;
    this.actions = [];
    this.actionPending = false;
    this.areaWidth = 800;
    this.areaHeight = 400;
    this.drag = undefined;
    // Until the first layout measures the monospace probe, use one em per cell.
    this.activePane = "chat";
    this.cellWidth = 12;
    this.available = false;
    if (checking()) return;
    this.focus = cx.focus_handle();
    cx.timer.every(INTERVAL, (/** @type {any} */ cx) => this.refresh(cx));
    this.refresh(cx);
  }

  /** @param {any} cx */
  refresh(cx) {
    if (!isShown()) return;
    const connection = bridge();
    this.available = !!connection;
    if (!connection) { this.connection = undefined; cx.notify(); return; }
    if (this.connection !== connection.socket) {
      this.connection = connection.socket;
      this.viewState = null;
      this.stateGeneration++;
      this.actions = [];
      for (const state of [this.chat, this.activity, this.combined]) {
        state.searchBar?.dispose(); state.searchBar = null; state.searchState = null;
        state.selection.clear(); state.selectionRows.clear(); state.selecting = false;
        state.total = null; state.revision = -1; state.items.clear(); state.heights = [];
        state.initial = true; state.error = null; state.pressed = false;
      }
    }
    this.fetchState(connection, cx);
    if (this.viewState?.mode === "combined") this.fetchPane("combined", this.combined, connection, cx);
    else {
      if (this.viewState?.zoom !== "activity") this.fetchPane("chat", this.chat, connection, cx);
      if (this.viewState?.zoom !== "chat") this.fetchPane("activity", this.activity, connection, cx);
    }
  }

  /** @param {{socket: string, machine?: string}} connection @param {any} cx */
  fetchState(connection, cx) {
    if (this.statePending || this.actionPending || this.actions.length) return;
    this.statePending = true;
    const generation = this.stateGeneration;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const result = await exec("node", ["-e", CLIENT, connection.socket, JSON.stringify({ v: 1, op: "state" })], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Bridge unavailable");
        const state = JSON.parse(result.stdout);
        if (!validState(state)) throw new Error("Invalid bridge state");
        if (bridge()?.socket !== connection.socket || generation !== this.stateGeneration) return;
        this.viewState = state;
        this.controlError = null;
      } catch {
        if (bridge()?.socket === connection.socket && generation === this.stateGeneration) this.controlError = "Could not read Stereo View controls.";
      } finally {
        this.statePending = false;
        cx.notify();
      }
    });
  }

  /** Queue actions so rapid clicks cannot be reordered by separate bridge processes. */
  /** @param {string} action @param {any} cx */
  sendAction(action, cx) {
    const connection = bridge();
    if (!connection) return;
    this.stateGeneration++;
    this.actions.push({ request: { v: 1, op: "action", action }, connection });
    this.drainActions(cx);
  }

  /** @param {string} key @param {unknown} value @param {any} cx */
  sendSetting(key, value, cx) {
    const connection = bridge();
    if (!connection) return;
    this.stateGeneration++;
    this.actions.push({ request: { v: 1, op: "setting", key, value }, connection });
    this.drainActions(cx);
  }

  /** @param {"chat" | "activity"} pane @param {any} cx */
  openSearch(pane, cx) {
    if (this.viewState?.mode !== "split") return;
    const state = pane === "chat" ? this.chat : this.activity;
    this.activePane = pane;
    if (state.searchBar) { state.searchBar.focus(); return; }
    state.searchState = { open: true, query: "", count: 0, current: 0, pending: false };
    state.searchBar = createSearchBar(pane, {
      query: (query, next) => this.sendSearch(pane, { action: "query", query }, next),
      next: next => this.sendSearch(pane, { action: "next" }, next),
      previous: next => this.sendSearch(pane, { action: "previous" }, next),
      close: next => this.sendSearch(pane, { action: "close" }, next),
    });
    const { start, count } = nextPage(state);
    const offset = state.handle.offset().y;
    const following = offset + (state.handle.viewport_size().height || state.height) >= state.handle.content_size().height - 2;
    this.sendSearch(pane, { action: "open", top: start, height: count, following }, cx);
    cx.notify();
  }

  /** @param {string} pane @param {any} request @param {any} cx */
  sendSearch(pane, request, cx) {
    const connection = bridge();
    if (!connection) return;
    if (request.action === "query") {
      this.actions = this.actions.filter(item => !(item.request.op === "search" && item.request.pane === pane && item.request.action === "query"));
    }
    this.actions.push({ request: { v: 1, op: "search", pane, ...request }, connection });
    this.drainActions(cx);
  }

  /** @param {string} pane @param {ReturnType<typeof paneState>} state @param {number} row @param {string} type @param {any} event @param {any} cx */
  sendMouse(pane, state, row, type, event, cx) {
    if (!event.local_position || state.revision < 1 || (type === "press" && state.fetching)) return;
    const connection = bridge();
    if (!connection) return;
    const z = settings().zoom;
    const zoom = typeof z === "number" && z > 0 ? z : 1;
    const x = Math.floor((event.local_position.x / zoom - 8) / this.cellWidth);
    const y = row - state.frameTop;
    if (type === "press" && (x < 0 || x >= state.width || y < 0 || y >= state.frameHeight)) return;
    if (x < -state.width || x >= state.width * 2 || y < -state.frameHeight || y >= state.frameHeight * 2) {
      if (type === "release") state.pressed = false;
      return;
    }
    if (type === "press") {
      state.pressed = true;
      state.selecting = true;
      const count = Math.max(1, Math.min(3, event.click_count || 1));
      state.selection.start({ row, col: x }, count === 3 ? "line" : count === 2 ? "word" : "character");
      if (pane === "chat" || pane === "activity") this.activePane = pane;
      this.focus?.focus();
      cx.notify();
    } else if (!state.pressed) return;
    else if (type === "drag" || type === "release") { state.selection.extend({ row, col: x }); cx.notify(); }
    const input = { type, button: "left", x, y, shift: !!event.modifiers?.shift, ctrl: !!event.modifiers?.control,
      alt: !!event.modifiers?.alt, clickCount: Math.max(1, Math.min(3, event.click_count || 1)) };
    if (type === "drag") this.actions = this.actions.filter(item => !(item.request.op === "mouse" && item.request.pane === pane && item.request.event.type === "drag"));
    this.actions.push({ request: { v: 1, op: "mouse", pane, frame: state.revision, event: input }, connection });
    if (type === "release") state.pressed = false;
    this.drainActions(cx);
  }

  /** @param {any} cx */
  drainActions(cx) {
    if (this.actionPending || !this.actions.length) return;
    const { request, connection } = this.actions.shift();
    this.actionPending = true;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        if (bridge()?.socket !== connection.socket) return;
        const result = await exec("node", ["-e", CLIENT, connection.socket, JSON.stringify(request)], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Bridge unavailable");
        const reply = JSON.parse(result.stdout);
        if (reply?.v !== 1) throw new Error("Action failed");
        if (request.op === "search") {
          if (typeof reply.open !== "boolean" || !Number.isSafeInteger(reply.count) || !Number.isSafeInteger(reply.current)) throw new Error("Invalid search response");
          const pane = request.pane === "chat" ? this.chat : this.activity;
          pane.searchState = reply;
          if (request.action === "close") {
            pane.searchBar?.dispose();
            pane.searchBar = null;
            if (reply.restored?.following) pane.handle.scroll_to_bottom();
            else if (Number.isSafeInteger(reply.restored?.top)) pane.handle.scroll_to_item(reply.restored.top);
          } else if (Number.isSafeInteger(reply.top)) pane.handle.scroll_to_item(reply.top);
        } else if (reply.ok !== true) throw new Error("Action failed");
        this.controlError = null;
      } catch {
        if (bridge()?.socket === connection.socket) this.controlError = "Could not change Stereo View controls.";
      } finally {
        this.actionPending = false;
        if (this.actions.length) this.drainActions(cx);
        else this.refresh(cx);
        cx.notify();
      }
    });
  }

  /** @param {string} pane @param {ReturnType<typeof paneState>} state @param {{socket: string, machine?: string, address: string}} connection @param {any} cx */
  fetchPane(pane, state, connection, cx) {
    if (state.fetching || state.pressed || this.actionPending || this.actions.length) return;
    const offset = state.handle.offset().y;
    const viewport = state.handle.viewport_size().height || state.height;
    const following = state.initial || offset + viewport >= state.handle.content_size().height - 2;
    const { start, count } = nextPage(state);
    const width = state.width;
    state.fetching = true;
    const request = JSON.stringify({ v: 1, op: "view", pane, top: start, height: count, width, following });
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const result = await exec("node", ["-e", CLIENT, connection.socket, request], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Bridge unavailable");
        const page = JSON.parse(result.stdout);
        if (!validView(page, start, count, width)) throw new Error("Invalid bridge response");
        const now = bridge();
        if (!isShown() || !now || now.socket !== connection.socket || state.width !== width) return;
        if (state.searchBar && page.search?.open && page.search.query === state.searchState?.query &&
            Number.isSafeInteger(page.search.count) && Number.isSafeInteger(page.search.current)) {
          const previousTop = state.searchState?.top;
          state.searchState = page.search;
          if (Number.isSafeInteger(page.search.top) && page.search.top !== previousTop)
            state.handle.scroll_to_item(page.search.top);
        }
        const currentOffset = state.handle.offset().y;
        const currentViewport = state.handle.viewport_size().height || state.height;
        const stillAtEnd = currentOffset + currentViewport >= state.handle.content_size().height - 2;
        const geometryChanged = state.total !== page.total;
        state.total = page.total;
        state.revision = page.frame;
        state.frameTop = page.top;
        state.frameHeight = page.height;
        state.items.clear();
        if (!state.selection.bounds()) state.selectionRows.clear();
        for (let i = 0; i < page.lines.length; i++) {
          state.selectionRows.set(start + i, page.selection[i]);
          state.items.set(start + i, { id: `${page.frame}:${start + i}`, lines: [page.lines[i]] });
        }
        if (geometryChanged) state.heights = Array(page.total).fill(LINE_HEIGHT);
        if (geometryChanged && (state.initial || (following && stillAtEnd)) && state.total > 0) state.handle.scroll_to_bottom();
        else if (!following && page.scrollShift && state.total > 0)
          state.handle.scroll_to_item(Math.max(0, Math.min(state.total - 1, start + page.scrollShift)));
        state.initial = false;
        state.error = null;
      } catch {
        state.error = "Could not read this panel. The terminal is still available.";
      } finally {
        state.fetching = false;
        cx.notify();
      }
    });
  }

  /** @param {{width: number, height: number}} size @param {any} cx */
  measureCell(size, cx) {
    const z = settings().zoom;
    const zoom = typeof z === "number" && z > 0 ? z : 1;
    const measured = size.width / zoom / 10;
    if (!Number.isFinite(measured) || measured <= 0 || Math.abs(measured - this.cellWidth) < 0.01) return;
    this.cellWidth = measured;
    if (this.chat.lastSize) this.sizePane(this.chat, this.chat.lastSize, cx);
    if (this.activity.lastSize) this.sizePane(this.activity, this.activity.lastSize, cx);
    if (this.combined.lastSize) this.sizePane(this.combined, this.combined.lastSize, cx);
  }

  /** @param {ReturnType<typeof paneState>} state @param {{width: number, height: number}} size @param {any} cx */
  sizePane(state, size, cx) {
    state.lastSize = size;
    const z = settings().zoom;
    const zoom = typeof z === "number" && z > 0 ? z : 1;
    const width = Math.max(10, Math.min(300, Math.floor((size.width / zoom - 24) / this.cellWidth)));
    const height = Math.max(1, Math.floor(size.height / zoom));
    if (width === state.width && height === state.height) return;
    if (width !== state.width) state.items.clear();
    state.width = width;
    state.height = height;
    cx.notify();
  }

  /** @param {any} t @param {any} run */
  ansiRun(t, run) {
    const color = (/** @type {any} */ value, /** @type {any} */ fallback) => value === undefined ? fallback : typeof value === "string" ? value : t[`ansi${value.ansi}`] ?? fallback;
    let fg = color(run.fg, t.foreground), bg = color(run.bg, undefined);
    if (run.inverse) [fg, bg] = [bg ?? t.surface, fg];
    let el = div().flex_none().whitespace_nowrap().text_color(fg);
    if (bg) el = el.bg(bg);
    if (run.bold) el = el.font_semibold();
    if (run.italic) el = el.italic();
    if (run.underline) el = el.underline();
    if (run.dim) el = el.opacity(0.65);
    if (run.selected) el = el.bg(t.selection ?? t.accent ?? "#526b83");
    if (typeof run.link === "string" && /^https?:\/\/[^/\s?#]+/i.test(run.link)) {
      el = el.cursor_pointer().on_click((_event, cx) => cx.open_url(run.link));
    }
    return el.child(run.text);
  }

  /** @param {ReturnType<typeof paneState>} state @param {number} index @param {any} t */
  entry(state, index, t) {
    const item = state.items.get(index);
    if (!item) return div().h(LINE_HEIGHT).flex_none();
    const line = item.lines[0] ?? "";
    const pane = state === this.chat ? "chat" : state === this.activity ? "activity" : "combined";
    return h_flex().px(8).h(LINE_HEIGHT).flex_none().whitespace_nowrap().overflow_hidden()
      .on_mouse_down("left", (event, cx) => this.sendMouse(pane, state, index, "press", event, cx))
      .on_mouse_up("left", (event, cx) => this.sendMouse(pane, state, index, "release", event, cx))
      .children(selectedRuns(parseAnsi(line.replace(/\u001b_[\s\S]*?\u001b\\/g, "")), state.selectionRows.get(index),
        state.selection.columns(index)).map(run => this.ansiRun(t, run)));
  }

  /** @param {string} action @param {string} label @param {any} t */
  control(action, label, t) {
    return div().id(`stereo-action-${action}`).px(6).py(3).cursor_pointer().text_color(t.foreground)
      .hover(s => s.bg(t.hover)).on_click((_event, cx) => {
        if (action === "find-chat" || action === "find-activity") {
          this.openSearch(action === "find-chat" ? "chat" : "activity", cx);
          return;
        }
        if (action === "settings") {
          if (!this.viewState?.preferences) return;
          this.settingsPanel = createSettingsPanel(this.viewState.preferences,
            (key, value, next) => this.sendSetting(key, value, next),
            next => { this.settingsPanel = undefined; next.notify(); });
          cx.notify();
        } else this.sendAction(action, cx);
      }).child(label);
  }

  chatExtent() {
    const rows = this.viewState?.layout === "rows";
    const total = rows ? this.areaHeight : this.areaWidth;
    if (this.drag) return Math.max(40, Math.min(total - 40, this.drag.size));
    const prefs = this.viewState?.preferences;
    const value = rows
      ? (prefs?.chatHeight == null ? Math.min(total / 2, Math.max(LINE_HEIGHT * 3, (this.chat.total ?? 1) * LINE_HEIGHT + 28)) : prefs.chatHeight * LINE_HEIGHT)
      : (prefs?.chatWidth == null ? Math.max(24 * this.cellWidth + 16, total * 0.2) : prefs.chatWidth * this.cellWidth + 16);
    return Math.max(40, Math.min(total - 40, value));
  }

  /** @param {any} t */
  divider(t) {
    const rows = this.viewState?.layout === "rows";
    const separator = div().id("stereo-divider").flex_none().bg(t.border).cursor_pointer();
    if (rows) separator.h(5).w_full(); else separator.w(5).h_full();
    return separator
      .on_mouse_down("left", (event, cx) => {
        const z = settings().zoom;
        const zoom = typeof z === "number" && z > 0 ? z : 1;
        this.drag = { start: (rows ? event.position.y : event.position.x) / zoom,
          initial: this.chatExtent(), size: this.chatExtent(), rows, side: this.viewState?.side };
        cx.notify();
      })
      .on_window_mouse_move((event, cx) => {
        if (!this.drag) return;
        const z = settings().zoom;
        const zoom = typeof z === "number" && z > 0 ? z : 1;
        const position = (this.drag.rows ? event.position.y : event.position.x) / zoom;
        this.drag.size = this.drag.initial + (position - this.drag.start) * (this.drag.side === "right" ? -1 : 1);
        cx.notify();
      })
      .on_window_mouse_up("left", (_event, cx) => {
        if (!this.drag) return;
        const rows = this.drag.rows, extent = this.chatExtent();
        this.drag = undefined;
        const value = rows ? Math.max(1, Math.min(240, Math.round(extent / LINE_HEIGHT)))
          : Math.max(24, Math.min(240, Math.round((extent - 16) / this.cellWidth)));
        this.sendSetting(rows ? "chatHeight" : "chatWidth", value, cx);
        cx.notify();
      });
  }

  /** @param {string} name @param {string} title @param {ReturnType<typeof paneState>} state @param {any} t */
  panel(name, title, state, t) {
    const id = `stereo-${name}`;
    const rows = v_virtual_list(id, state.total ?? 0, state.heights,
      index => `${name}-${index}`,
      range => Array.from({ length: range.end - range.start }, (_, n) => this.entry(state, range.start + n, t)))
      .h(state.height).track_scroll(state.handle);
    const heading = h_flex().items_center().justify_between().px(8).py(3)
      .child(div().text_color(t.muted).child(title));
    const actions = h_flex().items_center();
    if (name !== "combined") actions.child(this.control(`find-${name}`, "Find", t));
    if (name === "activity") actions.child(this.control("compact", this.viewState?.compactTools ? "Full tools" : "Compact tools", t));
    if (name !== "combined") actions.child(this.control(`zoom-${name}`, this.viewState?.zoom === name ? "Restore" : "Maximize", t));
    heading.child(actions);
    const panel = v_flex().flex_1().min_w(0).min_h(0).border_1().border_color(t.border);
    if (name === "chat" && this.viewState?.mode === "split" && !this.viewState?.zoom) {
      if (this.viewState.layout === "rows") panel.flex_none().h(this.chatExtent());
      else panel.flex_none().w(this.chatExtent());
    }
    if (name !== "combined" && this.viewState?.showHeaders !== false) panel.child(heading);
    if (state.searchBar) panel.child(state.searchBar.render(state.searchState ?? {}, t));
    return panel
      .child(state.error ? div().px(8).text_color(t.muted).child(state.error) : div().h(0))
      .child(v_flex().id(`${id}-box`).relative().flex_1().min_h(0)
        .on_size_change((size, cx) => this.sizePane(state, size, cx))
        .on_scroll_wheel(() => { if (name === "chat" || name === "activity") this.activePane = name; })
        .on_window_mouse_move((event, cx) => {
          if (!state.pressed || !event.local_position) return;
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const row = Math.floor((state.handle.offset().y + event.local_position.y / zoom) / LINE_HEIGHT);
          this.sendMouse(name, state, row, "drag", event, cx);
        })
        .on_window_mouse_up("left", (event, cx) => {
          if (!state.pressed || !event.local_position) return;
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const row = Math.floor((state.handle.offset().y + event.local_position.y / zoom) / LINE_HEIGHT);
          this.sendMouse(name, state, row, "release", event, cx);
        })
        .child(rows).child(Scrollbar.vertical(id).absolute().inset_0()));
  }

  render() {
    const t = theme();
    const address = terminalAddress();
    if (this.settingsPanel && this.viewState?.preferences) return this.settingsPanel.render(this.viewState.preferences, t);
    const terminalPane = panes().find(p => p.terminal === address);
    const header = h_flex().items_center().justify_between().px(8).py(5)
      .child(div().text_color(t.foreground).child("Stereo View"));
    if (this.viewState?.showToolbar === false) header.child(this.control("settings", "Settings", t));
    if (terminalPane) header.child(div().id("stereo-terminal").px(8).py(4).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover)).on_click(() => run("pane.focus", { terminal: address })).child("Terminal"));
    const state = this.viewState;
    const toolbar = h_flex().items_center().px(8)
      .child(this.control("mode", state?.mode === "combined" ? "Split" : "Combine", t))
      .child(this.control("layout", state?.layout === "rows" ? "Columns" : "Rows", t))
      .child(this.control("swap", "Swap", t))
      .child(this.control("settings", "Settings", t))
      .child(this.control("headers", state?.showHeaders ? "Hide headers" : "Show headers", t));
    let body;
    if (!this.available) {
      body = div().px(8).text_color(t.muted).child("Waiting for the Stereo View bridge. The terminal remains available.");
    } else if (state?.mode === "combined") {
      body = this.panel("combined", "History", this.combined, t);
    } else {
      const panels = {
        chat: () => this.panel("chat", "Conversation", this.chat, t),
        activity: () => this.panel("activity", "Activity", this.activity, t),
      };
      const container = state?.layout === "rows" ? v_flex() : h_flex();
      body = container.id("stereo-panels").flex_1().min_w(0).min_h(0)
        .on_size_change((size, cx) => {
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const width = size.width / zoom, height = size.height / zoom;
          if (Math.abs(width - this.areaWidth) < 1 && Math.abs(height - this.areaHeight) < 1) return;
          this.areaWidth = width; this.areaHeight = height; cx.notify();
        });
      const order = state?.zoom ? [state.zoom] : state?.side === "right" ? ["activity", "chat"] : ["chat", "activity"];
      for (const [index, name] of order.entries()) {
        if (index > 0) body.child(this.divider(t));
        body.child(panels[name]());
      }
    }
    const root = v_flex().relative().size_full().min_h(0).bg(t.surface).text_size(12)
      .font_family(typeof settings().font_family === "string" ? /** @type {string} */ (settings().font_family) : "monospace")
      .child(div().id("stereo-cell-probe").absolute().top_0().left_0().opacity(0).whitespace_nowrap()
        .on_size_change((size, cx) => this.measureCell(size, cx)).child("MMMMMMMMMM"))
      .child(header)
      .child(state?.showToolbar !== false ? toolbar : div().h(0))
      .child(this.controlError ? div().px(8).text_color(t.muted).child(this.controlError) : div().h(0))
      .child(body);
    if (this.focus) root.track_focus(this.focus).on_key_down((event, cx) => {
      const pane = this.viewState?.mode === "combined" ? this.combined : this.activePane === "chat" ? this.chat : this.activity;
      if (this.focus.is_focused() && event.modifiers?.control && event.key?.toLowerCase() === "c") {
        const text = pane.selection.text();
        if (text) {
          try { cx.write_to_clipboard(text); }
          catch { this.controlError = "Could not copy the selection."; cx.notify(); }
          cx.stop_propagation();
        }
        return;
      }
      if (this.focus.is_focused() && event.key === "escape" && pane.selection.bounds()) {
        pane.selection.clear(); cx.notify(); cx.stop_propagation(); return;
      }
      const key = event.key?.toLowerCase();
      if (this.focus.is_focused() && event.modifiers?.control && event.modifiers?.alt) {
        if (key === "t") this.sendAction("mode", cx);
        else if (key === "s") this.sendAction("swap", cx);
        else if (key === "up" || key === "down" || key === "arrowup" || key === "arrowdown")
          this.activePane = this.activePane === "chat" ? "activity" : "chat";
        else if (["left", "right", "arrowleft", "arrowright"].includes(key)) {
          const direction = key.endsWith("left") ? -1 : 1;
          const rows = this.viewState?.layout === "rows";
          const extent = this.chatExtent() + direction * (rows ? LINE_HEIGHT : 4 * this.cellWidth);
          const value = rows ? Math.max(1, Math.min(240, Math.round(extent / LINE_HEIGHT)))
            : Math.max(24, Math.min(240, Math.round((extent - 16) / this.cellWidth)));
          this.sendSetting(rows ? "chatHeight" : "chatWidth", value, cx);
        } else return;
        cx.notify(); cx.stop_propagation(); return;
      }
      if (this.focus.is_focused() && (key === "pageup" || key === "pagedown" || key === "home" || key === "end")) {
        if (key === "end") pane.handle.scroll_to_bottom();
        else {
          const current = Math.floor(pane.handle.offset().y / LINE_HEIGHT);
          const page = Math.max(1, Math.floor((pane.handle.viewport_size().height || pane.height) / LINE_HEIGHT) - 1);
          const target = key === "home" ? 0 : current + (key === "pageup" ? -page : page);
          pane.handle.scroll_to_item(Math.max(0, Math.min((pane.total ?? 1) - 1, target)));
        }
        cx.notify(); cx.stop_propagation(); return;
      }
      if (event.modifiers?.control && event.key?.toLowerCase() === "f" && this.viewState?.mode === "split") {
        this.openSearch(this.activePane, cx);
        cx.stop_propagation();
      }
    });
    return root;
  }
}
