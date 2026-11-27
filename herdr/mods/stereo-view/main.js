import { View, div } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { checking, exec, panes, props, run, settings, spaces, terminals, theme, window } from "herdr";
import { parseAnsi } from "./ansi.js";
import { createSettingsPanel } from "./settings.js";

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

/** @returns {{total: number | null, revision: number, items: Map<number, {id: string, lines: string[]}>, heights: number[], width: number, height: number, handle: any, fetching: boolean, error: string | null, initial: boolean, lastSize: {width: number, height: number} | null, frameTop: number, frameHeight: number, pressed: boolean}} */
function paneState() {
  return { total: null, revision: -1, items: new Map(), heights: [], width: 80, height: 300,
    handle: VirtualListScrollHandle.new(), fetching: false, error: null, initial: true, lastSize: null,
    frameTop: 0, frameHeight: 0, pressed: false };
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
    (start >= data.total ? data.lines.length === 0 : start + data.lines.length <= data.total) &&
    data.lines.every(/** @param {unknown} */ line => typeof line === "string");
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
      this.viewState = null;
      this.stateGeneration++;
      this.actions = [];
      for (const state of [this.chat, this.activity, this.combined]) {
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
    if (type === "press") state.pressed = true;
    else if (!state.pressed) return;
    const input = { type, button: "left", x, y, shift: !!event.modifiers?.shift, ctrl: !!event.modifiers?.control,
      alt: !!event.modifiers?.alt, clickCount: Math.max(1, Math.min(3, event.click_count || 1)) };
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
        if (reply?.v !== 1 || reply.ok !== true) throw new Error("Action failed");
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
        const currentOffset = state.handle.offset().y;
        const currentViewport = state.handle.viewport_size().height || state.height;
        const stillAtEnd = currentOffset + currentViewport >= state.handle.content_size().height - 2;
        const geometryChanged = state.total !== page.total;
        state.total = page.total;
        state.revision = page.frame;
        state.frameTop = page.top;
        state.frameHeight = page.height;
        state.items.clear();
        for (let i = 0; i < page.lines.length; i++) {
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
      .children(parseAnsi(line.replace(/\u001b_[\s\S]*?\u001b\\/g, "")).map(run => this.ansiRun(t, run)));
  }

  /** @param {string} action @param {string} label @param {any} t */
  control(action, label, t) {
    return div().id(`stereo-action-${action}`).px(6).py(3).cursor_pointer().text_color(t.foreground)
      .hover(s => s.bg(t.hover)).on_click((_event, cx) => {
        if (action === "settings") {
          if (!this.viewState?.preferences) return;
          this.settingsPanel = createSettingsPanel(this.viewState.preferences,
            (key, value, next) => this.sendSetting(key, value, next),
            next => { this.settingsPanel = undefined; next.notify(); });
          cx.notify();
        } else this.sendAction(action, cx);
      }).child(label);
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
    if (name === "activity") actions.child(this.control("compact", this.viewState?.compactTools ? "Full tools" : "Compact tools", t));
    if (name !== "combined") actions.child(this.control(`zoom-${name}`, this.viewState?.zoom === name ? "Restore" : "Maximize", t));
    heading.child(actions);
    const panel = v_flex().flex_1().min_w(0).min_h(0).border_1().border_color(t.border);
    if (name !== "combined" && this.viewState?.showHeaders !== false) panel.child(heading);
    return panel
      .child(state.error ? div().px(8).text_color(t.muted).child(state.error) : div().h(0))
      .child(v_flex().id(`${id}-box`).relative().flex_1().min_h(0)
        .on_size_change((size, cx) => this.sizePane(state, size, cx))
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
      body = container.flex_1().min_w(0).min_h(0).gap(4);
      const order = state?.zoom ? [state.zoom] : state?.side === "right" ? ["activity", "chat"] : ["chat", "activity"];
      for (const name of order) body.child(panels[name]());
    }
    return v_flex().relative().size_full().min_h(0).bg(t.surface).text_size(12)
      .font_family(typeof settings().font_family === "string" ? /** @type {string} */ (settings().font_family) : "monospace")
      .child(div().id("stereo-cell-probe").absolute().top_0().left_0().opacity(0).whitespace_nowrap()
        .on_size_change((size, cx) => this.measureCell(size, cx)).child("MMMMMMMMMM"))
      .child(header)
      .child(state?.showToolbar !== false ? toolbar : div().h(0))
      .child(this.controlError ? div().px(8).text_color(t.muted).child(this.controlError) : div().h(0))
      .child(body);
  }
}
