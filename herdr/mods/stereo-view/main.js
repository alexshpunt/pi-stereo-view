import { View, div } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { checking, exec, panes, props, run, settings, spaces, terminals, theme, window } from "herdr";
import { parseAnsi } from "./ansi.js";

const LABEL = "herdr.stereo.bridge";
const LINE_HEIGHT = 17;
const ESTIMATE = 34;
const PAGE = 64;
const INTERVAL = 700;
const MAX_CACHE = 512;
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

/** @returns {{total: number | null, revision: number, items: Map<number, {id: string, lines: string[]}>, heights: number[], prefix: number[], width: number, height: number, handle: any, fetching: boolean, error: string | null, initial: boolean, refreshCursor: number, lastSize: {width: number, height: number} | null}} */
function paneState() {
  return { total: null, revision: -1, items: new Map(), heights: [], prefix: [0], width: 80, height: 300,
    handle: VirtualListScrollHandle.new(), fetching: false, error: null, initial: true, refreshCursor: 0, lastSize: null };
}

/** @param {ReturnType<typeof paneState>} state */
function rebuild(state) {
  state.heights.length = state.total ?? 0;
  state.prefix = [0];
  for (let i = 0; i < state.heights.length; i++) {
    state.heights[i] ||= ESTIMATE;
    state.prefix.push(state.prefix[i] + state.heights[i]);
  }
}

/** @param {ReturnType<typeof paneState>} state @param {number} px */
function itemAt(state, px) {
  let lo = 0, hi = Math.max(0, state.prefix.length - 1);
  while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (state.prefix[mid] <= px) lo = mid; else hi = mid - 1; }
  return Math.min(lo, Math.max(0, (state.total ?? 1) - 1));
}

/** @param {ReturnType<typeof paneState>} state */
function visibleRange(state) {
  const offset = state.handle.offset().y;
  const viewport = state.handle.viewport_size().height || state.height;
  return { first: itemAt(state, offset), last: itemAt(state, Math.max(offset, offset + viewport - 1)) };
}

/** Load missing visible rows first; rotate through loaded rows to pick up live updates. */
/** @param {ReturnType<typeof paneState>} state */
function nextPage(state) {
  if (!state.total) return { start: 0, count: 0 };
  const { first, last } = visibleRange(state);
  let start = first;
  while (start <= last && state.items.has(start)) start++;
  if (start > last) {
    start = state.refreshCursor >= first && state.refreshCursor <= last ? state.refreshCursor : first;
  }
  return { start, count: Math.min(PAGE, last - start + 1) };
}

/** Keep visible rows even if a very tall viewport needs more than MAX_CACHE entries. */
/** @param {ReturnType<typeof paneState>} state */
function trimCache(state) {
  const { first, last } = visibleRange(state);
  for (const index of state.items.keys()) {
    if (state.items.size <= MAX_CACHE) break;
    if (index < first || index > last) state.items.delete(index);
  }
}

/** @param {any} data @param {number} start @param {number} count */
function validPage(data, start, count) {
  return data?.v === 1 && Number.isSafeInteger(data.revision) && data.revision >= 0 &&
    Number.isSafeInteger(data.total) && data.total >= 0 && data.total <= 1000000 && data.start === start &&
    Array.isArray(data.entries) && data.entries.length <= count && (data.start >= data.total ? data.entries.length === 0 : data.start + data.entries.length <= data.total) &&
    data.entries.every(/** @param {any} item */ item => item && typeof item.id === "string" && Array.isArray(item.lines) && item.lines.every((/** @type {unknown} */ line) => typeof line === "string"));
}

export default class StereoView extends View {
  /** @param {any} _props @param {any} cx */
  init(_props, cx) {
    this.chat = paneState();
    this.activity = paneState();
    // Until the first layout measures the monospace probe, use one em per cell.
    this.cellWidth = 12;
    this.available = false;
    if (checking()) return;
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
      for (const state of [this.chat, this.activity]) {
        state.total = null; state.revision = -1; state.items.clear(); state.heights = []; state.prefix = [0];
        state.initial = true; state.error = null; state.refreshCursor = 0;
      }
    }
    this.fetchPane("chat", this.chat, connection, cx);
    this.fetchPane("activity", this.activity, connection, cx);
  }

  /** @param {string} pane @param {ReturnType<typeof paneState>} state @param {{socket: string, machine?: string, address: string}} connection @param {any} cx */
  fetchPane(pane, state, connection, cx) {
    if (state.fetching) return;
    const offset = state.handle.offset().y;
    const viewport = state.handle.viewport_size().height || state.height;
    const atEnd = state.initial || offset + viewport >= state.handle.content_size().height - 2;
    const { start, count } = nextPage(state);
    const width = state.width;
    state.fetching = true;
    const request = JSON.stringify({ v: 1, op: "page", pane, start, count, width });
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const result = await exec("node", ["-e", CLIENT, connection.socket, request], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Bridge unavailable");
        const page = JSON.parse(result.stdout);
        if (!validPage(page, start, count)) throw new Error("Invalid bridge response");
        // A response belongs only to the connection and width it was requested for.
        const now = bridge();
        if (!isShown() || !now || now.socket !== connection.socket || state.width !== width) return;
        // The revision advances on every request, not only when content changes.
        state.revision = page.revision;
        state.refreshCursor = start + page.entries.length;
        const currentOffset = state.handle.offset().y;
        const currentViewport = state.handle.viewport_size().height || state.height;
        const stillAtEnd = currentOffset + currentViewport >= state.handle.content_size().height - 2;
        let geometryChanged = state.total !== page.total;
        if (state.total !== page.total) {
          state.total = page.total;
          for (const index of state.items.keys()) if (index >= page.total) state.items.delete(index);
          rebuild(state);
        }
        for (let i = 0; i < page.entries.length; i++) {
          const index = start + i;
          const item = page.entries[i];
          state.items.delete(index);
          state.items.set(index, item);
          const height = Math.max(1, item.lines.length) * LINE_HEIGHT + 8;
          if (state.heights[index] !== height) geometryChanged = true;
          state.heights[index] = height;
        }
        rebuild(state);
        trimCache(state);
        if (geometryChanged && (state.initial || (atEnd && stillAtEnd)) && state.total > 0) state.handle.scroll_to_bottom();
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
  }

  /** @param {ReturnType<typeof paneState>} state @param {{width: number, height: number}} size @param {any} cx */
  sizePane(state, size, cx) {
    state.lastSize = size;
    const z = settings().zoom;
    const zoom = typeof z === "number" && z > 0 ? z : 1;
    const width = Math.max(10, Math.min(300, Math.floor((size.width / zoom - 24) / this.cellWidth)));
    const height = Math.max(1, Math.floor(size.height / zoom));
    if (width === state.width && height === state.height) return;
    if (width !== state.width) { state.items.clear(); state.heights = []; rebuild(state); }
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
    return el.child(run.text);
  }

  /** @param {ReturnType<typeof paneState>} state @param {number} index @param {any} t */
  entry(state, index, t) {
    const item = state.items.get(index);
    if (!item) return div().h(state.heights[index] || ESTIMATE).text_color(t.dim).child("Loading…");
    return v_flex().px(8).py(4).overflow_hidden().children(item.lines.map(line =>
      h_flex().h(LINE_HEIGHT).flex_none().whitespace_nowrap().children(parseAnsi(line
        .replace(/\u001b_[\s\S]*?\u001b\\/g, "")
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")).map(run => this.ansiRun(t, run)))));
  }

  /** @param {string} name @param {string} title @param {ReturnType<typeof paneState>} state @param {any} t */
  panel(name, title, state, t) {
    const id = `stereo-${name}`;
    const rows = v_virtual_list(id, state.total ?? 0, state.heights,
      index => `${name}-${index}`,
      range => Array.from({ length: range.end - range.start }, (_, n) => this.entry(state, range.start + n, t)))
      .h(state.height).track_scroll(state.handle);
    return v_flex().flex_1().min_w(0).h_full().border_1().border_color(t.border)
      .child(div().px(8).py(5).text_color(t.muted).child(title))
      .child(state.error ? div().px(8).text_color(t.muted).child(state.error) : div().h(0))
      .child(v_flex().id(`${id}-box`).relative().flex_1().min_h(0)
        .on_size_change((size, cx) => this.sizePane(state, size, cx))
        .child(rows).child(Scrollbar.vertical(id).absolute().inset_0()));
  }

  render() {
    const t = theme();
    const address = terminalAddress();
    const terminalPane = panes().find(p => p.terminal === address);
    const header = h_flex().items_center().justify_between().px(8).py(5)
      .child(div().text_color(t.foreground).child("Stereo View"));
    if (terminalPane) header.child(div().id("stereo-terminal").px(8).py(4).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover)).on_click(() => run("pane.focus", { terminal: address })).child("Terminal"));
    return v_flex().relative().size_full().min_h(0).bg(t.surface).text_size(12)
      .font_family(typeof settings().font_family === "string" ? /** @type {string} */ (settings().font_family) : "monospace")
      .child(div().id("stereo-cell-probe").absolute().top_0().left_0().opacity(0).whitespace_nowrap()
        .on_size_change((size, cx) => this.measureCell(size, cx)).child("MMMMMMMMMM"))
      .child(header)
      .child(this.available ? h_flex().flex_1().min_h(0).gap(4)
        .child(this.panel("chat", "Conversation", this.chat, t))
        .child(this.panel("activity", "Activity", this.activity, t)) :
        div().px(8).text_color(t.muted).child("Waiting for the Stereo View bridge. The terminal remains available."));
  }
}
