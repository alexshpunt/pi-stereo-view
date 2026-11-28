import { View, div, image, svg } from "gpui-kit";
import { mkdir, writeFile, unlink } from "fs/promises";
import { h_flex, v_flex, v_virtual_list, VirtualListScrollHandle, ScrollHandle, Scrollbar, Input, InputState } from "gpui-base";
import { appHome, checking, exec, panes, props, run, settings, spaces, terminals, theme, window } from "herdr";
import { parseAnsi } from "./ansi.js";
import { createSettingsPanel } from "./settings.js";
import { createSearchBar } from "./search-bar.js";
import { createSelection } from "./selection.js";
import { dialogKey } from "./dialog-keys.js";
import { createImagePruner } from "./image-pruner.js";

const LABEL = "herdr.stereo.bridge";
const LINE_HEIGHT = 17;
const PAGE = 256;
const INTERVAL = 700;
const ICON_SIZE = 14; // Toolbar icon edge in logical pixels.
const NARROW_CONTROLS_WIDTH = 400; // Switch to icons when text controls no longer fit.
/** @typedef {{id:number, frame:number, mouseFrame:number, focused:boolean, row:number, col:number, width:number, height:number, lines:string[]}} OverlayLayer */
/** @typedef {{revision:number, columns:number, rows:number, overlays:OverlayLayer[]}} OverlayPage */
// GPUI snaps each virtual row to a whole window pixel before scrolling.
function rowHeight() {
  const zoom = settings().zoom;
  const scale = typeof zoom === "number" && zoom > 0 ? zoom : 1;
  return Math.round(LINE_HEIGHT * scale) / scale;
}
// The shell's binary fs bindings can yield empty files. Decode and verify in a
// local Node process after writing only ASCII through its text binding.
const IMAGE_DECODE = `const fs=require('node:fs'),crypto=require('node:crypto');
const [input,output,id]=process.argv.slice(1),data=Buffer.from(fs.readFileSync(input,'utf8'),'base64');
if(crypto.createHash('sha256').update(data).digest('hex')!==id)process.exit(2);
const temp=output+'.'+process.pid+'.tmp';
try{fs.writeFileSync(temp,data);fs.renameSync(temp,output);}finally{try{fs.unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e}}`;
// Keeps the newest 200 decoded images from earlier runs. It runs once per process
// before this process writes its first image, so it never removes a file in use.
const IMAGE_PRUNE = `const fs=require('node:fs'),path=require('node:path');const dir=process.argv[1];
const files=fs.readdirSync(dir).filter(n=>/^[0-9a-f]{64}\\.(png|jpg|gif|webp)$/.test(n))
.map(n=>({n,t:fs.statSync(path.join(dir,n)).mtimeMs})).sort((a,b)=>b.t-a.t);
for(const f of files.slice(200))fs.unlinkSync(path.join(dir,f.n));`;
const pruneImages = createImagePruner(() => exec("node", ["-e", IMAGE_PRUNE, `${appHome()}/data/stereo-view/images`], { timeout: 5000 }));
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

/** @returns {{total: number | null, revision: number, items: Map<number, {id: string, lines: string[]}>, heights: number[], width: number, height: number, handle: any, fetching: boolean, error: string | null, initial: boolean, lastSize: {width: number, height: number} | null, frameTop: number, frameHeight: number, pressed: boolean, following: boolean, searchState: any, searchBar: any, selectionRows: Map<number, any>, selection: any, selecting: boolean, pressPoint: {row: number, col: number, moved: boolean} | null, images: any[], jumpSerial: number, copying: boolean, selectionOnly: boolean, autoScroll: number, autoScrollTimer: boolean, selectionFocus: {row: number, col: number} | null}} */
function paneState() {
  const selectionRows = new Map();
  return { total: null, revision: -1, items: new Map(), heights: [], width: 80, height: 300,
    handle: VirtualListScrollHandle.new(), fetching: false, error: null, initial: true, lastSize: null,
    frameTop: 0, frameHeight: 0, pressed: false, following: true, searchState: null, searchBar: null,
    selectionRows, selection: createSelection(index => selectionRows.get(index)), selecting: false, pressPoint: null, images: [], jumpSerial: 0,
    copying: false, selectionOnly: false, autoScroll: 0, autoScrollTimer: false, selectionFocus: null };
}

/** Render the visible terminal rows, including one extra row for a partial scroll. */
/** @param {ReturnType<typeof paneState>} state */
function nextPage(state) {
  const offset = state.handle.offset().y;
  const viewport = state.handle.viewport_size().height || state.height;
  const visible = Math.max(1, Math.ceil(viewport / rowHeight()) + 1);
  const start = Math.max(0, Math.floor(offset / rowHeight()) - visible);
  return { start, count: Math.min(PAGE, visible * 3) };
}

/** @param {any} data @param {number} start @param {number} count @param {number} width @param {boolean} following */
function validView(data, start, count, width, following) {
  return data?.v === 1 && Number.isSafeInteger(data.frame) && data.frame > 0 &&
    Number.isSafeInteger(data.total) && data.total >= 0 && data.total <= 1000000 &&
    Number.isSafeInteger(data.top) && data.top >= 0 && (following || data.top === start) && data.height === count && data.width === width &&
    Number.isSafeInteger(data.scrollShift) && Array.isArray(data.lines) && data.lines.length <= count &&
    Array.isArray(data.selection) && data.selection.length === data.lines.length &&
    Array.isArray(data.images) && data.images.length <= 256 && data.images.every(/** @param {any} */ image =>
      typeof image?.id === "string" && /^[a-f0-9]{64}$/.test(image.id) &&
      [image.row, image.column, image.rows, image.columns].every(Number.isSafeInteger) &&
      image.row >= 0 && image.column >= 0 && image.rows > 0 && image.rows <= 4096 &&
      image.columns > 0 && image.columns <= 4096 && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mime)) &&
    data.selection.every(/** @param {any} */ row => Array.isArray(row?.cells) && Array.isArray(row.words)) &&
    (data.top >= data.total ? data.lines.length === 0 : data.top + data.lines.length <= data.total) &&
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
    this.surface = null;
    /** @type {OverlayPage | null} */ this.overlays = null;
    this.overlaysPending = false;
    this.overlayPress = null;
    this.controlHeight = 400;
    this.surfacePending = false;
    this.dock = null;
    this.dockPending = false;
    this.dockScroll = ScrollHandle.new();
    this.dockPress = null;
    this.actions = [];
    this.surfaceInput = null;
    this.surfaceScroll = ScrollHandle.new();
    this.surfacePress = null;
    this.actionPending = false;
    this.areaWidth = 800;
    this.controlWidth = 800;
    this.hoverPane = null;
    this.hoverKey = "";
    this.hoverAt = 0;
    this.imagePaths = new Map();
    this.imagePending = new Set();
    this.imageQueue = [];
    this.imageWorkers = 0;
    this.imageFailures = new Map();
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
      this.closeSurfaceInput();
      this.surface = null;
      this.actions = [];
      this.overlays = null; this.overlayPress = null;
      for (const state of [this.chat, this.activity, this.combined]) {
        state.searchBar?.dispose(); state.searchBar = null; state.searchState = null;
        state.selection.clear(); state.selectionRows.clear(); state.selecting = false;
        state.total = null; state.revision = -1; state.items.clear(); state.heights = [];
        state.initial = true; state.following = true; state.error = null; state.pressed = false; state.images = []; state.jumpSerial = 0;
        state.selectionOnly = false; state.autoScroll = 0; state.selectionFocus = null;
      }
    }
    this.fetchState(connection, cx);
    this.fetchSurface(connection, cx);
    this.fetchOverlays(connection, cx);
    this.fetchDock(connection, cx);
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

  /** Read Pi's live dialog without replacing its owner in the terminal. */
  /** @param {{socket: string, machine?: string}} connection @param {any} cx */
  fetchSurface(connection, cx) {
    if (this.surfacePending || this.surfacePress || this.actionPending || this.actions.length) return;
    this.surfacePending = true;
    const width = Math.max(10, Math.min(300, Math.floor((this.areaWidth - 32) / this.cellWidth)));
    cx.spawn(async (/** @type {any} */ next) => {
      try {
        const request = JSON.stringify({ v: 1, op: "surface", width });
        const result = await exec("node", ["-e", CLIENT, connection.socket, request], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Surface unavailable");
        const surface = JSON.parse(result.stdout);
        if (surface.v !== 1 || typeof surface.active !== "boolean" || !Number.isSafeInteger(surface.frame) ||
            !Number.isSafeInteger(surface.mouseFrame) ||
            !Array.isArray(surface.lines) || surface.lines.length > 256 || !surface.lines.every(/** @param {unknown} */ line => typeof line === "string")) throw new Error("Invalid surface");
        if (bridge()?.socket !== connection.socket || !isShown()) return;
        this.surface = { ...surface, width };
        this.syncSurfaceInput(next);
      } catch {
        // An unsupported or unavailable surface leaves the terminal as the fallback.
        this.surface = null;
        this.syncSurfaceInput(next);
      } finally { this.surfacePending = false; next.notify(); }
    });
  }

  /** Read Pi's ordered overlay stack without replacing the history. */
  /** @param {{socket:string,machine?:string}} connection @param {any} cx */
  fetchOverlays(connection, cx) {
    if (this.overlaysPending || this.overlayPress || this.actionPending || this.actions.length) return;
    this.overlaysPending = true;
    cx.spawn(async (/** @type {any} */ next) => {
      try {
        const result = await exec("node", ["-e", CLIENT, connection.socket, JSON.stringify({ v: 1, op: "overlays" })], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Overlays unavailable");
        const data = JSON.parse(result.stdout);
        const integer = (/** @type {unknown} */ n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
        if (data.v !== 1 || !integer(data.revision) || !integer(data.columns) || !integer(data.rows) ||
            !Array.isArray(data.overlays) || data.overlays.length > 100 || data.overlays.some((/** @type {any} */ layer) =>
              ![layer.id, layer.frame, layer.mouseFrame, layer.row, layer.col, layer.width, layer.height].every(integer) ||
              layer.id < 1 || layer.frame < 1 || layer.mouseFrame < 1 || layer.width < 1 || layer.width > 4096 ||
              layer.height < 1 || layer.height > 256 || typeof layer.focused !== "boolean" ||
              !Array.isArray(layer.lines) || layer.lines.length > layer.height || layer.lines.some((/** @type {unknown} */ line) => typeof line !== "string"))) throw new Error("Invalid overlays");
        if (bridge()?.socket !== connection.socket || !isShown()) return;
        this.overlays = data;
        this.syncSurfaceInput(next);
      } catch { this.overlays = null; this.syncSurfaceInput(next); }
      finally { this.overlaysPending = false; next.notify(); }
    });
  }

  /** @param {any} cx */
  syncSurfaceInput(cx) {
    if (this.overlays?.overlays.some(layer => layer.focused) || this.surface?.active || this.dock?.focused) this.openSurfaceInput(cx);
    else this.closeSurfaceInput();
  }

  /** Read the non-editor dock while keeping the history visible. */
  /** @param {{socket: string, machine?: string}} connection @param {any} cx */
  fetchDock(connection, cx) {
    if (this.dockPending || this.dockPress || this.actionPending || this.actions.length) return;
    this.dockPending = true;
    const width = Math.max(10, Math.min(300, Math.floor((this.areaWidth - 32) / this.cellWidth)));
    cx.spawn(async (/** @type {any} */ next) => {
      try {
        const request = JSON.stringify({ v: 1, op: "surface", target: "dock", width });
        const result = await exec("node", ["-e", CLIENT, connection.socket, request], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Dock unavailable");
        const dock = JSON.parse(result.stdout);
        if (dock.v !== 1 || typeof dock.active !== "boolean" || typeof dock.focused !== "boolean" ||
            !Number.isSafeInteger(dock.frame) || !Number.isSafeInteger(dock.mouseFrame) ||
            !Array.isArray(dock.lines) || dock.lines.length > 256 || !dock.lines.every((/** @type {unknown} */ line) => typeof line === "string")) throw new Error("Invalid dock");
        if (bridge()?.socket !== connection.socket || !isShown()) return;
        this.dock = { ...dock, width };
        this.syncSurfaceInput(next);
      } catch { this.dock = null; this.syncSurfaceInput(next); }
      finally { this.dockPending = false; next.notify(); }
    });
  }

  /** Capture platform text input and paste without drawing a second editor. @param {any} cx */
  openSurfaceInput(cx) {
    if (this.surfaceInput) return;
    const input = InputState.new({ placeholder: "Type or paste into Pi" });
    this.surfaceInput = input;
    let clearing = false;
    input.on("change", (_event, cx) => {
      if (clearing || this.surfaceInput !== input) return;
      const value = input.value();
      if (!value) return;
      clearing = true;
      try { input.set_value(""); } finally { clearing = false; }
      if (!this.overlays?.overlays.some(layer => layer.focused) && !this.surface?.active && !this.dock?.focused) return;
      // Bracket multi-character input so pasted control characters do not become keys.
      // Escape bytes could terminate a terminal paste or trigger a control sequence.
      if (value.includes("\0") || value.includes("\x1b")) {
        this.controlError = "Could not send this text to the dialog."; cx.notify(); return;
      }
      const characters = Array.from(value);
      const data = characters.length === 1 ? value : `\x1b[200~${value}\x1b[201~`;
      const parts = Array.from(data);
      for (let i = 0; i < parts.length; i += 256) this.sendSurfaceData(parts.slice(i, i + 256).join(""), cx);
    });
    cx.timer.after(50, () => { if (this.surfaceInput === input && isShown()) input.focus(); });
  }

  closeSurfaceInput() {
    this.surfacePress = null;
    const input = this.surfaceInput;
    if (!input) return;
    this.surfaceInput = null;
    input.blur();
    input.release();
  }

  /** @param {string} data @param {any} cx */
  sendSurfaceData(data, cx) {
    const connection = bridge();
    const overlay = [...(this.overlays?.overlays ?? [])].reverse().find(layer => layer.focused);
    const dialog = !overlay && this.surface?.active ? this.surface : null;
    const dock = !overlay && !dialog && this.dock?.active && this.dock.focused ? this.dock : null;
    if (!data || !connection || (!overlay && !dialog && !dock)) return false;
    const request = overlay ? { v: 1, op: "overlay-key", revision: this.overlays.revision, id: overlay.id, frame: overlay.frame, data }
      : { v: 1, op: "surface-key", frame: (dialog || dock).frame, data, ...(dock ? { target: "dock" } : {}) };
    this.actions.push({ request, connection });
    this.drainActions(cx);
    return true;
  }

  /** @param {any} event @param {any} cx */
  sendSurfaceKey(event, cx) {
    const data = dialogKey(event);
    return data ? this.sendSurfaceData(data, cx) : false;
  }

  /** Forward cell coordinates for the exact dialog frame currently on screen. */
  /** @param {"press"|"release"|"drag"} type @param {any} event @param {any} cx */
  sendSurfaceMouse(type, event, cx) {
    if (!this.surface?.active || !event.local_position) return;
    const connection = bridge(); if (!connection) return;
    const zoomValue = settings().zoom;
    const zoom = typeof zoomValue === "number" && zoomValue > 0 ? zoomValue : 1;
    const x = Math.floor((event.local_position.x / zoom - 8) / this.cellWidth);
    const y = Math.floor((event.local_position.y / zoom + this.surfaceScroll.offset().y - 4) / rowHeight());
    const inside = x >= 0 && x < this.surface.width && y >= 0 && y < this.surface.lines.length;
    if (type === "press") {
      if (!inside || this.surfacePending || !Number.isSafeInteger(this.surface.mouseFrame)) return;
      this.surfacePress = { frame: this.surface.mouseFrame, x, y };
    }
    if (!this.surfacePress) return;
    const target = this.surfacePress;
    // An outside release must end capture without synthesizing a click.
    const px = Math.max(0, Math.min(this.surface.width - 1, x));
    const py = Math.max(0, Math.min(this.surface.lines.length - 1, y));
    this.actions.push({ request: { v: 1, op: "surface-mouse", frame: target.frame,
      event: { type, button: "left", x: px, y: py, ...(type === "release" && !inside ? { cancel: true } : {}) } }, connection });
    if (type === "release") this.surfacePress = null;
    this.drainActions(cx);
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
    const offset = state.handle.offset().y;
    const viewport = state.handle.viewport_size().height || state.height;
    const following = state.following;
    const top = Math.max(0, Math.floor(offset / rowHeight()));
    const height = Math.min(PAGE, Math.max(1, Math.ceil(viewport / rowHeight()) + 1));
    this.sendSearch(pane, { action: "open", top, height, following }, cx);
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
      state.selectionOnly = false; state.autoScroll = 0; state.selectionFocus = null;
      state.pressPoint = { row, col: x, moved: false };
      const count = Math.max(1, Math.min(3, event.click_count || 1));
      state.selection.start({ row, col: x }, count === 3 ? "line" : count === 2 ? "word" : "character");
      if (pane === "chat" || pane === "activity") this.activePane = pane;
      this.focus?.focus();
      cx.notify();
    } else if (!state.pressed) return;
    else if (type === "drag" || type === "release") {
      if (state.pressPoint && (state.pressPoint.row !== row || state.pressPoint.col !== x)) state.pressPoint.moved = true;
      state.selection.extend({ row, col: x });
      if (type === "release" && state.pressPoint && !state.pressPoint.moved && (event.click_count || 1) === 1)
        this.openLink(state, row, x, cx);
      cx.notify();
    }
    const input = { type, button: "left", x, y, shift: !!event.modifiers?.shift, ctrl: !!event.modifiers?.control,
      alt: !!event.modifiers?.alt, clickCount: Math.max(1, Math.min(3, event.click_count || 1)) };
    if (type === "drag") this.actions = this.actions.filter(item => !(item.request.op === "mouse" && item.request.pane === pane && item.request.event.type === "drag"));
    this.actions.push({ request: { v: 1, op: "mouse", pane, frame: state.revision, event: input }, connection });
    if (type === "release") state.pressed = false;
    this.drainActions(cx);
  }

  /** Send bounded pointer motion without taking keyboard focus or starting a selection. */
  /** @param {string} pane @param {ReturnType<typeof paneState>} state @param {any} event @param {any} cx */
  sendHover(pane, state, event, cx) {
    if (pane === "combined" || !this.viewState?.preferences?.turns || !this.viewState.preferences.turnHover || !event.local_position) return;
    const z = settings().zoom;
    const zoom = typeof z === "number" && z > 0 ? z : 1;
    const px = event.local_position.x / zoom, py = event.local_position.y / zoom;
    const inside = px >= 0 && px < (state.lastSize?.width ?? 0) / zoom && py >= 0 && py < (state.handle.viewport_size().height || state.height);
    if (!inside && this.hoverPane !== pane) return;
    if (state.pressed || state.fetching || state.revision < 1) return;
    const x = inside ? Math.floor((px - 8) / this.cellWidth) : -1;
    const y = inside ? Math.floor((state.handle.offset().y + py) / rowHeight()) - state.frameTop : -1;
    if (inside && (x < 0 || x >= state.width || y < 0 || y >= state.frameHeight)) return;
    const key = `${pane}:${x}:${y}`;
    if (this.hoverKey === key || (inside && Date.now() - this.hoverAt < 100)) return;
    const connection = bridge(); if (!connection) return;
    this.hoverPane = inside ? pane : null;
    this.hoverKey = key; this.hoverAt = Date.now();
    this.actions = this.actions.filter(item => !(item.request.op === "mouse" && item.request.event.type === "move"));
    this.actions.push({ request: { v: 1, op: "mouse", pane, frame: state.revision,
      event: { type: "move", button: "none", x, y } }, connection });
    this.drainActions(cx);
  }

  /** @param {string} pane @param {ReturnType<typeof paneState>} state @param {any} cx */
  scrollSelection(pane, state, cx) {
    if (state.autoScrollTimer || !state.autoScroll || !state.pressed) return;
    state.autoScrollTimer = true;
    cx.timer.after(70, (/** @type {any} */ next) => {
      state.autoScrollTimer = false;
      if (!state.pressed || !state.selectionOnly || !state.autoScroll || !state.total) return;
      const viewport = state.handle.viewport_size().height || state.height;
      const visible = Math.max(1, Math.floor(viewport / rowHeight()));
      const top = Math.max(0, Math.floor(state.handle.offset().y / rowHeight()));
      const nextTop = Math.max(0, Math.min(Math.max(0, state.total - visible), top + state.autoScroll * 3));
      state.following = false;
      state.handle.scroll_to_item(nextTop);
      const row = Math.min(state.total - 1, state.autoScroll > 0 ? nextTop + visible - 1 : nextTop);
      state.selectionFocus = { row, col: state.selectionFocus?.col ?? 0 };
      if (state.selectionRows.has(row)) state.selection.extend(state.selectionFocus);
      const connection = bridge();
      if (connection) this.fetchPane(pane, state, connection, next);
      next.notify();
      if (nextTop !== top) this.scrollSelection(pane, state, next);
    });
  }

  /** @param {string} pane @param {ReturnType<typeof paneState>} state @param {any} cx */
  copySelection(pane, state, cx) {
    const connection = bridge();
    const bounds = state.selection.bounds();
    if (!connection || !bounds || state.copying) return;
    const cached = state.selection.text();
    if (cached) {
      try { cx.write_to_clipboard(cached); this.controlError = null; }
      catch { this.controlError = "Could not copy the selection. Try again."; cx.notify(); }
      return;
    }
    state.copying = true;
    const width = state.width;
    cx.spawn(async (/** @type {any} */ next) => {
      try {
        // Let an already-running view finish before making the first copy page.
        for (let attempt = 0; state.fetching && attempt < 120; attempt++)
          await new Promise(resolve => next.timer.after(50, resolve));
        if (state.fetching || state.pressed || this.actionPending || this.actions.length) throw new Error("Panel is busy");
        const text = await state.selection.readText(async (/** @type {number} */ top, /** @type {number} */ height) => {
          if (bridge()?.socket !== connection.socket || state.width !== width) throw new Error("Panel changed");
          const request = JSON.stringify({ v: 1, op: "view", pane, top, height, width, following: false });
          const result = await exec("node", ["-e", CLIENT, connection.socket, request], { on: connection.machine, timeout: 5000 });
          if (result.code !== 0) throw new Error("Bridge unavailable");
          const page = JSON.parse(result.stdout);
          if (!validView(page, top, height, width, false) || page.lines.length !== height || page.scrollShift ||
              page.total <= bounds.end.row) throw new Error("History changed while copying");
          return page.selection;
        });
        if (text) next.write_to_clipboard(text);
        this.controlError = null;
      } catch { this.controlError = "Could not copy the selection. Try again."; }
      finally { state.copying = false; this.refresh(next); next.notify(); }
    });
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
            pane.following = !!reply.restored?.following;
            if (pane.following) pane.handle.scroll_to_bottom();
            else if (Number.isSafeInteger(reply.restored?.top)) pane.handle.scroll_to_item(reply.restored.top);
          } else if (Number.isSafeInteger(reply.top)) { pane.following = false; pane.handle.scroll_to_item(reply.top); }
        } else if (reply.ok !== true && !(request.op === "surface-mouse" && reply.ok === false)) throw new Error("Action failed");
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
    if (state.fetching || state.copying || (state.pressed && !state.selectionOnly) || this.actionPending || this.actions.length) return;
    const following = state.following;
    const { start, count } = nextPage(state);
    const width = state.width;
    state.fetching = true;
    const request = JSON.stringify({ v: 1, op: "view", pane, top: start, height: count, width, following });
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const result = await exec("node", ["-e", CLIENT, connection.socket, request], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Bridge unavailable");
        const page = JSON.parse(result.stdout);
        if (!validView(page, start, count, width, following)) throw new Error("Invalid bridge response");
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
        const geometryChanged = state.total !== page.total;
        state.total = page.total;
        state.revision = page.frame;
        state.frameTop = page.top;
        state.frameHeight = page.height;
        if (Number.isSafeInteger(page.jump?.serial) && page.jump.serial > state.jumpSerial &&
            Number.isSafeInteger(page.jump.top) && page.jump.top >= 0 && page.jump.top < page.total) {
          state.jumpSerial = page.jump.serial;
          state.following = false;
          state.handle.scroll_to_item(page.jump.top);
          if (pane === "chat" || pane === "activity") this.activePane = pane;
        }
        state.images = state.images.filter(placement => placement.row + placement.rows <= page.top || placement.row >= page.top + page.height);
        state.images.push(...page.images);
        if (state.images.length > 512) state.images.splice(0, state.images.length - 512);
        for (const placement of page.images) this.loadImage(placement, connection, cx);
        for (let i = 0; i < page.lines.length; i++) {
          const index = page.top + i;
          state.selectionRows.set(index, page.selection[i]);
          state.items.delete(index);
          state.items.set(index, { id: `${page.frame}:${index}`, lines: [page.lines[i]] });
        }
        if (state.selectionFocus && state.selectionRows.has(state.selectionFocus.row)) {
          state.selection.extend(state.selectionFocus);
          if (!state.pressed || !state.selectionOnly) state.selectionFocus = null;
        }
        for (const index of state.items.keys()) {
          if (index >= page.total || (index >= page.top + page.lines.length && index < page.top + count)) {
            state.items.delete(index);
            if (!state.selection.endpoints().includes(index) || index >= page.total) state.selectionRows.delete(index);
          }
        }
        while (state.items.size > 1024) {
          const oldest = state.items.keys().next().value;
          if (oldest === undefined) break;
          state.items.delete(oldest);
          if (!state.selection.endpoints().includes(oldest)) state.selectionRows.delete(oldest);
        }
        for (const index of state.selectionRows.keys()) {
          if (!state.items.has(index) && !state.selection.endpoints().includes(index)) state.selectionRows.delete(index);
        }
        if (geometryChanged && following && state.following && state.total > 0) state.handle.scroll_to_bottom();
        else if (!following && page.scrollShift && state.total > 0)
          state.handle.scroll_to_item(Math.max(0, Math.min(state.total - 1, Math.floor(currentOffset / rowHeight()) + page.scrollShift)));
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
    return el.child(run.text);
  }

  /** @param {any} placement @param {{socket:string,machine?:string}} connection @param {any} cx */
  loadImage(placement, connection, cx) {
    const id = placement.id;
    if (this.imagePaths.has(id) || this.imagePending.has(id) || Date.now() - (this.imageFailures.get(id) ?? 0) < 5000) return;
    this.imageFailures.delete(id);
    this.imagePending.add(id);
    this.imageQueue.push({ placement, connection });
    if (this.imageQueue.length > 64) this.imagePending.delete(this.imageQueue.shift().placement.id);
    this.drainImages(cx);
  }

  /** @param {any} cx */
  drainImages(cx) {
    if (this.imageWorkers >= 4 || !this.imageQueue.length) return;
    const { placement, connection } = this.imageQueue.shift();
    const id = placement.id;
    this.imageWorkers++;
    cx.spawn(async (/** @type {any} */ next) => {
      try {
        let encoded = "", total = -1;
        while (total < 0 || encoded.length < total) {
          const request = { v: 1, op: "image", id, offset: encoded.length, length: 524288 };
          const result = await exec("node", ["-e", CLIENT, connection.socket, JSON.stringify(request)], { on: connection.machine, timeout: 5000 });
          if (result.code !== 0 || bridge()?.socket !== connection.socket) throw new Error("Image unavailable");
          const chunk = JSON.parse(result.stdout);
          if (chunk.v !== 1 || !Number.isSafeInteger(chunk.total) || chunk.total < 1 || chunk.total > 22369624 ||
              (total !== -1 && total !== chunk.total) || typeof chunk.data !== "string" || !chunk.data.length ||
              !/^[A-Za-z0-9+/=]+$/.test(chunk.data) || encoded.length + chunk.data.length > chunk.total) throw new Error("Invalid image response");
          total = chunk.total;
          encoded += chunk.data;
        }
        const extension = placement.mime === "image/jpeg" ? "jpg" : placement.mime.slice(6);
        const relative = `data/stereo-view/images/${id}.${extension}`;
        const directory = `${appHome()}/data/stereo-view/images`;
        await mkdir(directory, { recursive: true });
        await pruneImages();
        const temporary = `${directory}/${id}-${Math.random().toString(36).slice(2)}.base64`;
        await writeFile(temporary, encoded);
        try {
          const decoded = await exec("node", ["-e", IMAGE_DECODE, temporary, `${directory}/${id}.${extension}`, id], { timeout: 15000 });
          if (decoded.code !== 0) throw new Error("Image data could not be decoded");
        } finally { await unlink(temporary); }
        this.imagePaths.set(id, relative);
      } catch (error) { this.imageFailures.set(id, Date.now()); console.warn("Stereo View image failed", error); }
      finally { this.imagePending.delete(id); this.imageWorkers--; this.drainImages(next); next.notify(); }
    });
  }

  /** @param {ReturnType<typeof paneState>} state @param {number} row @param {number} column @param {any} cx */
  openLink(state, row, column, cx) {
    const item = state.items.get(row), metadata = state.selectionRows.get(row);
    if (!item || !metadata || state.selection.bounds()) return;
    let character = 0;
    for (const cell of metadata.cells) {
      if (column >= cell.start && column < cell.end) break;
      character += cell.text.length;
    }
    let offset = 0;
    for (const run of parseAnsi(item.lines[0])) {
      if (character >= offset && character < offset + run.text.length &&
          typeof run.link === "string" && /^https?:\/\/[^/\s?#]+/i.test(run.link)) {
        cx.open_url(run.link); return;
      }
      offset += run.text.length;
    }
  }

  /** @param {ReturnType<typeof paneState>} state @param {number} index @param {any} t */
  entry(state, index, t) {
    const item = state.items.get(index);
    if (!item) return div().h(LINE_HEIGHT).flex_none();
    const line = item.lines[0] ?? "";
    const row = h_flex().relative().w_full().px(8).h(LINE_HEIGHT).flex_none().whitespace_nowrap().overflow_hidden()
      .children(selectedRuns(parseAnsi(line), state.selectionRows.get(index),
        state.selection.columns(index)).map(run => this.ansiRun(t, run)));
    for (const placement of state.images) {
      const path = this.imagePaths.get(placement.id);
      if (path && index >= placement.row && index < placement.row + placement.rows) {
        row.child(image(path).absolute().left(8 + placement.column * this.cellWidth)
          .top(-(index - placement.row) * LINE_HEIGHT).w(placement.columns * this.cellWidth)
          .h(placement.rows * LINE_HEIGHT));
      } else if (!path && index === placement.row) {
        row.child(div().text_color(t.muted).child(this.imageFailures.has(placement.id) ? "[Image unavailable]" : "[Loading image…]"));
      }
    }
    return row;
  }

  /** @param {string} action @param {string} label @param {any} t */
  control(action, label, t) {
    const state = this.viewState;
    const icons = state?.preferences?.buttonStyle === "icons" || this.controlWidth < NARROW_CONTROLS_WIDTH;
    const icon = action === "mode" ? (state?.mode === "combined" ? "split" : "combine")
      : action === "layout" ? (state?.layout === "rows" ? "columns" : "rows")
      : action.startsWith("find-") ? "find"
      : action.startsWith("zoom-") ? (state?.zoom === action.slice(5) ? "restore" : "maximize")
      : action === "compact" ? (state?.compactTools ? "full" : "compact") : action;
    return div().id(`stereo-action-${action}`).accessibility_label(label).tooltip(label).px(6).py(3).cursor_pointer().text_color(t.foreground)
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
      }).child(icons ? svg(`mods/stereo-view/icons/${icon}.svg`).id(`stereo-icon-${action}`).size(ICON_SIZE).text_color(t.foreground) : label);
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
    const rows = v_virtual_list(id, state.total ?? 0, LINE_HEIGHT,
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
    if (this.viewState?.mode === "split" && this.viewState.layout === "columns") panel.h_full();
    else panel.w_full();
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
        .on_scroll_wheel((_event, cx) => {
          if (name === "chat" || name === "activity") this.activePane = name;
          state.following = false;
          cx.timer.after(100, next => {
            const offset = state.handle.offset().y;
            const viewport = state.handle.viewport_size().height || state.height;
            state.following = offset + viewport >= state.handle.content_size().height - 2;
            const connection = bridge(); if (connection) this.fetchPane(name, state, connection, next);
          });
        })
        .on_mouse_down("left", (event, cx) => {
          if (!event.local_position) return;
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const row = Math.floor((state.handle.offset().y + event.local_position.y / zoom) / rowHeight());
          this.sendMouse(name, state, row, "press", event, cx);
        })
        .on_window_mouse_move((event, cx) => {
          if (!state.pressed) { this.sendHover(name, state, event, cx); return; }
          if (!event.local_position) return;
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const y = event.local_position.y / zoom;
          const viewport = state.handle.viewport_size().height || state.height;
          const row = Math.floor((state.handle.offset().y + y) / rowHeight());
          const direction = y < 0 ? -1 : y >= viewport ? 1 : 0;
          if (direction && !state.selectionOnly) {
            // End the native gesture as a drag before paging invalidates its frame.
            this.sendMouse(name, state, row, "drag", event, cx);
            this.sendMouse(name, state, row, "release", event, cx);
            state.pressed = true;
            state.selectionOnly = true;
          }
          if (!state.selectionOnly) { this.sendMouse(name, state, row, "drag", event, cx); return; }
          const col = Math.max(0, Math.floor((event.local_position.x / zoom - 8) / this.cellWidth));
          state.autoScroll = direction;
          state.selectionFocus = { row: Math.max(0, Math.min((state.total ?? 1) - 1, row)), col };
          if (state.selectionRows.has(state.selectionFocus.row)) state.selection.extend(state.selectionFocus);
          if (direction) this.scrollSelection(name, state, cx);
          cx.notify();
        })
        .on_window_mouse_up("left", (event, cx) => {
          if (!state.pressed || !event.local_position) return;
          state.autoScroll = 0;
          if (state.selectionOnly) {
            state.pressed = false; state.selectionOnly = false; state.selecting = false;
            const connection = bridge(); if (connection) this.fetchPane(name, state, connection, cx);
            cx.notify(); return;
          }
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const row = Math.floor((state.handle.offset().y + event.local_position.y / zoom) / rowHeight());
          this.sendMouse(name, state, row, "release", event, cx);
        })
        .child(rows).child(Scrollbar.vertical(id).absolute().inset_0()));
  }

  /** @param {"press"|"release"|"drag"} type @param {any} event @param {any} cx */
  sendDockMouse(type, event, cx) {
    if (!this.dock?.active || !event.local_position) return;
    const connection = bridge(); if (!connection) return;
    const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
    const x = Math.floor((event.local_position.x / zoom - 8) / this.cellWidth);
    const y = Math.floor((event.local_position.y / zoom + this.dockScroll.offset().y - 4) / rowHeight());
    const inside = x >= 0 && x < this.dock.width && y >= 0 && y < this.dock.lines.length;
    if (type === "press") {
      if (!inside || this.dockPending) return;
      this.dockPress = { frame: this.dock.mouseFrame };
    }
    if (!this.dockPress) return;
    const px = Math.max(0, Math.min(this.dock.width - 1, x));
    const py = Math.max(0, Math.min(this.dock.lines.length - 1, y));
    this.actions.push({ request: { v: 1, op: "surface-mouse", target: "dock", frame: this.dockPress.frame,
      event: { type, button: "left", x: px, y: py, ...(type === "release" && !inside ? { cancel: true } : {}) } }, connection });
    if (type === "release") this.dockPress = null;
    this.drainActions(cx);
  }

  /** @param {any} t */
  renderDock(t) {
    const body = v_flex().id("stereo-dock").relative().flex_none().max_h(200).overflow_y_scroll()
      .track_scroll(this.dockScroll).px(8).py(4)
      .on_mouse_down("left", (event, cx) => this.sendDockMouse("press", event, cx))
      .on_window_mouse_move((event, cx) => { if (this.dockPress) this.sendDockMouse("drag", event, cx); })
      .on_window_mouse_up("left", (event, cx) => { if (this.dockPress) this.sendDockMouse("release", event, cx); });
    for (const line of this.dock.lines) body.child(h_flex().h(LINE_HEIGHT).flex_none().whitespace_nowrap()
      .children(parseAnsi(line).map(run => this.ansiRun(t, run))));
    if (this.dock.focused && this.surfaceInput && !this.overlays?.overlays.some(layer => layer.focused)) body.child(Input.new(this.surfaceInput).w(300).h(30).mt(8).px(6)
      .border_1().border_color(t.border).bg(t.background).text_color(t.foreground));
    return body;
  }

  /** @param {OverlayLayer} layer @param {"press"|"drag"|"release"} type @param {any} event @param {any} cx */
  sendOverlayMouse(layer, type, event, cx) {
    if (!event.local_position || !this.overlays) return;
    const connection = bridge(); if (!connection) return;
    const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
    const x = Math.floor(event.local_position.x / zoom / this.cellWidth);
    const y = Math.floor(event.local_position.y / zoom / rowHeight());
    const inside = x >= 0 && x < layer.width && y >= 0 && y < layer.height;
    if (type === "press") {
      if (!inside || this.overlaysPending) return;
      this.overlayPress = { id: layer.id, frame: layer.mouseFrame, revision: this.overlays.revision };
    }
    const press = this.overlayPress;
    if (!press || press.id !== layer.id) return;
    const eventData = { type, button: "left", x: Math.max(0, Math.min(layer.width - 1, x)),
      y: Math.max(0, Math.min(layer.height - 1, y)), ...(type === "release" && !inside ? { cancel: true } : {}) };
    this.actions.push({ request: { v: 1, op: "overlay-mouse", revision: press.revision, id: press.id, frame: press.frame, event: eventData }, connection });
    if (type === "release") this.overlayPress = null;
    this.drainActions(cx);
  }

  /** @param {OverlayLayer} layer @param {any} t */
  renderOverlay(layer, t) {
    const screen = this.overlays;
    const width = Math.min(this.controlWidth, layer.width * this.cellWidth);
    const height = Math.min(this.controlHeight, layer.height * LINE_HEIGHT + (layer.focused ? 40 : 0));
    const left = Math.max(0, Math.min(this.controlWidth - width, layer.col / Math.max(1, screen.columns) * this.controlWidth));
    const top = Math.max(0, Math.min(this.controlHeight - height, layer.row / Math.max(1, screen.rows) * this.controlHeight));
    const body = v_flex().id(`stereo-overlay-${layer.id}`).absolute().left(left).top(top).w(width).h(height)
      .overflow_hidden().bg(t.surface)
      .on_mouse_down("left", (event, cx) => { if (layer.focused) this.surfaceInput?.focus(); this.sendOverlayMouse(layer, "press", event, cx); })
      .on_window_mouse_move((event, cx) => { if (this.overlayPress?.id === layer.id) this.sendOverlayMouse(layer, "drag", event, cx); })
      .on_window_mouse_up("left", (event, cx) => { if (this.overlayPress?.id === layer.id) this.sendOverlayMouse(layer, "release", event, cx); });
    for (const line of layer.lines) body.child(h_flex().h(LINE_HEIGHT).flex_none().whitespace_nowrap()
      .children(parseAnsi(line).map(run => this.ansiRun(t, run))));
    if (layer.focused && this.surfaceInput) body.child(Input.new(this.surfaceInput).w_full().h(30).mt(8).px(6)
      .border_1().border_color(t.border).bg(t.background).text_color(t.foreground));
    return body;
  }

  /** @param {any} t */
  renderSurface(t) {
    const body = v_flex().id("stereo-surface").relative().flex_1().min_h(0).overflow_y_scroll().track_scroll(this.surfaceScroll).px(8).py(4)
      .on_mouse_down("left", (event, cx) => { this.surfaceInput?.focus(); this.sendSurfaceMouse("press", event, cx); })
      .on_window_mouse_move((event, cx) => { if (this.surfacePress) this.sendSurfaceMouse("drag", event, cx); })
      .on_window_mouse_up("left", (event, cx) => { if (this.surfacePress) this.sendSurfaceMouse("release", event, cx); });
    for (const line of this.surface.lines) {
      body.child(h_flex().h(LINE_HEIGHT).flex_none().whitespace_nowrap()
        .children(parseAnsi(line).map(run => this.ansiRun(t, run))));
    }
    if (this.surfaceInput && !this.overlays?.overlays.some(layer => layer.focused)) body.child(Input.new(this.surfaceInput).w(300).h(30).mt(8).px(6)
      .border_1().border_color(t.border).bg(t.background).text_color(t.foreground));
    return body;
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
    } else if (this.surface?.active) {
      body = this.renderSurface(t);
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
      .on_size_change((size, cx) => {
        const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
        const width = size.width / zoom, height = size.height / zoom;
        if (Math.abs(width - this.controlWidth) >= 1 || Math.abs(height - this.controlHeight) >= 1) {
          this.controlWidth = width; this.controlHeight = height; cx.notify();
        }
      })
      .font_family(typeof settings().font_family === "string" ? /** @type {string} */ (settings().font_family) : "monospace")
      .child(div().id("stereo-cell-probe").absolute().top_0().left_0().opacity(0).whitespace_nowrap()
        .on_size_change((size, cx) => this.measureCell(size, cx)).child("MMMMMMMMMM"))
      .child(header)
      .child(state?.showToolbar !== false ? toolbar : div().h(0))
      .child(this.controlError ? div().px(8).text_color(t.muted).child(this.controlError) : div().h(0))
      .child(body);
    if (!this.surface?.active && this.dock?.active && this.dock.lines.length) root.child(this.renderDock(t));
    for (const layer of this.overlays?.overlays ?? []) root.child(this.renderOverlay(layer, t));
    if (this.focus) root.track_focus(this.focus).on_key_down((event, cx) => {
      if ((this.overlays?.overlays.some(layer => layer.focused) || this.surface?.active || this.dock?.focused) && this.surfaceInput) {
        const key = event.key?.toLowerCase();
        // Text belongs to the native input; forward Enter even when the field is empty.
        if (key === "enter" || key === "return") {
          if (this.sendSurfaceData("\r", cx)) cx.stop_propagation();
          return;
        }
        if ((event.modifiers?.control && event.modifiers?.alt && event.key_char) ||
            (key === "v" && event.modifiers?.control && !event.modifiers?.alt) ||
            (!event.modifiers?.control && !event.modifiers?.alt &&
            !event.modifiers?.platform && (key?.length === 1 || event.key_char))) return;
        if (this.sendSurfaceKey(event, cx)) cx.stop_propagation();
        return;
      }
      const pane = this.viewState?.mode === "combined" ? this.combined : this.activePane === "chat" ? this.chat : this.activity;
      if (this.focus.is_focused() && event.modifiers?.control && event.key?.toLowerCase() === "c") {
        if (pane.selection.bounds()) {
          const name = this.viewState?.mode === "combined" ? "combined" : this.activePane;
          this.copySelection(name, pane, cx);
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
        if (key === "end") { pane.following = true; pane.handle.scroll_to_bottom(); }
        else {
          pane.following = false;
          const current = Math.floor(pane.handle.offset().y / rowHeight());
          const page = Math.max(1, Math.floor((pane.handle.viewport_size().height || pane.height) / rowHeight()) - 1);
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
