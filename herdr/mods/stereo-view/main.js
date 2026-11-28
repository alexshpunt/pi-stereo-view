import { View, div, image, svg } from "gpui-kit";
import { writeFile, unlink, readFile } from "fs/promises";
import { h_flex, v_flex, v_virtual_list, VirtualListScrollHandle, ScrollHandle, Scrollbar, Input, InputState } from "gpui-base";
import { appHome, checking, exec, nextCommand, panes, props, run, settings, spaces, terminals, theme, window } from "herdr";
import { parseAnsi } from "./ansi.js";
import { createSettingsPanel } from "./settings.js";
import { createSearchBar } from "./search-bar.js";
import { createSelection } from "./selection.js";
import { dialogKey } from "./dialog-keys.js";
import { composerAlive, composerFieldCommand, composerRoute } from "./composer-route.js";
import { dropStaleRows, pageUsable, paneDimensions, refreshPlan, rowHasText, SETTLE_MS, TICK_MS, UNUSABLE_LIMIT } from "./refresh-plan.js";
import { createBoundedImageStore, createImageCache, IMAGE_CACHE_INIT } from "./image-pruner.js";
import * as hostApi from "herdr";
import { createTreePanels } from "./tree-panel.js";
import { replaySpawn } from "./replay-stream.js";
import { blockAround, buttonRow, columnsFit, footerControls, leadingMarker, MIN_COLUMN_CELLS, padsToEnd } from "./history-blocks.js";

const LABEL = "herdr.stereo.bridge";
// LPT-1943 benchmark instrumentation (temporary): how long exec takes as the mod sees it.
const BENCH_SAMPLES = [];
function benchRecord(op, pane, execMs, parseMs, bytes, piMs) {
  BENCH_SAMPLES.push({ op, pane, execMs, parseMs, bytes, piMs, at: Date.now() });
  if (BENCH_SAMPLES.length % 10 === 0) writeFile(`${appHome()}/stereo-bench.json`, JSON.stringify(BENCH_SAMPLES)).catch(() => {});
}

const DEFAULT_LINE_HEIGHT = 17; // Used until the terminal's text size is known.
const LINE_HEIGHT_RATIO = 1.32; // Row height per point of terminal text, matching the terminal's own rows.
let LINE_HEIGHT = DEFAULT_LINE_HEIGHT; // Set by syncTypography from the terminal's text size and line height.
const PAGE = 256;
/** How many times a GUI that has just appeared hands the keyboard to the composer, and for how long it tries (LPT-1930). */
const KEYBOARD_TRIES = 3;
const KEYBOARD_CLAIM_MS = 15000;
const LOADING_MS = 1500; // How long a new copy draws only its background while it waits for the bridge's first state.
// What the last copy measured. A copy created later (a new pane) starts from it, so its first frame is laid out
// like the others instead of jumping from guesses once it is measured.
/** @type {{cellWidth: number, areaWidth: number, areaHeight: number, controlWidth: number, controlHeight: number, panels: Record<string, {width: number, height: number}>} | null} */
let lastGeometry = null;
// The structure the bridge reported last (layout, toolbar, headers, side, zoom), kept in the app's storage too. A copy
// that starts, in a new pane or after the app restarted, draws the toolbar and the panel headers in their final place
// from its first frame and fills the rows in place when the bridge answers; otherwise it would draw an empty pane first.
const LAYOUT_KEY = "stereo-view.layout.v1";
/** @type {any} */
let lastViewState = null;
loadRemembered();

/** Read what an earlier run kept: the last bridge state and the geometry measured with it. */
function loadRemembered() {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (!validState(stored?.state)) return;
    lastViewState = stored.state;
    const g = stored.geometry;
    if (g && [g.cellWidth, g.areaWidth, g.areaHeight, g.controlWidth, g.controlHeight].every(n => typeof n === "number" && n > 0) && typeof g.panels === "object" && g.panels) lastGeometry = g;
  } catch { /* No storage here, or nothing kept yet. */ }
}

/** Keep the structure and geometry for the next copy, when they changed. */
function saveRemembered() {
  try {
    const text = JSON.stringify({ state: lastViewState, geometry: lastGeometry });
    if (localStorage.getItem(LAYOUT_KEY) !== text) localStorage.setItem(LAYOUT_KEY, text);
  } catch { /* Not kept; the next copy waits for the bridge as before. */ }
}
const ICON_SIZE = 14; // Toolbar icon edge in logical pixels.
const NARROW_CONTROLS_WIDTH = 400; // Switch to icons when text controls no longer fit.
const MIN_ACTIVITY_WIDTH = 200; // Leave room for the heading and controls in a narrow split.
const LATEST_BOTTOM = 12; // Gap between the "Jump to latest" control and the panel's bottom edge.
const LATEST_GAP = 6; // Gap between its arrow and its label.
const LATEST_MIN_HEIGHT = 24; // Hit area of a control (WCAG 2.5.8).
const AT_BOTTOM_SLACK = 2; // Pixels short of the end that still count as the bottom.
const ROW_GUTTER = 8; // Space before a history row's text; its background runs through it.
const SCROLLBAR_LANE = 8; // Strip at a panel's right edge that holds no text, for the scrollbar.
const ROW_CHROME = 2 * ROW_GUTTER + SCROLLBAR_LANE; // What a panel spends beside its terminal cells.
const DIVIDER_SIZE = 5; // The draggable line between the two panels.
const BLOCK_BUTTON = 24; // Edge of a block button's hit area (WCAG 2.5.8).
const BLOCK_BUTTON_RADIUS = 4; // Corner radius of a block button.
const BLOCK_BUTTONS_GAP = 2; // Space between a block's two buttons and to the panel's edge.
const COPIED_MS = 1500; // How long Copy shows its check mark.
const FALLBACK_FONT = "JetBrains Mono"; // Ships with Herdr; used when the layout names no terminal font.
const UI_TEXT_SIZE = 12; // Text size of the toolbar and headings.
const DEFAULT_FONT_SIZE = 12; // Terminal text size when the settings hold none.
const MIN_FONT_SIZE = 9; // Smallest text that still fits a row.
const MAX_FONT_SIZE = 14; // Largest text a row can hold.
/** @typedef {{id:number, frame:number, mouseFrame:number, focused:boolean, row:number, col:number, width:number, height:number, lines:string[]}} OverlayLayer */
/** @typedef {{revision:number, columns:number, rows:number, overlays:OverlayLayer[]}} OverlayPage */
// GPUI snaps each virtual row to a whole window pixel before scrolling.
function rowHeight() {
  const zoom = settings().zoom;
  const scale = typeof zoom === "number" && zoom > 0 ? zoom : 1;
  return Math.round(LINE_HEIGHT * scale) / scale;
}
/** Use the list's measured item height: desktop DPI changes pixel snapping. */
function panelRowHeight(state) {
  const height = state.handle.content_size().height;
  const measured = state.total > 0 ? height / state.total : 0;
  return Number.isFinite(measured) && measured >= LINE_HEIGHT * 0.9 && measured <= LINE_HEIGHT * 1.1
    ? measured : rowHeight();
}

/**
 * History rows are terminal cells: only the terminal's own monospace font keeps every row `columns` cells wide, so
 * its padding fills the panel and a wrapped line ends where Pi wrapped it. `settings().font` is that font.
 */
function historyFont() {
  const font = settings().font;
  return typeof font === "string" && font ? font : FALLBACK_FONT;
}

/** The terminal's text size, held to what a row's height takes. */
function historyFontSize() {
  const size = settings().font_size;
  return typeof size === "number" && Number.isFinite(size) ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size)) : DEFAULT_FONT_SIZE;
}

/**
 * Rows are as tall as the terminal's own: a taller row spreads the same text over fewer lines than the terminal view
 * shows. Without a terminal text size the fixed default stands.
 */
function syncTypography() {
  const { font_size: size, terminal_line_height: spacing } = settings();
  if (typeof size !== "number" || !Number.isFinite(size)) { LINE_HEIGHT = DEFAULT_LINE_HEIGHT; return; }
  const factor = typeof spacing === "number" && Number.isFinite(spacing) ? Math.max(0.8, Math.min(2, spacing)) : 1;
  LINE_HEIGHT = Math.round(historyFontSize() * LINE_HEIGHT_RATIO * factor * 10) / 10;
}

/** The controls Pi draws under a block, when this raw row is that footer. @param {string} line */
function rowFooter(line) {
  return line.includes("]") ? footerControls(parseAnsi(line).map(run => run.text).join("")) : null;
}

/** Preserve terminal modifiers without sending absent or false fields. @param {any} event */
function pointerModifiers(event) {
  const m = event.modifiers;
  return { ...(m?.shift ? { shift: true } : {}), ...(m?.alt ? { alt: true } : {}), ...(m?.control ? { ctrl: true } : {}) };
}

/** GPUI's positive scroll delta points up; Pi uses negative logical lines for up. @param {any} event */
function wheelLines(event) {
  const value = event.delta_lines?.y ?? (event.delta?.y / rowHeight());
  if (!Number.isFinite(value) || value === 0) return 0;
  return -Math.sign(value) * Math.min(100, Math.max(1, Math.round(Math.abs(value)))) * (event.modifiers?.alt ? 5 : 1);
}
// The shell's binary fs bindings can yield empty files. Decode and verify in a
// local Node process after writing only ASCII through its text binding.
const IMAGE_DECODE = `const fs=require('node:fs'),crypto=require('node:crypto');
const [input,output,id]=process.argv.slice(1),data=Buffer.from(fs.readFileSync(input,'utf8'),'base64');
if(crypto.createHash('sha256').update(data).digest('hex')!==id)process.exit(2);
const temp=output+'.'+process.pid+'.tmp';
try{fs.writeFileSync(temp,data);fs.renameSync(temp,output);}finally{try{fs.unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e}}`;
const imageCache = createImageCache(() => exec("node", ["-e", IMAGE_CACHE_INIT, `${appHome()}/data/stereo-view/images`], { timeout: 5000 }));
// All views in this runtime share the owner directory, so they share eviction and in-flight writes too.
const imageViews = new Set();
const imageStore = createBoundedImageStore(128 * 1024 * 1024, path => unlink(`${appHome()}/${path}`), id => {
  for (const ref of imageViews) {
    const view = ref.deref();
    if (!view) { imageViews.delete(ref); continue; }
    for (const state of [view.chat, view.activity, view.combined]) {
      const first = Math.max(0, Math.floor(state.handle.offset().y / panelRowHeight(state)));
      const height = state.handle.viewport_size().height || state.height;
      const last = first + Math.ceil(height / panelRowHeight(state)) + 1;
      if (state.images.some(image => image.id === id && image.row < last && image.row + image.rows > first)) return true;
    }
  }
  return false;
});
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
  if (!ownPane || (props()?.view === "gui" && ownPane.view !== "gui")) return false;
  const space = spaces().find(s => s.active);
  const tab = space?.tabs.find(t => t.id === ownPane.tab && t.active);
  return !!tab && (!tab.zoomed || ownPane.zoomed);
}

/** Whether the copy's data is worth keeping current: shown, or in a tab on screen whose pane is in TUI mode right now. */
function isPrefetchable() {
  if (!window()?.visible) return false;
  const ownPane = panes().find(p => p.pane === props()?.pane);
  if (!ownPane || props()?.view !== "gui") return false;
  const tab = spaces().find(s => s.active)?.tabs.find(t => t.id === ownPane.tab && t.active);
  return !!tab;
}

/** Results are applied while shown and while prefetching for the next switch. */
function isLive() {
  return isShown() || isPrefetchable();
}

function terminalAddress() {
  const p = props() ?? {};
  const origin = p.origin ?? p.terminal;
  if (typeof origin !== "string" || !origin) return null;
  const pane = String(p.pane ?? "");
  const cut = pane.indexOf("/");
  return cut < 0 || origin.includes("/") ? origin : `${pane.slice(0, cut + 1)}${origin}`;
}

/**
 * LPT-1943 element-tree GUI, behind a switch while it is built: localStorage `stereo-view.tree` = "live" (herdr-app's
 * streaming process API) or "replay:<base url>" (recordings of a stream, for tests until that API is released).
 * @returns {((command: string, args: string[], options?: any) => any) | null}
 */
function treeSpawn(/** @type {string | null} */ mode) {
  if (mode === "live") {
    const spawn = /** @type {any} */ (hostApi).spawnStream;
    return typeof spawn === "function" ? spawn : null;
  }
  if (mode?.startsWith("replay:")) return replaySpawn(mode.slice(7), path => readFile(path, "utf8"));
  return null;
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

/** @returns {{total: number | null, revision: number, items: Map<number, {id: string, lines: string[], footer: ReturnType<typeof footerControls>}>, blockHover: number | null, heights: number[], width: number, height: number, handle: any, fetching: boolean, error: string | null, initial: boolean, lastSize: {width: number, height: number} | null, frameTop: number, frameHeight: number, pressed: boolean, following: boolean, searchState: any, searchBar: any, selectionRows: Map<number, any>, selection: any, selecting: boolean, pressPoint: {row: number, col: number, moved: boolean} | null, images: any[], jumpSerial: number, copying: boolean, selectionOnly: boolean, autoScroll: number, autoScrollTimer: boolean, selectionFocus: {row: number, col: number} | null, stale: boolean, unusable: number, settling: boolean}} */
function paneState() {
  const selectionRows = new Map();
  return { total: null, revision: -1, items: new Map(), blockHover: null, heights: [], width: 80, height: 300,
    handle: VirtualListScrollHandle.new(), fetching: false, error: null, initial: true, lastSize: null,
    frameTop: 0, frameHeight: 0, pressed: false, following: true, searchState: null, searchBar: null,
    selectionRows, selection: createSelection(index => selectionRows.get(index)), selecting: false, pressPoint: null, images: [], jumpSerial: 0,
    copying: false, selectionOnly: false, autoScroll: 0, autoScrollTimer: false, selectionFocus: null, stale: false,
    unusable: 0, settling: false };
}

/** Render the visible terminal rows, including one extra row for a partial scroll. */
/** @param {ReturnType<typeof paneState>} state */
function nextPage(state) {
  const offset = state.handle.offset().y;
  const viewport = state.handle.viewport_size().height || state.height;
  const visible = Math.max(1, Math.ceil(viewport / panelRowHeight(state)) + 1);
  const start = Math.max(0, Math.floor(offset / panelRowHeight(state)) - visible);
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
  let runIndex = 0, offset = 0, previousRun = -1;
  for (const cell of row.cells) {
    let left = cell.text.length;
    while (left > 0 && runIndex < runs.length) {
      const run = runs[runIndex];
      const length = Math.min(left, run.text.length - offset);
      if (length <= 0) { runIndex++; offset = 0; continue; }
      const selected = cell.end > selection.start && cell.start < selection.end;
      const text = run.text.slice(offset, offset + length);
      const previous = result[result.length - 1];
      if (previous && previousRun === runIndex && previous.selected === selected) previous.text += text;
      else { result.push({ ...run, text, selected }); previousRun = runIndex; }
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
    syncTypography();
    this.viewCx = cx;
    /** The element-tree panels (LPT-1943); null while the switch is off. */
    this.trees = null;
    const startTrees = (/** @type {string | null} */ mode) => {
      const spawnStream = treeSpawn(mode);
      if (!spawnStream || this.trees) return;
      this.trees = createTreePanels({ div, h_flex, v_flex, v_virtual_list }, { spawnStream, target: () => bridge() });
      cx.notify();
    };
    let mode = null;
    try { mode = localStorage.getItem("stereo-view.tree"); } catch { /* no storage */ }
    if (mode === "live" || mode?.startsWith("replay:")) startTrees(mode);
    // Development switch without a UI: the mode in a file of the app's home (read once).
    else readFile(`${appHome()}/stereo-tree.txt`, "utf8").then(text => startTrees(text.trim()), error => {
      writeFile(`${appHome()}/stereo-tree-status.json`, JSON.stringify({ switchError: String(error) })).catch(() => {}); // TEMPORARY (LPT-1943)
    });
    this.chat = paneState();
    this.activity = paneState();
    this.combined = paneState();
    // What the bridge reported last stands in until it answers, so the structure is final from the first frame.
    this.viewState = lastViewState;
    this.statePending = false;
    this.stateGeneration = 0;
    this.surface = null;
    /** @type {OverlayPage | null} */ this.overlays = null;
    this.overlaysPending = false;
    this.overlayPress = null;
    this.overlayScrolls = new Map();
    this.controlHeight = 400;
    this.surfacePending = false;
    this.dock = null;
    this.dockPending = false;
    this.dockScroll = ScrollHandle.new();
    this.dockPress = null;
    this.actions = [];
    this.pasteSerial = 0;
    this.surfaceInput = null;
    this.surfaceScroll = ScrollHandle.new();
    this.surfacePress = null;
    this.actionPending = false;
    this.areaWidth = 800;
    this.surfaceWidth = 0;
    this.controlWidth = 800;
    this.hoverPane = null;
    /** @type {{pane: string, row: number, at: number} | null} */ this.copied = null;
    this.hoverKey = "";
    /** @type {string | undefined} */ this.controlMoveKey = undefined;
    this.hoverAt = 0;
    this.imagePaths = imageStore;
    imageViews.add(new WeakRef(this));
    this.imagePending = new Set();
    this.imageQueue = [];
    this.imageWorkers = 0;
    this.imageFailures = new Map();
    this.areaHeight = 400;
    this.drag = undefined;
    // Until the first layout measures the monospace probe, use one em per cell.
    this.activePane = "chat";
    this.wasShown = false;
    this.keyboardTries = 0;
    this.keyboardUntil = 0;
    this.cellWidth = 12;
    this.cellMeasured = false;
    /** @type {number} */ this.lastRead = -Infinity;
    this.created = Date.now();
    this.tickShown = false;
    this.readScheduled = false;
    if (lastGeometry) {
      const g = lastGeometry;
      this.cellWidth = g.cellWidth; this.cellMeasured = true;
      this.areaWidth = g.areaWidth; this.areaHeight = g.areaHeight;
      this.controlWidth = g.controlWidth; this.controlHeight = g.controlHeight;
      const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
      for (const [name, state] of /** @type {[string, ReturnType<typeof paneState>][]} */ ([["chat", this.chat], ["activity", this.activity], ["combined", this.combined]])) {
        const size = g.panels[name];
        if (size) Object.assign(state, paneDimensions(size, zoom, this.cellWidth, ROW_CHROME));
      }
    }
    this.available = !checking() && !!bridge();
    if (checking()) return;
    this.focus = cx.focus_handle();
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        const command = await nextCommand();
        if (!isShown()) continue;
        if (command === "focus" && props()?.view === "gui") {
          // Herdr's own focus command replaces the claim a freshly shown GUI makes.
          this.keyboardTries = 0;
          this.refresh(cx);
          this.takeKeyboard();
          continue;
        }
        const action = composerRoute(command, props()?.pane);
        if (!action) continue;
        const dialog = this.surface?.active || this.overlays?.overlays.some(layer => layer.focused) || this.dock?.focused;
        if (action === "dialog-focus" && dialog) this.surfaceInput?.focus();
        else if (action !== "dialog-focus" && !dialog) this.navigate(action, cx);
      }
    });
    cx.timer.every(TICK_MS, (/** @type {any} */ cx) => this.tick(cx));
    this.tick(cx);
  }

  /**
   * One beat of the copy's clock. A shown copy reads the bridge when it appears and then every live interval; a copy
   * whose pane is in TUI mode keeps its data warm slowly, so the first frame of the next switch has content.
   * @param {any} cx
   */
  tick(cx) {
    // LPT-1943: the tree's stream and background measuring change what a frame shows between events.
    if (this.trees?.wantsRender() && isShown()) cx.notify();
    const shown = isShown();
    const plan = refreshPlan({ shown, prefetchable: !shown && isPrefetchable(), wasShown: this.tickShown, elapsed: Date.now() - this.lastRead });
    this.tickShown = shown;
    if (plan === "idle") return;
    this.lastRead = Date.now();
    this.refresh(cx, plan === "prefetch");
  }

  /** Herdr gives the keyboard of a GUI pane to this view; with no dialog open it belongs to the composer field. */
  handKeyboardToComposer() {
    const address = terminalAddress();
    const labels = terminals().find(t => t.address === address)?.labels;
    const command = composerFieldCommand(props()?.pane);
    if (!command || !composerAlive(labels)) return false;
    run(command);
    return true;
  }

  /** The pane has the keyboard: the view takes it (the open Pi dialog's input, else its own handle) and passes it on. */
  takeKeyboard() {
    if (this.surfaceInput) { this.surfaceInput.focus(); return false; }
    this.focus?.focus();
    return this.handKeyboardToComposer();
  }

  /**
   * Herdr sends "focus" only when a pane takes the keyboard. A pane that has it already when its GUI first
   * appears (a new pane whose Pi starts after the pane was made, or a Pi that restarts) gets no command, so
   * the keyboard would stay on the hidden terminal. The view therefore claims it when it appears: a few times
   * once the composer is alive, for a while at most (LPT-1930).
   */
  claimKeyboardOnEntry() {
    const own = panes().find(p => p.pane === props()?.pane);
    if (this.keyboardTries <= 0 || Date.now() > this.keyboardUntil || !own?.focused) return;
    if (this.takeKeyboard()) this.keyboardTries--;
  }

  /**
   * The layout on screen: the chosen one, except that two columns too narrow to read stack as rows instead
   * (the choice stays as it is and applies again when the pane is wide enough).
   */
  layout() {
    const chosen = this.viewState?.layout;
    // Until the first layout measures a cell, the width in cells is a guess: keep the choice.
    if (chosen !== "columns" || this.viewState?.mode !== "split" || this.viewState.zoom || !this.cellMeasured) return chosen;
    return columnsFit(this.areaWidth, this.cellWidth, ROW_CHROME, DIVIDER_SIZE) ? "columns" : "rows";
  }

  /** Whether the chosen two columns are stacked for lack of width. */
  stacked() {
    return this.viewState?.layout === "columns" && this.layout() === "rows";
  }

  dialogPlacement() {
    const state = this.viewState;
    return this.surface?.active && this.surface.piWindow && state?.mode === "split" && this.layout() === "columns" && !state.zoom
      ? state.preferences?.piWindows : undefined;
  }

  /** Handle navigation from the focused panel or its composer. @param {string} key @param {any} cx */
  navigate(key, cx) {
    const pane = this.viewState?.mode === "combined" ? this.combined : this.activePane === "chat" ? this.chat : this.activity;
    if (key === "search") {
      if (this.viewState?.mode === "split") this.openSearch(this.activePane, cx);
      return;
    }
    if (key === "end") this.jumpToLatest(pane === this.chat ? "chat" : pane === this.activity ? "activity" : "combined", pane, cx);
    else {
      pane.following = false;
      const current = Math.floor(pane.handle.offset().y / panelRowHeight(pane));
      const page = Math.max(1, Math.floor((pane.handle.viewport_size().height || pane.height) / panelRowHeight(pane)) - 1);
      const target = key === "home" ? 0 : current + (key === "pageup" ? -page : page);
      pane.handle.scroll_to_item(Math.max(0, Math.min((pane.total ?? 1) - 1, target)));
    }
    cx.notify();
  }

  /** Jump straight to the newest line and follow new ones again. @param {string} name @param {ReturnType<typeof paneState>} pane @param {any} cx */
  jumpToLatest(name, pane, cx) {
    pane.following = true;
    pane.handle.scroll_to_bottom();
    const connection = bridge(); if (connection) this.fetchPane(name, pane, connection, cx);
    cx.notify();
  }

  /** @param {ReturnType<typeof paneState>} pane */
  atBottom(pane) {
    const viewport = pane.handle.viewport_size().height || pane.height;
    return pane.handle.offset().y + viewport >= pane.handle.content_size().height - AT_BOTTOM_SLACK;
  }

  /** The "Jump to latest" control, shown while a panel is not following. It floats over the panel's bottom, outside the scrolled rows.
   * @param {string} name @param {ReturnType<typeof paneState>} pane @param {any} t */
  latestControl(name, pane, t) {
    if ((pane.total ?? 0) === 0 || pane.following || this.atBottom(pane)) return null;
    return div().id(`stereo-latest-wrap-${name}`).absolute().left_0().right_0().bottom(LATEST_BOTTOM).flex().justify_center()
      // The outer box keeps an opaque face so panel text never shows through; the hover tint is a translucent overlay on top of it.
      .child(h_flex().id(`stereo-latest-${name}`).accessibility_label("Jump to latest").tooltip("Jump to latest (End)")
        .rounded(12).bg(t.raised).border_1().border_color(t.border).shadow_md().text_color(t.foreground).cursor_pointer()
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation()) // Not a press on the panel's text.
        .on_click((_event, cx) => this.jumpToLatest(name, pane, cx))
        .child(h_flex().id(`stereo-latest-face-${name}`).items_center().gap(LATEST_GAP).min_h(LATEST_MIN_HEIGHT).px(10).rounded(11)
          .hover(s => s.bg(t.hover))
          .child(svg("mods/stereo-view/icons/latest.svg").id(`stereo-latest-icon-${name}`).size(ICON_SIZE).text_color(t.foreground))
          .child("Jump to latest")));
  }

  /** @param {any} cx @param {boolean} [prefetch] read for a copy that is not shown yet */
  refresh(cx, prefetch = false) {
    const shown = isShown();
    if (shown && !this.wasShown) { this.keyboardTries = KEYBOARD_TRIES; this.keyboardUntil = Date.now() + KEYBOARD_CLAIM_MS; }
    this.wasShown = shown;
    if (!shown && !(prefetch && isLive())) return;
    if (shown) this.claimKeyboardOnEntry();
    const connection = bridge();
    this.available = !!connection;
    if (!connection) { this.connection = undefined; cx.notify(); return; }
    if (this.connection !== connection.socket) {
      this.connection = connection.socket;
      this.controlMoveKey = undefined;
      this.viewState = lastViewState;
      this.stateGeneration++;
      this.closeSurfaceInput();
      this.surface = null;
      this.actions = [];
      this.overlays = null; this.overlayPress = null;
      for (const handle of this.overlayScrolls.values()) handle.release?.();
      this.overlayScrolls.clear();
      for (const state of [this.chat, this.activity, this.combined]) {
        state.searchBar?.dispose(); state.searchBar = null; state.searchState = null;
        state.selection.clear(); state.selectionRows.clear(); state.selecting = false;
        state.total = null; state.revision = -1; state.items.clear(); state.heights = [];
        state.initial = true; state.following = true; state.error = null; state.pressed = false; state.images = []; state.jumpSerial = 0;
        state.selectionOnly = false; state.autoScroll = 0; state.selectionFocus = null; state.unusable = 0; state.settling = false;
      }
    }
    this.fetchState(connection, cx);
    this.fetchSurface(connection, cx);
    this.fetchOverlays(connection, cx);
    this.fetchDock(connection, cx);
    this.fetchPanes(connection, cx);
  }

  /** Read again soon, once, after a resize: the panels' width changed, so the rows on screen have the old wrapping. @param {any} cx @param {number} [delay] */
  scheduleRead(cx, delay = 16) {
    if (this.readScheduled) return;
    this.readScheduled = true;
    cx.timer.after(delay, (/** @type {any} */ next) => {
      this.readScheduled = false;
      const connection = bridge();
      if (connection && isLive()) this.fetchPanes(connection, next);
    });
  }

  /** @param {{socket: string, machine?: string, address: string}} connection @param {any} cx */
  fetchPanes(connection, cx) {
    const placement = this.dialogPlacement();
    if (this.viewState?.mode === "combined" || placement === "combined") this.fetchPane("combined", this.combined, connection, cx);
    else if (placement === "maximize") this.fetchPane("activity", this.activity, connection, cx);
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
        lastViewState = state;
        saveRemembered();
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
    const width = Math.max(10, Math.min(300, Math.floor(((this.surfaceWidth || this.areaWidth) - 16) / this.cellWidth)));
    cx.spawn(async (/** @type {any} */ next) => {
      try {
        const request = JSON.stringify({ v: 1, op: "surface", width });
        const result = await exec("node", ["-e", CLIENT, connection.socket, request], { on: connection.machine, timeout: 5000 });
        if (result.code !== 0) throw new Error("Surface unavailable");
        const surface = JSON.parse(result.stdout);
        if (surface.v !== 1 || typeof surface.active !== "boolean" || (surface.piWindow !== undefined && typeof surface.piWindow !== "boolean") || !Number.isSafeInteger(surface.frame) ||
            !Number.isSafeInteger(surface.mouseFrame) ||
            !Array.isArray(surface.lines) || surface.lines.length > 256 || !surface.lines.every(/** @param {unknown} */ line => typeof line === "string")) throw new Error("Invalid surface");
        if (bridge()?.socket !== connection.socket || !isLive()) return;
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
        if (bridge()?.socket !== connection.socket || !isLive()) return;
        const ids = new Set(data.overlays.map(layer => layer.id));
        for (const [id, handle] of this.overlayScrolls) if (!ids.has(id)) {
          handle.release?.();
          this.overlayScrolls.delete(id);
        }
        this.overlays = data;
        this.syncSurfaceInput(next);
      } catch { this.overlays = null; this.syncSurfaceInput(next); }
      finally { this.overlaysPending = false; next.notify(); }
    });
  }

  /** @param {any} cx */
  syncSurfaceInput(cx) {
    // A copy that only prefetches must not take the keyboard.
    if (isShown() && (this.overlays?.overlays.some(layer => layer.focused) || this.surface?.active || this.dock?.focused)) this.openSurfaceInput(cx);
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
        if (bridge()?.socket !== connection.socket || !isLive()) return;
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
      if (characters.length === 1) this.sendSurfaceData(value, cx);
      else this.sendSurfacePaste(characters, cx);
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

  /** Queue bounded chunks for a single atomic paste to the currently focused Pi surface. */
  /** @param {string[]} characters @param {any} cx */
  sendSurfacePaste(characters, cx) {
    const connection = bridge();
    const overlay = [...(this.overlays?.overlays ?? [])].reverse().find(layer => layer.focused);
    const dialog = !overlay && this.surface?.active ? this.surface : null;
    const dock = !overlay && !dialog && this.dock?.active && this.dock.focused ? this.dock : null;
    if (!connection || (!overlay && !dialog && !dock)) return;
    // Four UTF-8 bytes per code point is a conservative 1 MiB bound.
    if (characters.length > 262144) {
      this.controlError = "Could not send this text to the dialog."; cx.notify(); return;
    }
    const transaction = `${Date.now()}-${Math.random().toString(36).slice(2)}-${++this.pasteSerial}`;
    const count = Math.ceil(characters.length / 256);
    const target = overlay ? { op: "overlay-paste", revision: this.overlays.revision, id: overlay.id, frame: overlay.frame }
      : { op: "surface-paste", frame: (dialog || dock).frame, ...(dock ? { target: "dock" } : {}) };
    for (let index = 0; index < count; index++) {
      const data = characters.slice(index * 256, (index + 1) * 256).join("");
      this.actions.push({ request: { v: 1, ...target, transaction, index, count, data }, connection });
    }
    this.drainActions(cx);
  }

  /** @param {any} event @param {any} cx */
  sendSurfaceKey(event, cx) {
    const data = dialogKey(event);
    return data ? this.sendSurfaceData(data, cx) : false;
  }

  /** End a lost native capture without turning it into a click. */
  /** @param {"surface"|"dock"|"overlay"} kind @param {any} cx */
  cancelControlCapture(kind, cx) {
    const key = kind === "overlay" ? "overlayPress" : kind === "dock" ? "dockPress" : "surfacePress";
    /** @type {any} */ const press = this[key];
    if (!press) return;
    this[key] = null;
    const connection = bridge();
    if (connection) {
      const request = kind === "overlay"
        ? { v: 1, op: "overlay-mouse", revision: press.revision, id: press.id, frame: press.frame }
        : { v: 1, op: "surface-mouse", ...(kind === "dock" ? { target: "dock" } : {}), frame: press.frame };
      this.actions.push({ request: { ...request, event: { type: "release", button: press.button ?? "left", x: press.x, y: press.y, cancel: true } }, connection });
      this.drainActions(cx);
    }
    cx.notify();
  }

  /** Queue pointer movement without letting a flood of obsolete positions delay clicks. @param {any} request @param {any} connection @param {any} cx */
  queueControlMouse(request, connection, cx) {
    const last = this.actions.at(-1)?.request;
    if (request.event.type === "move") {
      const key = JSON.stringify([request.op, request.target, request.id, request.revision, request.frame, request.event]);
      if (this.controlMoveKey === key) return;
      this.controlMoveKey = key;
      if (last?.event?.type === "move" && last.op === request.op && last.target === request.target && last.id === request.id) this.actions.pop();
    } else this.controlMoveKey = undefined;
    this.actions.push({ request, connection });
    this.drainActions(cx);
  }

  /** Forward cell coordinates for the exact dialog frame currently on screen. @param {string} type @param {any} event @param {any} cx */
  sendSurfaceMouse(type, event, cx) {
    if (!this.surface?.active || !event.local_position) return;
    const connection = bridge(); if (!connection) return;
    const zoomValue = settings().zoom;
    const zoom = typeof zoomValue === "number" && zoomValue > 0 ? zoomValue : 1;
    const x = Math.floor((event.local_position.x / zoom - 8) / this.cellWidth);
    const y = Math.floor((event.local_position.y / zoom + this.surfaceScroll.offset().y - 4) / rowHeight());
    const inside = x >= 0 && x < this.surface.width && y >= 0 && y < this.surface.lines.length;
    const standalone = type === "move" || type === "wheel";
    if (type === "press") {
      if (!inside || this.surfacePending || this.surfacePress || !Number.isSafeInteger(this.surface.mouseFrame)) return;
      this.surfacePress = { frame: this.surface.mouseFrame, x, y, button: event.button ?? "left" };
    }
    if (standalone && (!inside || this.surfacePending || this.surfacePress)) return;
    const target = standalone ? { frame: this.surface.mouseFrame, button: "none" } : this.surfacePress;
    if (!target) return;
    const delta = type === "wheel" ? wheelLines(event) : 0;
    if (type === "wheel" && !delta) return;
    const px = Math.max(-1000000, Math.min(1000000, x));
    const py = Math.max(-1000000, Math.min(1000000, y));
    const data = { type, button: target.button, x: px, y: py, ...pointerModifiers(event),
      ...(delta ? { wheelDelta: delta } : {}), ...(type === "press" && event.click_count > 1 ? { clickCount: Math.min(3, event.click_count) } : {}),
      ...(type === "release" && !inside ? { cancel: true } : {}) };
    this.queueControlMouse({ v: 1, op: "surface-mouse", frame: target.frame, event: data }, connection, cx);
    if (type === "release") this.surfacePress = null;
    return true;
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
    const top = Math.max(0, Math.floor(offset / panelRowHeight(state)));
    const height = Math.min(PAGE, Math.max(1, Math.ceil(viewport / panelRowHeight(state)) + 1));
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
      if (type === "release") this.cancelPaneCapture(pane, state, cx);
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

  /** Cancel a history capture when its mouse-up occurred outside the window. */
  /** @param {string} pane @param {ReturnType<typeof paneState>} state @param {any} cx */
  cancelPaneCapture(pane, state, cx) {
    if (!state.pressed) return;
    const point = state.pressPoint;
    const connection = bridge();
    if (!state.selectionOnly && point && connection) {
      this.actions.push({ request: { v: 1, op: "mouse", pane, frame: state.revision,
        event: { type: "release", button: "left", x: point.col, y: point.row - state.frameTop, cancel: true } }, connection });
      this.drainActions(cx);
    }
    state.pressed = false; state.selectionOnly = false; state.selecting = false; state.autoScroll = 0;
    // The action queue refreshes after the cancel is delivered; do not race it with a new frame.
    if (connection && !this.actionPending && !this.actions.length) this.fetchPane(pane, state, connection, cx);
    cx.notify();
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
    const y = inside ? Math.floor((state.handle.offset().y + py) / panelRowHeight(state)) - state.frameTop : -1;
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
      const visible = Math.max(1, Math.floor(viewport / panelRowHeight(state)));
      const top = Math.max(0, Math.floor(state.handle.offset().y / panelRowHeight(state)));
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

  /** The child receives wheel input before the scroll container's own listener. */
  /** @param {"surface"|"dock"|"overlay"} kind @param {number} row @param {any} event @param {any} cx @param {OverlayLayer} [layer] */
  rowWheel(kind, row, event, cx, layer) {
    if (!event.local_position) return;
    const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
    const handle = kind === "overlay" && layer ? this.overlayScrolls.get(layer.id) : kind === "dock" ? this.dockScroll : this.surfaceScroll;
    if (!handle) return;
    const paddingX = kind === "overlay" ? 0 : 8, paddingY = kind === "overlay" ? 0 : 4;
    const positioned = { ...event, local_position: { x: event.local_position.x + paddingX * zoom,
      y: event.local_position.y + (row * rowHeight() - handle.offset().y + paddingY) * zoom } };
    const sent = kind === "overlay" && layer ? this.sendOverlayMouse(layer, "wheel", positioned, cx) :
      kind === "dock" ? this.sendDockMouse("wheel", positioned, cx) : this.sendSurfaceMouse("wheel", positioned, cx);
    if (sent) cx.stop_propagation();
  }

  /** Scroll the projection only when the painted Pi component did not consume the wheel. @param {any} request */
  scrollUnhandledWheel(request) {
    const layer = request.op === "overlay-mouse" ? this.overlays?.overlays.find((/** @type {OverlayLayer} */ item) => item.id === request.id) :
      request.target === "dock" ? this.dock : this.surface;
    const handle = request.op === "overlay-mouse" ? this.overlayScrolls.get(request.id) :
      request.target === "dock" ? this.dockScroll : this.surfaceScroll;
    if (!layer || !handle || layer.mouseFrame !== request.frame ||
        (request.op === "overlay-mouse" && this.overlays?.revision !== request.revision)) return;
    const offset = handle.offset().y, height = handle.viewport_size().height;
    const delta = request.event.wheelDelta;
    const edge = delta > 0 ? Math.floor((offset + height - 1) / rowHeight()) : Math.floor(offset / rowHeight());
    const index = Math.max(0, Math.min(layer.lines.length - 1, edge + delta));
    handle.scroll_to_item(index);
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
        // A pointer event Pi did not take is not an error: it can be for a frame Pi has replaced, or land outside rows that a resize just moved.
        } else if (reply.ok !== true && !((request.op === "surface-mouse" || request.op === "overlay-mouse" || request.op === "mouse") && reply.ok === false)) throw new Error("Action failed");
        if (reply.ok === false && request.event?.type === "wheel") this.scrollUnhandledWheel(request);
        this.controlError = null;
      } catch {
        if (request.transaction) this.actions = this.actions.filter(item => item.request.transaction !== request.transaction);
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
    if (this.trees?.active(pane)) return; // The element tree supplies this pane's rows.
    const following = state.following;
    const { start, count } = nextPage(state);
    const width = state.width;
    state.fetching = true;
    const request = JSON.stringify({ v: 1, op: "view", pane, top: start, height: count, width, following });
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const benchT0 = Date.now();
        const result = await exec("node", ["-e", CLIENT, connection.socket, request], { on: connection.machine, timeout: 5000 });
        const benchT1 = Date.now();
        if (result.code !== 0) throw new Error("Bridge unavailable");
        const page = JSON.parse(result.stdout);
        benchRecord("view", pane, benchT1 - benchT0, Date.now() - benchT1, result.stdout.length, page.bench?.pageMs);
        if (!validView(page, start, count, width, following)) throw new Error("Invalid bridge response");
        const now = bridge();
        if (!isLive() || !now || now.socket !== connection.socket || state.width !== width) return;
        if (state.searchBar && page.search?.open && page.search.query === state.searchState?.query &&
            Number.isSafeInteger(page.search.count) && Number.isSafeInteger(page.search.current)) {
          const previousTop = state.searchState?.top;
          state.searchState = page.search;
          if (Number.isSafeInteger(page.search.top) && page.search.top !== previousTop)
            state.handle.scroll_to_item(page.search.top);
        }
        // Pi is still laying history out at a new width: keep the rows on screen and read again at once.
        if (state.unusable < UNUSABLE_LIMIT && !pageUsable(page, [...state.items.values()].some(item => rowHasText(item.lines[0])))) {
          state.unusable++;
          state.settling = true;
          return;
        }
        state.unusable = 0;
        state.settling = page.settling === true;
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
        cx.spawn(async () => { try { await this.imagePaths.prune(); } catch (error) { console.warn("Stereo View image cleanup failed", error); } });
        for (const placement of page.images) this.loadImage(placement, connection, cx);
        for (let i = 0; i < page.lines.length; i++) {
          const index = page.top + i;
          state.selectionRows.set(index, page.selection[i]);
          state.items.delete(index);
          state.items.set(index, { id: `${page.frame}:${index}`, lines: [page.lines[i]], footer: rowFooter(page.lines[i]) });
        }
        if (state.selectionFocus && state.selectionRows.has(state.selectionFocus.row)) {
          state.selection.extend(state.selectionFocus);
          if (!state.pressed || !state.selectionOnly) state.selectionFocus = null;
        }
        if (state.stale) {
          // First page at the new width: rows kept from the old one that it does not replace have the wrong wrapping.
          state.stale = false;
          for (const index of dropStaleRows(state.items, page.top, page.lines.length))
            if (!state.selection.endpoints().includes(index)) state.selectionRows.delete(index);
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
          state.handle.scroll_to_item(Math.max(0, Math.min(state.total - 1, Math.floor(currentOffset / panelRowHeight(state)) + page.scrollShift)));
        state.initial = false;
        state.error = null;
      } catch {
        state.error = "Could not read this panel. The terminal is still available.";
        state.settling = false;
      } finally {
        state.fetching = false;
        cx.notify();
        // The panel was resized while this page was in flight: it is for the old width, so ask again now.
        if (state.width !== width) this.scheduleRead(cx, 0);
        // Pi has not finished measuring the history at this width (or sent a page not to be drawn): its total can still change.
        else if (state.settling) this.scheduleRead(cx, SETTLE_MS);
      }
    });
  }

  /** @param {{width: number, height: number}} size @param {any} cx */
  measureCell(size, cx) {
    const z = settings().zoom;
    const zoom = typeof z === "number" && z > 0 ? z : 1;
    const measured = size.width / zoom / 10;
    if (!Number.isFinite(measured) || measured <= 0) return;
    const wasMeasured = this.cellMeasured;
    this.cellMeasured = true;
    if (Math.abs(measured - this.cellWidth) < 0.01) { if (!wasMeasured) cx.notify(); return; }
    this.cellWidth = measured;
    if (this.chat.lastSize) this.sizePane(this.chat, this.chat.lastSize, cx);
    if (this.activity.lastSize) this.sizePane(this.activity, this.activity.lastSize, cx);
    if (this.combined.lastSize) this.sizePane(this.combined, this.combined.lastSize, cx);
    cx.notify();
  }

  /** Whether the first read of the bridge's state is still on its way (for a moment only: a bridge that does not answer shows its message). */
  loading() {
    return this.available && !this.controlError && this.viewState === null && Date.now() - this.created < LOADING_MS;
  }

  /**
   * Whether a panel has not had its first page yet, for a moment only. Its toolbar and heading are drawn in their
   * final place, but its rows stay undrawn until the page is here, so no frame shows rows appear in a panel that moved.
   * @param {ReturnType<typeof paneState>} pane
   */
  firstPagePending(pane) {
    return this.available && !this.controlError && Date.now() - this.created < LOADING_MS && !!pane.initial && !pane.error;
  }

  /** Keep what this copy measured for the copies created after it. */
  rememberGeometry() {
    if (!this.cellMeasured) return;
    const panels = { ...(lastGeometry?.panels ?? {}) };
    for (const [name, state] of /** @type {[string, ReturnType<typeof paneState>][]} */ ([["chat", this.chat], ["activity", this.activity], ["combined", this.combined]]))
      if (state.lastSize) panels[name] = { width: state.lastSize.width, height: state.lastSize.height };
    lastGeometry = { cellWidth: this.cellWidth, areaWidth: this.areaWidth, areaHeight: this.areaHeight,
      controlWidth: this.controlWidth, controlHeight: this.controlHeight, panels };
    saveRemembered();
  }

  /** @param {ReturnType<typeof paneState>} state @param {{width: number, height: number}} size @param {any} cx */
  sizePane(state, size, cx) {
    state.lastSize = size;
    const z = settings().zoom;
    const zoom = typeof z === "number" && z > 0 ? z : 1;
    const { width, height } = paneDimensions(size, zoom, this.cellWidth, ROW_CHROME);
    this.rememberGeometry();
    if (width === state.width && height === state.height) return;
    let widthChanged = false;
    if (width !== state.width) {
      // Keep the rows: drawn with the old wrapping they are better than a blank panel until the next page lands.
      state.stale = true;
      widthChanged = true;
      state.selection.clear();
      state.selectionRows.clear();
      state.selectionFocus = null;
      state.selecting = false;
      state.autoScroll = 0;
      if (state.selectionOnly) { state.pressed = false; state.selectionOnly = false; state.pressPoint = null; }
    }
    state.width = width;
    state.height = height;
    cx.notify();
    if (widthChanged) this.scheduleRead(cx);
  }

  /** A run's resolved colors. @param {any} t @param {any} run */
  runColors(t, run) {
    const color = (/** @type {any} */ value, /** @type {any} */ fallback) => value === undefined ? fallback : typeof value === "string" ? value : t[`ansi${value.ansi}`] ?? fallback;
    let fg = color(run.fg, t.foreground), bg = color(run.bg, undefined);
    if (run.inverse) [fg, bg] = [bg ?? t.surface, fg];
    return { fg, bg };
  }

  /** @param {any} t @param {any} run @param {boolean} [grow] run on to the row's end, so a block's background has no ragged edge */
  ansiRun(t, run, grow = false) {
    const { fg, bg } = this.runColors(t, run);
    let el = div().whitespace_nowrap().font_family(historyFont()).text_size(historyFontSize()).line_height(`${LINE_HEIGHT}px`).text_color(fg);
    el = grow ? el.flex_grow(1).flex_shrink(0) : el.flex_none();
    if (bg) el = el.bg(bg);
    if (run.bold) el = el.font_semibold();
    if (run.italic) el = el.italic();
    if (run.underline) el = el.underline();
    if (run.dim) el = el.opacity(0.65);
    if (run.selected) el = el.bg(t.selection ?? t.accent ?? "#526b83").text_color(t.foreground);
    return el.child(run.text);
  }

  /** @param {any} placement @param {{socket:string,machine?:string}} connection @param {any} cx */
  loadImage(placement, connection, cx) {
    const id = placement.id;
    if (this.imagePaths.get(id) || this.imagePending.has(id) || Date.now() - (this.imageFailures.get(id) ?? 0) < 5000) return;
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
        await this.imagePaths.load(id, async () => {
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
          const owner = await imageCache();
          const relative = `data/stereo-view/images/${owner}/${id}.${extension}`;
          const directory = `${appHome()}/data/stereo-view/images/${owner}`;
          const temporary = `${directory}/${id}-${Math.random().toString(36).slice(2)}.base64`;
          await writeFile(temporary, encoded);
          try {
            const decoded = await exec("node", ["-e", IMAGE_DECODE, temporary, `${directory}/${id}.${extension}`, id], { timeout: 15000 });
            if (decoded.code !== 0) throw new Error("Image data could not be decoded");
          } finally { await unlink(temporary); }
          return { path: relative, size: Math.floor(encoded.length * 3 / 4) };
        });
      } catch (error) {
        this.imageFailures.set(id, Date.now());
        while (this.imageFailures.size > 512) this.imageFailures.delete(this.imageFailures.keys().next().value);
        console.warn("Stereo View image failed", error);
      }
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

  /**
   * One history row. A block's background spans the panel: the blank padding Pi ends a row with, when it has a
   * background, runs on to the row's end. The footer Pi draws under a block (`[Go to] [Copy]`) is not drawn, only
   * the turn's colored bar in front of it; the block's hover buttons stand for the controls.
   * @param {ReturnType<typeof paneState>} state @param {number} index @param {any} t
   */
  entry(state, index, t) {
    const item = state.items.get(index);
    if (!item) return div().h(LINE_HEIGHT).flex_none();
    const line = item.lines[0] ?? "";
    const row = h_flex().relative().w_full().pl(ROW_GUTTER).pr(ROW_GUTTER).h(LINE_HEIGHT).flex_none().whitespace_nowrap().overflow_hidden();
    let runs = selectedRuns(parseAnsi(line), state.selectionRows.get(index), state.selection.columns(index));
    if (item.footer) runs = [leadingMarker(runs)].filter(run => run !== undefined);
    const grow = padsToEnd(runs[runs.length - 1]) && this.runColors(t, runs[runs.length - 1]).bg !== undefined && !runs[runs.length - 1].selected;
    row.children(runs.map((run, n) => this.ansiRun(t, run, grow && n === runs.length - 1)));
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

  /** LPT-1943: the Copy button of the item under the pointer in a tree panel. @param {string} name @param {ReturnType<typeof paneState>} state @param {any} t @param {any} treeRows */
  treeCopy(name, state, t, treeRows) {
    return treeRows ? this.trees.copyButton(name, state, { theme: t, lineHeight: LINE_HEIGHT, svg, scrollbarLane: SCROLLBAR_LANE + BLOCK_BUTTONS_GAP, notify: () => this.viewCx?.notify() }) : null;
  }

  /**
   * The block under the pointer in one panel, with the row that carries its buttons: its first row on screen.
   * @param {ReturnType<typeof paneState>} state
   */
  hoveredBlock(state) {
    if (state.blockHover === null) return null;
    const block = blockAround(state.blockHover, index => { const item = state.items.get(index); return item ? item.footer ?? null : undefined; });
    if (!block) return null;
    const first = Math.floor(state.handle.offset().y / panelRowHeight(state));
    return { ...block, anchor: buttonRow(block, first) };
  }

  /** Follow the pointer to the block it is over; redraw only when that block changes. @param {ReturnType<typeof paneState>} state @param {any} event @param {any} cx */
  trackBlockHover(state, event, cx) {
    let row = null;
    if (event.local_position) {
      const z = settings().zoom;
      const zoom = typeof z === "number" && z > 0 ? z : 1;
      const x = event.local_position.x / zoom, y = event.local_position.y / zoom;
      const viewport = state.handle.viewport_size().height || state.height;
      if (x >= 0 && x < (state.lastSize?.width ?? 0) / zoom && y >= 0 && y < viewport)
        row = Math.floor((state.handle.offset().y + y) / panelRowHeight(state));
    }
    const before = this.hoveredBlock(state);
    state.blockHover = row;
    const after = this.hoveredBlock(state);
    if (before?.start !== after?.start || before?.anchor !== after?.anchor) cx.notify();
  }

  /**
   * Go to and Copy for one block, floating over the right edge of its first row on screen (a row clips its own
   * overflow, so the buttons belong to the panel). Each one presses the control Pi drew in the block's footer row,
   * so Pi does what it does for a click there.
   * @param {string} pane @param {ReturnType<typeof paneState>} state @param {NonNullable<ReturnType<StereoView["hoveredBlock"]>>} block @param {any} t
   */
  blockButtons(pane, state, block, t) {
    const copied = this.copied?.pane === pane && this.copied.row === block.end && Date.now() - this.copied.at < COPIED_MS;
    const rowTop = block.anchor * panelRowHeight(state) - state.handle.offset().y;
    const viewport = state.handle.viewport_size().height || state.height;
    const barHeight = BLOCK_BUTTON + 2 * BLOCK_BUTTONS_GAP + 2;
    const top = Math.max(0, Math.min(viewport - barHeight, rowTop));
    /** @param {"goTo" | "copy"} which @param {string} label @param {string} icon */
    const button = (which, label, icon) => h_flex().id(`stereo-block-${which}`).accessibility_label(label).tooltip(label)
      .items_center().justify_center().flex_none().w(BLOCK_BUTTON).h(BLOCK_BUTTON).rounded(BLOCK_BUTTON_RADIUS)
      .cursor_pointer().hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => this.pressBlockControl(pane, state, block, which, cx))
      .child(svg(`mods/stereo-view/icons/${icon}.svg`).id(`stereo-block-icon-${which}`).size(ICON_SIZE)
        .text_color(copied && which === "copy" ? t.accent ?? t.foreground : t.foreground));
    const bar = h_flex().id("stereo-block-buttons").absolute().right(SCROLLBAR_LANE + BLOCK_BUTTONS_GAP).top(top)
      .items_center().gap(BLOCK_BUTTONS_GAP).p(BLOCK_BUTTONS_GAP).rounded(BLOCK_BUTTON_RADIUS + BLOCK_BUTTONS_GAP)
      .bg(t.raised ?? t.surface).border_1().border_color(t.border);
    if (block.footer.goTo) bar.child(button("goTo", "Go to the same point in the other panel", "go-to"));
    if (block.footer.copy) bar.child(button("copy", copied ? "Copied" : "Copy this block", copied ? "check" : "copy"));
    return bar;
  }

  /** Click the control Pi drew in a block's footer row. @param {string} pane @param {ReturnType<typeof paneState>} state @param {NonNullable<ReturnType<StereoView["hoveredBlock"]>>} block @param {"goTo" | "copy"} which @param {any} cx */
  pressBlockControl(pane, state, block, which, cx) {
    const control = block.footer[which];
    const connection = bridge();
    const y = block.end - state.frameTop;
    if (!control || !connection || state.revision < 1 || state.fetching || y < 0 || y >= state.frameHeight) return;
    const x = control.column + Math.floor(control.width / 2);
    for (const type of ["press", "release"]) {
      this.actions.push({ request: { v: 1, op: "mouse", pane, frame: state.revision,
        event: { type, button: "left", x, y, shift: false, ctrl: false, alt: false, clickCount: 1 } }, connection });
    }
    if (which === "copy") {
      this.copied = { pane, row: block.end, at: Date.now() };
      cx.timer.after(COPIED_MS, (/** @type {any} */ next) => next.notify());
    }
    this.drainActions(cx);
    cx.notify();
  }

  /** @param {string} action @param {string} label @param {any} t @param {number} [width] */
  control(action, label, t, width = this.controlWidth) {
    const state = this.viewState;
    const icons = state?.preferences?.buttonStyle === "icons" || width < NARROW_CONTROLS_WIDTH;
    const icon = action === "mode" ? (state?.mode === "combined" ? "split" : "combine")
      : action === "layout" ? (state?.layout === "rows" ? "columns" : "rows")
      : action.startsWith("find-") ? "find"
      : action.startsWith("zoom-") ? (state?.zoom === action.slice(5) ? "restore" : "maximize")
      : action === "compact" ? (state?.compactTools ? "full" : "compact") : action;
    // Two columns stacked for lack of width: the layout choice has no effect until the pane is wider.
    if (action === "layout" && this.stacked()) {
      return div().id(`stereo-action-${action}`).accessibility_label(label).tooltip("Stacked: the pane is too narrow for columns").px(6).py(3).text_color(t.dim)
        .child(icons ? svg(`mods/stereo-view/icons/${icon}.svg`).id(`stereo-icon-${action}`).size(ICON_SIZE).text_color(t.dim) : label);
    }
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
    const rows = this.layout() === "rows";
    const total = rows ? this.areaHeight : this.areaWidth;
    const reserve = rows ? 40 : Math.min(MIN_ACTIVITY_WIDTH, total / 2);
    if (this.drag) return Math.max(40, Math.min(total - reserve, this.drag.size));
    const prefs = this.viewState?.preferences;
    const value = rows
      ? (prefs?.chatHeight == null ? Math.min(total / 2, Math.max(LINE_HEIGHT * 3, (this.chat.total ?? 1) * LINE_HEIGHT + 28)) : prefs.chatHeight * LINE_HEIGHT)
      : (prefs?.chatWidth == null ? Math.max(MIN_COLUMN_CELLS * this.cellWidth + ROW_CHROME, total * 0.2) : prefs.chatWidth * this.cellWidth + 16);
    return Math.max(40, Math.min(total - reserve, value));
  }

  /** @param {any} t */
  divider(t) {
    const rows = this.layout() === "rows";
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
        if (event.pressed_button !== "left") { this.drag = undefined; cx.notify(); return; }
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

  /** @param {string} name @param {string} title @param {ReturnType<typeof paneState>} state @param {any} t @param {boolean} [showSurface] */
  panel(name, title, state, t, showSurface = false) {
    const id = `stereo-${name}`;
    const hovered = this.hoveredBlock(state);
    // LPT-1943: with the element tree on, the list is drawn from the local tree (no per-scroll request to Pi).
    const frameStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    const treeRows = this.trees && name !== "combined" ? this.trees.list(name, state, {
      theme: t, lineHeight: LINE_HEIGHT, font: historyFont(), fontSize: historyFontSize(), gutter: ROW_GUTTER,
      notify: () => this.viewCx?.notify(), svg, scrollbarLane: SCROLLBAR_LANE + 2,
    }) : null;
    if (this.trees) { // TEMPORARY (LPT-1943): per-render timings for the live test, written to the app home
      const end = typeof performance !== "undefined" ? performance.now() : Date.now();
      (this.treeFrames ??= []).push({ name, at: end, spent: end - frameStart });
      if (this.treeFrames.length > 2000) this.treeFrames.splice(0, 1000);
      if (!(Date.now() - (this.treeStatusAt ?? 0) < 1000)) {
        this.treeStatusAt = Date.now();
        writeFile(`${appHome()}/stereo-tree-status.json`, JSON.stringify({ name, drawn: !!treeRows, chat: this.trees.status("chat"), activity: this.trees.status("activity"), width: state.width, height: state.height, perf: typeof performance !== "undefined", frames: this.treeFrames.slice(-600), ranges: { chat: this.trees.ranges("chat"), activity: this.trees.ranges("activity") } })).catch(() => {});
      }
    }
    const rows = treeRows ?? v_virtual_list(id, state.total ?? 0, LINE_HEIGHT,
      index => `${name}-${index}`,
      range => Array.from({ length: range.end - range.start }, (_, n) => this.entry(state, range.start + n, t)))
      .h(state.height).track_scroll(state.handle);
    // The heading and the box stay; the rows come in place once their first page is here.
    if (!treeRows && this.firstPagePending(state)) rows.opacity(0);
    const heading = h_flex().items_center().justify_between().px(8).py(3)
      .child(div().text_color(t.muted).child(title));
    const actions = h_flex().items_center();
    const placement = this.dialogPlacement();
    const split = this.viewState?.mode === "split" && this.layout() === "columns" && !this.viewState.zoom && placement !== "combined" && placement !== "maximize";
    const width = split ? (name === "chat" ? this.chatExtent() : this.areaWidth - this.chatExtent() - 5) : this.areaWidth;
    if (name !== "combined") actions.child(this.control(`find-${name}`, "Find", t, width));
    if (name === "activity") actions.child(this.control("compact", this.viewState?.compactTools ? "Full tools" : "Compact tools", t, width));
    if (name !== "combined") actions.child(this.control(`zoom-${name}`, this.viewState?.zoom === name ? "Restore" : "Maximize", t, width));
    heading.child(actions);
    const panel = v_flex().flex_1().min_w(0).min_h(0).border_1().border_color(t.border);
    if (split) panel.h_full();
    else panel.w_full();
    if (name === "chat" && this.viewState?.mode === "split" && !this.viewState?.zoom) {
      if (this.layout() === "rows") panel.flex_none().h(this.chatExtent());
      else panel.flex_none().w(this.chatExtent());
    }
    if (name !== "combined" && this.viewState?.showHeaders !== false) panel.child(heading);
    if (state.searchBar) panel.child(state.searchBar.render(state.searchState ?? {}, t));
    panel
      .child(state.error ? div().px(8).text_color(t.muted).child(state.error) : div().h(0))
      // The terminal's own background: Pi picks its colors for it, and the terminal view shows the same turn on it.
      .child(v_flex().id(`${id}-box`).relative().flex_1().min_h(0).bg(t.background)
        .on_size_change((size, cx) => this.sizePane(state, size, cx))
        .on_scroll_wheel((_event, cx) => {
          if (name === "chat" || name === "activity") this.activePane = name;
          state.following = false;
          // The buttons sit on a row's position; hide them until the pointer moves on the scrolled rows.
          if (state.blockHover !== null) { state.blockHover = null; cx.notify(); }
          this.trees?.track(name, state, null, () => cx.notify());
          cx.timer.after(100, next => {
            const offset = state.handle.offset().y;
            const viewport = state.handle.viewport_size().height || state.height;
            state.following = offset + viewport >= state.handle.content_size().height - 2;
            const connection = bridge(); if (connection) this.fetchPane(name, state, connection, next);
          });
        })
        .on_mouse_down("left", (event, cx) => {
          if (!event.local_position || this.trees?.active(name)) return;
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const row = Math.floor((state.handle.offset().y + event.local_position.y / zoom) / panelRowHeight(state));
          this.sendMouse(name, state, row, "press", event, cx);
        })
        .on_window_mouse_move((event, cx) => {
          if (!state.pressed && this.trees?.active(name)) {
            const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
            const x = event.local_position ? event.local_position.x / zoom : -1, y = event.local_position ? event.local_position.y / zoom : -1;
            const viewport = state.handle.viewport_size().height || state.height;
            const inside = x >= 0 && x < (state.lastSize?.width ?? 0) / zoom && y >= 0 && y < viewport;
            this.trees.track(name, state, inside ? y : null, () => cx.notify());
            return;
          }
          if (!state.pressed) { this.trackBlockHover(state, event, cx); this.sendHover(name, state, event, cx); return; }
          if (event.pressed_button !== "left") { this.cancelPaneCapture(name, state, cx); return; }
          if (!event.local_position) return;
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const y = event.local_position.y / zoom;
          const viewport = state.handle.viewport_size().height || state.height;
          const row = Math.floor((state.handle.offset().y + y) / panelRowHeight(state));
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
          if (!state.pressed) return;
          if (!event.local_position) { this.cancelPaneCapture(name, state, cx); return; }
          state.autoScroll = 0;
          if (state.selectionOnly) {
            state.pressed = false; state.selectionOnly = false; state.selecting = false;
            const connection = bridge(); if (connection) this.fetchPane(name, state, connection, cx);
            cx.notify(); return;
          }
          const z = settings().zoom;
          const zoom = typeof z === "number" && z > 0 ? z : 1;
          const row = Math.floor((state.handle.offset().y + event.local_position.y / zoom) / panelRowHeight(state));
          this.sendMouse(name, state, row, "release", event, cx);
        })
        .child(rows).child(Scrollbar.vertical(id).absolute().inset_0())
        .children([...(hovered ? [this.blockButtons(name, state, hovered, t)] : []), this.treeCopy(name, state, t, treeRows), this.latestControl(name, state, t)].filter(Boolean)));
    if (showSurface) panel.child(this.renderSurface(t));
    return panel;
  }

  /** @param {string} type @param {any} event @param {any} cx */
  sendDockMouse(type, event, cx) {
    if (!this.dock?.active || !event.local_position) return;
    const connection = bridge(); if (!connection) return;
    const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
    const x = Math.floor((event.local_position.x / zoom - 8) / this.cellWidth);
    const y = Math.floor((event.local_position.y / zoom + this.dockScroll.offset().y - 4) / rowHeight());
    const inside = x >= 0 && x < this.dock.width && y >= 0 && y < this.dock.lines.length;
    const standalone = type === "move" || type === "wheel";
    if (type === "press") {
      if (!inside || this.dockPending || this.dockPress) return;
      this.dockPress = { frame: this.dock.mouseFrame, x, y, button: event.button ?? "left" };
    }
    if (standalone && (!inside || this.dockPending || this.dockPress)) return;
    const press = standalone ? { frame: this.dock.mouseFrame, button: "none" } : this.dockPress;
    if (!press) return;
    const delta = type === "wheel" ? wheelLines(event) : 0;
    if (type === "wheel" && !delta) return;
    const px = Math.max(-1000000, Math.min(1000000, x));
    const py = Math.max(-1000000, Math.min(1000000, y));
    const data = { type, button: press.button, x: px, y: py, ...pointerModifiers(event),
      ...(delta ? { wheelDelta: delta } : {}), ...(type === "press" && event.click_count > 1 ? { clickCount: Math.min(3, event.click_count) } : {}),
      ...(type === "release" && !inside ? { cancel: true } : {}) };
    this.queueControlMouse({ v: 1, op: "surface-mouse", target: "dock", frame: press.frame, event: data }, connection, cx);
    if (type === "release") this.dockPress = null;
    return true;
  }

  /** @param {any} t */
  renderDock(t) {
    const body = v_flex().id("stereo-dock").relative().flex_none().max_h(200).overflow_y_scroll()
      .track_scroll(this.dockScroll).px(8).py(4)
      .on_mouse_down("left", (event, cx) => this.sendDockMouse("press", event, cx))
      .on_mouse_down("middle", (event, cx) => this.sendDockMouse("press", event, cx))
      .on_mouse_down("right", (event, cx) => this.sendDockMouse("press", event, cx))
      .on_mouse_move((event, cx) => { if (!event.pressed_button) this.sendDockMouse("move", event, cx); })
      .on_window_mouse_move((event, cx) => { if (this.dockPress) event.pressed_button === this.dockPress.button ? this.sendDockMouse("drag", event, cx) : this.cancelControlCapture("dock", cx); })
      .on_window_mouse_up("left", (event, cx) => { if (this.dockPress?.button === "left") event.local_position ? this.sendDockMouse("release", event, cx) : this.cancelControlCapture("dock", cx); })
      .on_window_mouse_up("middle", (event, cx) => { if (this.dockPress?.button === "middle") event.local_position ? this.sendDockMouse("release", event, cx) : this.cancelControlCapture("dock", cx); })
      .on_window_mouse_up("right", (event, cx) => { if (this.dockPress?.button === "right") event.local_position ? this.sendDockMouse("release", event, cx) : this.cancelControlCapture("dock", cx); });
    for (const [index, line] of this.dock.lines.entries()) body.child(h_flex().id(`stereo-dock-row-${index}`).h(LINE_HEIGHT).flex_none().whitespace_nowrap()
      .on_scroll_wheel((event, cx) => this.rowWheel("dock", index, event, cx))
      .children(parseAnsi(line).map(run => this.ansiRun(t, run))));
    if (this.dock.focused && this.surfaceInput && !this.overlays?.overlays.some(layer => layer.focused)) body.child(Input.new(this.surfaceInput).w(300).h(30).mt(8).px(6)
      .border_1().border_color(t.border).bg(t.background).text_color(t.foreground));
    return body;
  }

  /** @param {OverlayLayer} layer @param {string} type @param {any} event @param {any} cx */
  sendOverlayMouse(layer, type, event, cx) {
    if (!event.local_position || !this.overlays) return;
    const connection = bridge(); if (!connection) return;
    const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
    const x = Math.floor(event.local_position.x / zoom / this.cellWidth);
    const y = Math.floor((event.local_position.y / zoom + (this.overlayScrolls.get(layer.id)?.offset().y ?? 0)) / rowHeight());
    const viewportWidth = Math.min(this.controlWidth, layer.width * this.cellWidth);
    const viewportHeight = Math.min(this.controlHeight, layer.height * LINE_HEIGHT + (layer.focused ? 40 : 0));
    const inside = event.local_position.x >= 0 && event.local_position.x / zoom < viewportWidth &&
      event.local_position.y >= 0 && event.local_position.y / zoom < viewportHeight &&
      x >= 0 && x < layer.width && y >= 0 && y < layer.height;
    const standalone = type === "move" || type === "wheel";
    if (type === "press") {
      if (!inside || this.overlaysPending || this.overlayPress) return;
      this.overlayPress = { id: layer.id, frame: layer.mouseFrame, revision: this.overlays.revision, x, y, button: event.button ?? "left" };
    }
    if (standalone && (!inside || this.overlaysPending || this.overlayPress)) return;
    const press = standalone ? { id: layer.id, frame: layer.mouseFrame, revision: this.overlays.revision, button: "none" } : this.overlayPress;
    if (!press || press.id !== layer.id) return;
    const delta = type === "wheel" ? wheelLines(event) : 0;
    if (type === "wheel" && !delta) return;
    const eventData = { type, button: press.button, x: Math.max(-1000000, Math.min(1000000, x)),
      y: Math.max(-1000000, Math.min(1000000, y)), ...pointerModifiers(event),
      ...(delta ? { wheelDelta: delta } : {}), ...(type === "press" && event.click_count > 1 ? { clickCount: Math.min(3, event.click_count) } : {}),
      ...(type === "release" && !inside ? { cancel: true } : {}) };
    this.queueControlMouse({ v: 1, op: "overlay-mouse", revision: press.revision, id: press.id, frame: press.frame, event: eventData }, connection, cx);
    if (type === "release") this.overlayPress = null;
    return true;
  }

  /** @param {OverlayLayer} layer @param {any} t */
  renderOverlay(layer, t) {
    const screen = this.overlays;
    const width = Math.min(this.controlWidth, layer.width * this.cellWidth);
    const height = Math.min(this.controlHeight, layer.height * LINE_HEIGHT + (layer.focused ? 40 : 0));
    const left = Math.max(0, Math.min(this.controlWidth - width, layer.col / Math.max(1, screen.columns) * this.controlWidth));
    const top = Math.max(0, Math.min(this.controlHeight - height, layer.row / Math.max(1, screen.rows) * this.controlHeight));
    let scroll = this.overlayScrolls.get(layer.id);
    if (!scroll) { scroll = ScrollHandle.new(); this.overlayScrolls.set(layer.id, scroll); }
    const body = v_flex().id(`stereo-overlay-${layer.id}`).absolute().left(left).top(top).w(width).h(height)
      .overflow_y_scrollbar().track_scroll(scroll).bg(t.surface)
      .on_mouse_down("left", (event, cx) => { if (layer.focused) this.surfaceInput?.focus(); this.sendOverlayMouse(layer, "press", event, cx); })
      .on_mouse_down("middle", (event, cx) => this.sendOverlayMouse(layer, "press", event, cx))
      .on_mouse_down("right", (event, cx) => this.sendOverlayMouse(layer, "press", event, cx))
      .on_mouse_move((event, cx) => { if (!event.pressed_button) this.sendOverlayMouse(layer, "move", event, cx); })
      .on_window_mouse_move((event, cx) => { if (this.overlayPress?.id === layer.id) event.pressed_button === this.overlayPress.button ? this.sendOverlayMouse(layer, "drag", event, cx) : this.cancelControlCapture("overlay", cx); })
      .on_window_mouse_up("left", (event, cx) => { if (this.overlayPress?.id === layer.id && this.overlayPress.button === "left") event.local_position ? this.sendOverlayMouse(layer, "release", event, cx) : this.cancelControlCapture("overlay", cx); })
      .on_window_mouse_up("middle", (event, cx) => { if (this.overlayPress?.id === layer.id && this.overlayPress.button === "middle") event.local_position ? this.sendOverlayMouse(layer, "release", event, cx) : this.cancelControlCapture("overlay", cx); })
      .on_window_mouse_up("right", (event, cx) => { if (this.overlayPress?.id === layer.id && this.overlayPress.button === "right") event.local_position ? this.sendOverlayMouse(layer, "release", event, cx) : this.cancelControlCapture("overlay", cx); });
    for (const [index, line] of layer.lines.entries()) body.child(h_flex().id(`stereo-overlay-${layer.id}-row-${index}`).h(LINE_HEIGHT).flex_none().whitespace_nowrap()
      .on_scroll_wheel((event, cx) => this.rowWheel("overlay", index, event, cx, layer))
      .children(parseAnsi(line).map(run => this.ansiRun(t, run))));
    if (layer.focused && this.surfaceInput) body.child(Input.new(this.surfaceInput).w_full().h(30).mt(8).px(6)
      .border_1().border_color(t.border).bg(t.background).text_color(t.foreground));
    return body;
  }

  /** @param {any} t */
  renderSurface(t) {
    const rows = this.viewState?.mode === "split" && this.layout() === "rows" && !this.viewState.zoom;
    const available = rows ? Math.max(0, this.areaHeight - this.chatExtent() - 5) : this.areaHeight;
    const height = Math.min(Math.max(LINE_HEIGHT * 2, available * 0.6), this.surface.lines.length * LINE_HEIGHT + (this.surfaceInput ? 46 : 8));
    const body = v_flex().id("stereo-surface").relative().flex_none().h(height).min_h(0).overflow_y_scroll().track_scroll(this.surfaceScroll).px(8).py(4)
      .on_size_change((size, cx) => {
        const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
        const width = size.width / zoom;
        if (Math.abs(width - this.surfaceWidth) >= 1) { this.surfaceWidth = width; cx.notify(); }
      })
      .on_mouse_down("left", (event, cx) => { this.surfaceInput?.focus(); this.sendSurfaceMouse("press", event, cx); })
      .on_mouse_down("middle", (event, cx) => this.sendSurfaceMouse("press", event, cx))
      .on_mouse_down("right", (event, cx) => this.sendSurfaceMouse("press", event, cx))
      .on_mouse_move((event, cx) => { if (!event.pressed_button) this.sendSurfaceMouse("move", event, cx); })
      .on_window_mouse_move((event, cx) => { if (this.surfacePress) event.pressed_button === this.surfacePress.button ? this.sendSurfaceMouse("drag", event, cx) : this.cancelControlCapture("surface", cx); })
      .on_window_mouse_up("left", (event, cx) => { if (this.surfacePress?.button === "left") event.local_position ? this.sendSurfaceMouse("release", event, cx) : this.cancelControlCapture("surface", cx); })
      .on_window_mouse_up("middle", (event, cx) => { if (this.surfacePress?.button === "middle") event.local_position ? this.sendSurfaceMouse("release", event, cx) : this.cancelControlCapture("surface", cx); })
      .on_window_mouse_up("right", (event, cx) => { if (this.surfacePress?.button === "right") event.local_position ? this.sendSurfaceMouse("release", event, cx) : this.cancelControlCapture("surface", cx); });
    for (const [index, line] of this.surface.lines.entries()) {
      body.child(h_flex().id(`stereo-surface-row-${index}`).h(LINE_HEIGHT).flex_none().whitespace_nowrap()
        .on_scroll_wheel((event, cx) => this.rowWheel("surface", index, event, cx))
        .children(parseAnsi(line).map(run => this.ansiRun(t, run))));
    }
    if (this.surfaceInput && !this.overlays?.overlays.some(layer => layer.focused)) body.child(Input.new(this.surfaceInput).w(300).h(30).mt(8).px(6)
      .border_1().border_color(t.border).bg(t.background).text_color(t.foreground));
    return body;
  }

  render() {
    syncTypography();
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
    const hasSurface = !!this.surface?.active;
    const placement = this.dialogPlacement();
    // Until the first state arrives the layout is a guess: draw the background only, so the first frame does not
    // show the default layout and then jump to the real one.
    const loading = this.loading();
    let content;
    if (loading) {
      content = div();
    } else if (!this.available) {
      content = div().px(8).text_color(t.muted).child("Waiting for the Stereo View bridge. The terminal remains available.");
    } else if (state?.mode === "combined" || placement === "combined") {
      content = this.panel("combined", "History", this.combined, t, hasSurface);
    } else if (placement === "maximize") {
      content = this.panel("activity", "Activity", this.activity, t, hasSurface);
    } else {
      const panels = {
        chat: () => this.panel("chat", "Conversation", this.chat, t, hasSurface && state?.zoom === "chat"),
        activity: () => this.panel("activity", "Activity", this.activity, t, hasSurface && state?.zoom !== "chat"),
      };
      const container = this.layout() === "rows" ? v_flex() : h_flex();
      content = container.id("stereo-panels").flex_1().w_full().min_w(0).min_h(0);
      const order = state?.zoom ? [state.zoom] : state?.side === "right" ? ["activity", "chat"] : ["chat", "activity"];
      for (const [index, name] of order.entries()) {
        if (index > 0) content.child(this.divider(t));
        content.child(panels[name]());
      }
    }
    const body = v_flex().id("stereo-body").flex_1().w_full().min_w(0).min_h(0)
      .on_size_change((size, cx) => {
        const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
        const width = size.width / zoom, height = size.height / zoom;
        if (Math.abs(width - this.areaWidth) < 1 && Math.abs(height - this.areaHeight) < 1) return;
        this.areaWidth = width; this.areaHeight = height; this.rememberGeometry(); cx.notify();
      }).child(content);
    const root = v_flex().relative().size_full().min_h(0).bg(t.surface).text_size(UI_TEXT_SIZE)
      .on_size_change((size, cx) => {
        const z = settings().zoom, zoom = typeof z === "number" && z > 0 ? z : 1;
        const width = size.width / zoom, height = size.height / zoom;
        if (Math.abs(width - this.controlWidth) >= 1 || Math.abs(height - this.controlHeight) >= 1) {
          this.controlWidth = width; this.controlHeight = height; this.rememberGeometry(); cx.notify();
        }
      })
      .child(div().id("stereo-cell-probe").absolute().top_0().left_0().opacity(0).whitespace_nowrap()
        .font_family(historyFont()).text_size(historyFontSize())
        .on_size_change((size, cx) => this.measureCell(size, cx)).child("MMMMMMMMMM"))
      .child(props()?.view === "gui" || loading ? div().h(0) : header)
      .child(loading ? div().h(0) : state?.showToolbar !== false ? toolbar : props()?.view === "gui" ? this.control("settings", "Settings", t) : div().h(0))
      .child(this.controlError ? div().px(8).text_color(t.muted).child(this.controlError) : div().h(0))
      .child(body);
    if (!this.surface?.active && this.dock?.active && this.dock.lines.length) root.child(this.renderDock(t));
    for (const layer of this.overlays?.overlays ?? []) root.child(this.renderOverlay(layer, t));
    if (this.focus) root.track_focus(this.focus).on_key_down((event, cx) => {
      if ((this.overlays?.overlays.some(layer => layer.focused) || this.surface?.active || this.dock?.focused) && this.surfaceInput) {
        const key = event.key?.toLowerCase();
        // Text belongs to the native input; forward Enter even when the field is empty.
        if (key === "enter" || key === "return") {
          if (this.sendSurfaceKey(event, cx)) cx.stop_propagation();
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
          const rows = this.layout() === "rows";
          const extent = this.chatExtent() + direction * (rows ? LINE_HEIGHT : 4 * this.cellWidth);
          const value = rows ? Math.max(1, Math.min(240, Math.round(extent / LINE_HEIGHT)))
            : Math.max(24, Math.min(240, Math.round((extent - 16) / this.cellWidth)));
          this.sendSetting(rows ? "chatHeight" : "chatWidth", value, cx);
        } else return;
        cx.notify(); cx.stop_propagation(); return;
      }
      if (this.focus.is_focused() && (key === "pageup" || key === "pagedown" || key === "home" || key === "end")) {
        this.navigate(key, cx); cx.stop_propagation(); return;
      }
      if (event.modifiers?.control && event.key?.toLowerCase() === "f" && this.viewState?.mode === "split") {
        this.openSearch(this.activePane, cx);
        cx.stop_propagation();
      }
    });
    return root;
  }
}
