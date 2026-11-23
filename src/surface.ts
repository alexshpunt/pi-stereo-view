import {
  Container, CURSOR_MARKER, getOsc8LinkAtColumn, ScrollView, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth,
  type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { dispatchMouseEvent, type Dispatched } from "./mouse-dispatch.ts";

// Pi exports stacks and scroll views but not its layout engine. Stacks describe themselves through this symbol.
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const RESET = "\x1b[0m\x1b]8;;\x07";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const ANSI = /\x1b(?:\[[0-9;:?<>=]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x07\x1b]*(?:\x07|\x1b\\))/y;
const DOUBLE_CLICK_INTERVAL_MS = 500;
const WORD_JOINERS = new Set(["/", "-", "+", "\\", "~", "_", "."]);
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WIDTH_CACHE_LIMIT = 50_000;

interface Rect { x: number; y: number; width: number; height: number }
interface Viewport { width: number; height: number }
interface Entry {
  component: Component; basis?: number | "auto"; grow?: number; shrink?: number; minSize?: number; maxSize?: number;
  visible?: (viewport: Viewport) => boolean;
}
type LayoutNode =
  | { type: "vstack" | "hstack"; entries: Entry[]; gap: number; align: "stretch" | "start" | "center" | "end" }
  | { type: "scroll"; component: Component; state: ScrollView };
interface Box {
  component: Component; rect: Rect; clip: Rect; children: Box[];
  lines?: string[]; lineOffset?: number; scrollView?: ScrollView; scrollContentLines?: string[];
}
interface Context { viewport: Viewport; cache: Map<Component, Map<number, string[]>>; requestRender: () => void; scrolls: Map<ScrollView, Box> }
interface Segment { x: number; width: number; line: string; raw?: boolean; background?: boolean }
interface Geometry { column: number; trackTop: number; trackHeight: number; thumbTop: number; thumbHeight: number; maxScrollTop: number }
interface Frame { width: number; height: number; root: Box; lines: string[]; scrolls: Map<ScrollView, Box>; indicator?: { row: number; column: number; width: number } }
interface Point { row: number; col: number; view: ScrollView; boundary?: boolean }
interface Range { start: Point; end: Point }
/** Read-only and opaque scroll-follow hooks offered by projected documents. */
interface ScrollContent { takeScrollShift?(): number }

function layoutNode(component: Component): LayoutNode | undefined {
  const describe = (component as unknown as Record<symbol, unknown>)[LAYOUT_NODE];
  return typeof describe === "function" ? describe.call(component) as LayoutNode : undefined;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function rendered(context: Context, component: Component, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  let widths = context.cache.get(component);
  if (!widths) { widths = new Map(); context.cache.set(component, widths); }
  let lines = widths.get(safeWidth);
  if (!lines) { lines = component.render(safeWidth); widths.set(safeWidth, lines); }
  return lines;
}

function clampSize(size: number, entry: Entry): number {
  const min = Math.max(0, Math.floor(entry.minSize ?? 0));
  const max = Math.max(min, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER));
  return Math.max(min, Math.min(max, Math.max(0, Math.floor(size))));
}

function distribute(sizes: number[], entries: Entry[], amount: number, mode: "grow" | "shrink"): void {
  let remaining = amount;
  while (remaining > 0) {
    const candidates = entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => mode === "grow" ?
      (entry.grow ?? 0) > 0 && sizes[index] < (entry.maxSize ?? Number.MAX_SAFE_INTEGER) :
      (entry.shrink ?? 1) > 0 && sizes[index] > (entry.minSize ?? 0));
    if (!candidates.length) return;
    const weight = (entry: Entry, index: number): number => mode === "grow" ? entry.grow ?? 0 : (entry.shrink ?? 1) * Math.max(1, sizes[index]);
    const total = candidates.reduce((sum, { entry, index }) => sum + weight(entry, index), 0);
    let distributed = 0;
    for (const { entry, index } of candidates) {
      if (remaining <= 0) break;
      const proposed = Math.max(1, Math.floor(remaining * weight(entry, index) / total));
      const capacity = mode === "grow" ? (entry.maxSize ?? Number.MAX_SAFE_INTEGER) - sizes[index] : sizes[index] - (entry.minSize ?? 0);
      const delta = Math.min(remaining, proposed, capacity);
      if (delta <= 0) continue;
      sizes[index] += mode === "grow" ? delta : -delta;
      remaining -= delta;
      distributed += delta;
    }
    if (!distributed) return;
  }
}

/** Same allocation as Pi's stacks, so the split keeps its native sizing rules. */
function allocate(entries: Entry[], intrinsic: number[], available: number | undefined, gap: number): number[] {
  const sizes = entries.map((entry, index) => clampSize(entry.basis === undefined || entry.basis === "auto" ? intrinsic[index] ?? 0 : entry.basis, entry));
  if (available === undefined) return sizes;
  const content = Math.max(0, Math.floor(available) - Math.max(0, entries.length - 1) * gap);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total < content) distribute(sizes, entries, content - total, "grow");
  else if (total > content) distribute(sizes, entries, total - content, "shrink");
  return sizes;
}

function translate(box: Box, delta: number): void {
  box.rect.y += delta;
  for (const child of box.children) translate(child, delta);
}

function updateClips(box: Box, parent: Rect): void {
  box.clip = intersect(parent, box.rect);
  for (const child of box.children) updateClips(child, box.clip);
}

/** Set a pane's scroll position without the transient scrollbar a user scroll shows. */
function restoreScrollTop(view: ScrollView, top: number): void {
  const max = Math.max(0, (Reflect.get(view, "contentHeight") as number ?? 0) - view.viewportHeight);
  const next = Math.max(0, Math.min(max, Math.trunc(top)));
  if (typeof Reflect.get(view, "currentScrollTop") === "number") Reflect.set(view, "currentScrollTop", next);
  else view.scrollTo(next, { disableFollow: true });
}

/** Port of Pi's layout pass. It runs inside one full-width component, so Pi paints the split without compositing. */
function layout(context: Context, component: Component, x: number, y: number, width: number, height: number | undefined, clip: Rect): Box {
  const safeWidth = Math.max(1, Math.floor(width));
  const node = layoutNode(component);
  if (!node) {
    const lines = rendered(context, component, safeWidth);
    const allocated = height === undefined ? lines.length : Math.max(0, Math.floor(height));
    let lineOffset = 0;
    if (lines.length > allocated && allocated > 0) {
      const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
      if (cursor >= allocated) lineOffset = cursor - allocated + 1;
    }
    const rect = { x, y, width: safeWidth, height: allocated };
    return { component, rect, clip: intersect(clip, rect), children: [], lines, lineOffset };
  }
  if (node.type === "scroll") {
    const state = node.state;
    const previous = state.scrollTop;
    const contentWidth = state.getContentWidth(safeWidth);
    const child = layout(context, node.component, x, y - previous, contentWidth, undefined, clip);
    const contentHeight = child.rect.height;
    const viewport = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
    state.updateLayout(contentHeight, viewport, context.requestRender);
    const shift = (node.component as Component & ScrollContent).takeScrollShift?.() ?? 0;
    if (shift && !state.isFollowingEnd) restoreScrollTop(state, state.scrollTop + shift);
    translate(child, previous - state.scrollTop);
    const rect = { x, y, width: safeWidth, height: viewport };
    const box: Box = { component, rect, clip: intersect(clip, rect), children: [child], scrollView: state,
      scrollContentLines: rendered(context, node.component, contentWidth) };
    updateClips(child, box.clip);
    context.scrolls.set(state, box);
    return box;
  }
  const entries = node.entries.filter(entry => entry.visible?.(context.viewport) ?? true);
  const gaps = Math.max(0, entries.length - 1) * node.gap;
  if (node.type === "vstack") {
    const intrinsic = entries.map(entry => typeof entry.basis === "number" ? entry.basis : rendered(context, entry.component, safeWidth).length);
    const sizes = allocate(entries, intrinsic, height, node.gap);
    const allocated = height === undefined ? sizes.reduce((sum, size) => sum + size, 0) + gaps : Math.max(0, Math.floor(height));
    const rect = { x, y, width: safeWidth, height: allocated };
    const box: Box = { component, rect, clip: intersect(clip, rect), children: [] };
    let childY = y;
    for (let index = 0; index < entries.length; index++) {
      box.children.push(layout(context, entries[index].component, x, childY, safeWidth, sizes[index], box.clip));
      childY += sizes[index] + node.gap;
    }
    return box;
  }
  const intrinsicWidths = entries.map(entry => typeof entry.basis === "number" ? entry.basis :
    rendered(context, entry.component, safeWidth).reduce((max, line) => Math.max(max, visibleWidth(line)), 0));
  const widths = allocate(entries, intrinsicWidths, safeWidth, node.gap);
  const heights = entries.map((entry, index) => rendered(context, entry.component, Math.max(1, widths[index])).length);
  const allocated = height === undefined ? heights.reduce((max, value) => Math.max(max, value), 0) : Math.max(0, height);
  const rect = { x, y, width: safeWidth, height: allocated };
  const box: Box = { component, rect, clip: intersect(clip, rect), children: [] };
  let childX = x;
  for (let index = 0; index < entries.length; index++) {
    const childHeight = node.align === "stretch" ? allocated : Math.min(allocated, heights[index]);
    let childY = y;
    if (node.align === "center") childY += Math.floor((allocated - childHeight) / 2);
    else if (node.align === "end") childY += allocated - childHeight;
    if (widths[index] === 0) {
      box.children.push({ component: entries[index].component, rect: { x: childX, y: childY, width: 0, height: childHeight },
        clip: { x: childX, y: childY, width: 0, height: 0 }, children: [] });
    } else box.children.push(layout(context, entries[index].component, childX, childY, widths[index], childHeight, box.clip));
    childX += widths[index] + node.gap;
  }
  return box;
}

function scrollbarGeometry(box: Box, includeHiddenAuto = false): Geometry | undefined {
  const view = box.scrollView;
  if (!view || box.rect.width <= 0 || box.rect.height <= 0) return undefined;
  const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
  const trackHeight = box.rect.height;
  if (!view.isScrollbarVisible && !(includeHiddenAuto && view.scrollbar === "auto" && contentHeight > trackHeight)) return undefined;
  const thumbHeight = Math.max(Math.min(2, trackHeight), Math.min(trackHeight, Math.round(trackHeight * trackHeight / contentHeight)));
  const maxScrollTop = Math.max(0, contentHeight - trackHeight);
  const thumbOffset = maxScrollTop === 0 ? 0 : Math.round(view.scrollTop / maxScrollTop * (trackHeight - thumbHeight));
  const column = box.rect.x + box.rect.width - 1;
  if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;
  return { column, trackTop: box.rect.y, trackHeight, thumbTop: box.rect.y + thumbOffset, thumbHeight, maxScrollTop };
}

/** Background color active at the end of a styled prefix, so a scrollbar cell keeps its row's fill. */
export function activeBackground(text: string): string {
  let background = "";
  for (const match of text.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    const params = match[1] === "" ? [0] : match[1].split(/[;:]/).map(Number);
    for (let index = 0; index < params.length; index++) {
      const code = params[index];
      if (code === 0 || code === 49) background = "";
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) background = `\x1b[${code}m`;
      else if (code === 48 && params[index + 1] === 5) { background = `\x1b[48;5;${params[index + 2]}m`; index += 2; }
      else if (code === 48 && params[index + 1] === 2) {
        background = `\x1b[48;2;${params[index + 2]};${params[index + 3]};${params[index + 4]}m`;
        index += 4;
      } else if ((code === 38 || code === 58) && params[index + 1] === 5) index += 2;
      else if ((code === 38 || code === 58) && params[index + 1] === 2) index += 4;
    }
  }
  return background;
}

/** Cell range of the grapheme at a column, ignoring terminal sequences. */
function graphemeRange(line: string, column: number): { start: number; end: number } | undefined {
  let current = 0;
  for (const { segment } of graphemes.segment(stripTerminalSequences(line))) {
    const width = visibleWidth(segment);
    if (width > 0 && column >= current && column < current + width) return { start: current, end: current + width };
    current += width;
  }
  return undefined;
}

function highlightSelection(text: string): string {
  let result = "\x1b[7m";
  let index = 0;
  while (index < text.length) {
    ANSI.lastIndex = index;
    const match = ANSI.exec(text);
    if (!match) { result += text[index++]; continue; }
    result += match[0];
    if (match[0].endsWith("m")) result += "\x1b[7m";
    index += match[0].length;
  }
  return result + "\x1b[27m";
}

/** One scroll position for Pi's keyboard scrolling, prompt jumps and follow-end: the active split panel's. */
export class ActivePaneScrollView extends ScrollView {
  constructor(private readonly target: () => ScrollView | undefined, lines: () => string[]) {
    super({ render: () => lines(), invalidate() {} }, { follow: "end" });
    Object.defineProperty(this, "primary", { value: true });
    Object.defineProperty(this, "followEnd", { get: () => this.target()?.followEnd ?? false });
  }

  override get scrollTop(): number { return this.target()?.scrollTop ?? 0; }
  override get isFollowingEnd(): boolean { return this.target()?.isFollowingEnd ?? true; }
  override get viewportHeight(): number { return this.target()?.viewportHeight ?? 0; }
  override get isScrollbarVisible(): boolean { return false; }
  override scrollTo(scrollTop: number, options?: Parameters<ScrollView["scrollTo"]>[1]): void { this.target()?.scrollTo(scrollTop, options); }
  override scrollBy(lines: number): number { return this.target()?.scrollBy(lines) ?? lines; }
  override scrollToStart(): void { this.target()?.scrollToStart(); }
  override scrollToEnd(): void { this.target()?.scrollToEnd(); }
  override setScrollbarActive(): void {}
  // Pi lays this view out with no rows; the panels' own layout pass sizes the real views.
  override updateLayout(): void {}
}

export interface SplitSurfaceOptions {
  /** Current split tree, whether it fills the available rows, and its minimum height. */
  model(): { component: Component; fill: boolean; minSize: number } | undefined;
  /** Rows between the toolbar and the dock. */
  height(): number;
  /** Panel receiving keyboard scrolling and the follow-end indicator. */
  active(): ScrollView | undefined;
  /** An error while painting or dispatching the panels; it must not reach Pi's render loop, which would end Pi. */
  failed?(error: unknown): void;
  /** A pointer move starts and ends its dispatch; documents report what lies under it in between. */
  pointer?: { start(): void; end(): void; leave(): void };
}

type SelectionApi = Record<"hasActiveSelection" | "copyActiveSelectionToClipboard" | "resetTextSelection", (...args: never[]) => unknown>;

/**
 * Paint the split area as one full-width component. Pi assigns full-width rows directly, while panels at a column
 * offset would go through its per-row compositor. This component runs Pi's layout rules for the split tree itself,
 * pads each panel row to its width and joins the rows. It also owns what Pi does only for views it lays out:
 * scrollbars, the follow-end indicator, wheel routing, mouse dispatch and text selection inside panels.
 */
export class SplitSurface extends Container {
  readonly proxy: ActivePaneScrollView;
  private frame?: Frame;
  private readonly widths = new Map<string, number>();
  private hover?: ScrollView;
  private lastEvent?: TuiMouseEvent;
  private scrollbarDrag?: { view: ScrollView; grab: number };
  private anchor?: Point;
  private focus?: Point;
  private granularity: "character" | "word" | "line" = "character";
  private initial?: Range;
  private pressing = false;
  private dragged = false;
  private pendingClick = false;
  private pressedUrl?: string;
  private lastClick?: { time: number; count: number; row: number; view: ScrollView; start: number; end: number };
  private autoScroll?: { timer: ReturnType<typeof setInterval>; direction: number; x: number; y: number };
  private restoreApi: (() => void)[] = [];
  private readonly requestRender = (): void => this.tui.requestRender();

  constructor(private readonly tui: TUI, private readonly options: SplitSurfaceOptions) {
    super();
    this.proxy = new ActivePaneScrollView(options.active, () => {
      const view = options.active();
      return (view && this.frame?.scrolls.get(view)?.scrollContentLines) ?? [];
    });
    this.installSelectionApi();
  }

  /** Components owned by the split tree, so invalidation and inspection still reach them. */
  setModels(components: Component[]): void {
    this.children = components;
  }

  override render(width: number): string[] {
    try {
      return this.layoutFrame(width);
    } catch (error) {
      if (!this.options.failed) throw error;
      this.frame = undefined;
      this.options.failed(error);
      return [];
    }
  }

  private layoutFrame(width: number): string[] {
    const model = this.options.model();
    this.syncHostSelection();
    if (!model) {
      this.frame = undefined;
      return [];
    }
    const context: Context = {
      viewport: { width, height: Math.max(1, this.tui.terminal.rows) }, cache: new Map(), requestRender: this.requestRender, scrolls: new Map(),
    };
    const available = Math.max(0, Math.floor(this.options.height()));
    const natural = model.fill ? available : rendered(context, model.component, width).length;
    const height = Math.max(model.minSize, Math.min(natural, available));
    const clip = { x: 0, y: 0, width, height };
    const root = layout(context, model.component, 0, 0, width, height, clip);
    const frame: Frame = { width, height, root, lines: [], scrolls: context.scrolls };
    frame.lines = this.paint(frame);
    this.frame = frame;
    return frame.lines;
  }

  private paint(frame: Frame): string[] {
    const rows: Segment[][] = Array.from({ length: frame.height }, () => []);
    const punches: Segment[][] = Array.from({ length: frame.height }, () => []);
    const selection = this.selectionBounds();
    const collect = (box: Box, selected?: Range): void => {
      if (box.lines) {
        const offset = box.lineOffset ?? 0;
        const first = Math.max(box.rect.y, box.clip.y, 0);
        const last = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, frame.height);
        for (let row = first; row < last; row++) {
          const index = offset + row - box.rect.y;
          let line = box.lines[index];
          if (line === undefined) continue;
          if (line.startsWith("\x1b]133;")) line = line.replace(OSC133_ZONE_PREFIX, "");
          if (selected && index >= selected.start.row && index <= selected.end.row) line = this.highlight(line, index, selected, box.rect.width);
          rows[row].push({ x: box.rect.x, width: box.rect.width, line });
        }
      }
      for (const child of box.children) collect(child, box.scrollView && selection?.start.view === box.scrollView ? selection : undefined);
      if (box.scrollView) this.scrollbar(box, punches, frame.height);
    };
    collect(frame.root);
    this.indicator(frame, punches);
    return rows.map((segments, row) => {
      for (const punch of punches[row]) this.punch(segments, punch);
      return this.compose(segments);
    });
  }

  private scrollbar(box: Box, punches: Segment[][], height: number): void {
    const geometry = scrollbarGeometry(box);
    const view = box.scrollView;
    if (!geometry || !view) return;
    for (let row = geometry.trackTop; row < geometry.trackTop + geometry.trackHeight; row++) {
      if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= height) continue;
      const thumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
      const line = thumb ? view.scrollbarThumbStyle(view.isScrollbarActive ? "█" : "┃") : view.scrollbarTrackStyle("│");
      punches[row].push({ x: geometry.column, width: 1, line, raw: true, background: view.scrollbar !== "always" });
    }
  }

  private indicator(frame: Frame, punches: Segment[][]): void {
    const view = this.options.active();
    const label = Reflect.get(this.tui, "scrollToEndIndicator") as (() => string) | undefined;
    const box = view && frame.scrolls.get(view);
    if (typeof label !== "function" || !view?.followEnd || view.isFollowingEnd || !box) return;
    const clip = box.clip;
    if (clip.width <= 0 || clip.height <= 0) return;
    const row = clip.y + clip.height - 1;
    if (row >= frame.height) return;
    const text = truncateToWidth(label(), clip.width, "");
    const column = clip.x + Math.floor((clip.width - visibleWidth(text)) / 2);
    const right = scrollbarGeometry(box)?.column ?? clip.x + clip.width;
    const shown = truncateToWidth(text, Math.max(0, right - column), "");
    const width = visibleWidth(shown);
    if (!width) return;
    punches[row].push({ x: column, width, line: shown, raw: true });
    frame.indicator = { row, column, width };
  }

  /** Replace cells of an underlying panel row, as Pi's scrollbar and indicator overlays do. */
  private punch(segments: Segment[], punch: Segment): void {
    const index = segments.findIndex(segment => !segment.raw && punch.x >= segment.x && punch.x < segment.x + segment.width);
    if (index < 0) {
      segments.push(punch);
      return;
    }
    const segment = segments[index];
    const left = punch.x - segment.x;
    const rightStart = punch.x + punch.width;
    const rightWidth = segment.x + segment.width - rightStart;
    const parts: Segment[] = [];
    if (left > 0) parts.push({ x: segment.x, width: left, line: segment.line });
    const fill = punch.background ? activeBackground(sliceByColumn(segment.line, 0, left + 1, true)) : "";
    parts.push({ ...punch, line: RESET + fill + punch.line });
    if (rightWidth > 0) parts.push({ x: rightStart, width: rightWidth, line: sliceByColumn(segment.line, rightStart - segment.x, rightWidth, true) });
    segments.splice(index, 1, ...parts);
  }

  private compose(segments: Segment[]): string {
    if (!segments.length) return "";
    if (segments.length > 1) segments.sort((a, b) => a.x - b.x);
    let line = "";
    let column = 0;
    for (const segment of segments) {
      if (segment.width <= 0 || segment.x < column) continue;
      if (segment.x > column) line += " ".repeat(segment.x - column);
      line += (segment.raw ? segment.line : this.fit(segment.line, segment.width)) + RESET;
      column = segment.x + segment.width;
    }
    return line;
  }

  private widthOf(line: string): number {
    let width = this.widths.get(line);
    if (width === undefined) {
      if (this.widths.size >= WIDTH_CACHE_LIMIT) this.widths.clear();
      width = visibleWidth(line);
      this.widths.set(line, width);
    }
    return width;
  }

  private fit(line: string, width: number): string {
    const actual = this.widthOf(line);
    if (actual === width) return line;
    if (actual < width) return line + " ".repeat(width - actual);
    const cut = sliceByColumn(line, 0, width, true);
    const cutWidth = visibleWidth(cut);
    return cutWidth < width ? cut + " ".repeat(width - cutWidth) : cut;
  }

  // Mouse

  private boxesAt(x: number, y: number): Box[] {
    const found: { box: Box; depth: number }[] = [];
    const visit = (box: Box, depth: number): void => {
      if (!contains(box.clip, x, y)) return;
      found.push({ box, depth });
      for (const child of box.children) visit(child, depth + 1);
    };
    if (this.frame) visit(this.frame.root, 0);
    return found.sort((a, b) => b.depth - a.depth).map(entry => entry.box);
  }

  private scrollViewsAt(x: number, y: number): ScrollView[] {
    return this.boxesAt(x, y).filter(box => box.scrollView && contains(box.rect, x, y)).map(box => box.scrollView!);
  }

  /** Dispatch like Pi: deepest component first, with exact targets so Pi captures drags directly. */
  private dispatch(event: TuiMouseEvent): Dispatched | undefined {
    const visited = new Set<Component>();
    for (const box of this.boxesAt(event.x, event.y)) {
      const component = box.component;
      if (visited.has(component) || !component.handleMouse) continue;
      if (layoutNode(component) && component.handleMouse === Container.prototype.handleMouse) continue;
      visited.add(component);
      const local = { ...event, x: event.x - box.rect.x, y: event.y - box.rect.y, width: box.rect.width, height: box.rect.height };
      const result = dispatchMouseEvent(component, local);
      if (result) return result;
    }
    return undefined;
  }

  private scrollbarAt(x: number, y: number, includeHiddenAuto: boolean): { view: ScrollView; geometry: Geometry } | undefined {
    for (const view of this.scrollViewsAt(x, y)) {
      const box = this.frame?.scrolls.get(view);
      const geometry = box && scrollbarGeometry(box, includeHiddenAuto);
      if (geometry && x === geometry.column && y >= geometry.trackTop && y < geometry.trackTop + geometry.trackHeight) return { view, geometry };
    }
    return undefined;
  }

  private setHover(view: ScrollView | undefined): void {
    if (view === this.hover) return;
    this.hover?.setScrollbarActive(false);
    this.hover = view;
    view?.setScrollbarActive(true);
  }

  /** Pi passed an event no component handled; clear hover unless this surface just saw it. */
  unhandled(event: TuiMouseEvent): void {
    const seen = this.lastEvent;
    if (seen && seen.type === event.type && seen.screenX === event.screenX && seen.screenY === event.screenY) return;
    if (!this.scrollbarDrag && event.type !== "wheel") this.setHover(undefined);
    if (event.type === "move") this.options.pointer?.leave();
  }

  private scrollToPointer(view: ScrollView, geometry: Geometry, y: number, grab: number): void {
    const maxThumb = geometry.trackHeight - geometry.thumbHeight;
    const thumb = Math.max(0, Math.min(maxThumb, y - geometry.trackTop - grab));
    view.scrollTo(maxThumb === 0 ? 0 : Math.round(thumb / maxThumb * geometry.maxScrollTop));
  }

  override handleMouse(event: TuiMouseEvent): Dispatched | undefined {
    this.lastEvent = event;
    let result: (TuiMouseEventResult & Partial<Dispatched>) | undefined;
    const move = event.type === "move";
    try {
      if (move) this.options.pointer?.start();
      try {
        result = this.mouse(event) as typeof result;
      } finally {
        if (move) this.options.pointer?.end();
      }
    } catch (error) {
      if (!this.options.failed) throw error;
      this.frame = undefined;
      this.options.failed(error);
      return undefined;
    }
    if (!result || result.target) return result as Dispatched | undefined;
    if (!result.handled && !result.capture && !result.focus) return undefined;
    return { ...result, handled: true, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
      width: event.width, height: event.height } };
  }

  private mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.frame) return undefined;
    if (this.scrollbarDrag) {
      const drag = this.scrollbarDrag;
      if (event.type === "release") this.scrollbarDrag = undefined;
      else if (event.type === "drag") {
        const box = this.frame.scrolls.get(drag.view);
        const geometry = box && scrollbarGeometry(box);
        if (geometry) this.scrollToPointer(drag.view, geometry, event.y, drag.grab);
      }
      return { handled: true };
    }
    if (this.pressing) return this.continueSelection(event);
    if (event.type === "click") return this.pendingClick ? this.finishClick(event) : undefined;
    if (event.type === "release") return undefined;
    if (event.type === "press" && event.button === "left") {
      const indicator = this.frame.indicator;
      if (indicator && event.y === indicator.row && event.x >= indicator.column && event.x < indicator.column + indicator.width) {
        this.options.active()?.scrollToEnd();
        this.requestRender();
        return { handled: true };
      }
      const bar = this.scrollbarAt(event.x, event.y, false);
      if (bar) {
        this.clearSelection();
        this.lastClick = undefined;
        this.setHover(bar.view);
        const onThumb = event.y >= bar.geometry.thumbTop && event.y < bar.geometry.thumbTop + bar.geometry.thumbHeight;
        const grab = onThumb ? event.y - bar.geometry.thumbTop : Math.floor(bar.geometry.thumbHeight / 2);
        if (!onThumb) this.scrollToPointer(bar.view, bar.geometry, event.y, grab);
        this.scrollbarDrag = { view: bar.view, grab };
        return { capture: true };
      }
    }
    if (event.type !== "wheel") this.setHover(this.scrollbarAt(event.x, event.y, true)?.view);
    const result = this.dispatch(event);
    if (result) {
      if (event.type === "press") this.clearSelection();
      return result;
    }
    if (event.type === "wheel") return this.routeWheel(event);
    if (event.type === "press" && event.button === "left") return this.startSelection(event);
    return undefined;
  }

  private routeWheel(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const views = this.scrollViewsAt(event.x, event.y);
    if (!views.length) return undefined;
    let remaining = event.wheelDelta ?? 0;
    for (const view of views) {
      remaining = view.scrollBy(remaining);
      if (remaining === 0 || view.overscroll === "contain") break;
    }
    const active = this.options.active();
    // Pi passes leftover wheel movement to its primary view, which is the active panel here.
    if (remaining !== 0 && active && !views.includes(active)) this.proxy.scrollBy(remaining);
    this.setHover(this.scrollbarAt(event.x, event.y, true)?.view);
    return { handled: true };
  }

  // Selection inside panels, matching Pi's selection in its own scroll views.

  private point(view: ScrollView, x: number, y: number): Point | undefined {
    const frame = this.frame;
    const box = frame?.scrolls.get(view);
    if (!frame || !box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
    const top = Math.max(0, box.rect.y, box.clip.y);
    const bottom = Math.min(frame.height - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
    if (bottom < top) return undefined;
    const pointer = Math.max(top, Math.min(bottom, y));
    const maxRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
    return {
      row: Math.max(0, Math.min(maxRow, view.scrollTop + pointer - box.rect.y)),
      col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)), view,
    };
  }

  private sourceLine(point: Point): string {
    return this.frame?.scrolls.get(point.view)?.scrollContentLines?.[point.row] ?? "";
  }

  private wordAt(point: Point): Range | undefined {
    const line = stripTerminalSequences(this.sourceLine(point));
    const segments: { start: number; end: number; selectable: boolean; joiner: boolean }[] = [];
    let start = 0;
    for (const segment of words.segment(line)) {
      const end = start + visibleWidth(segment.segment);
      const joiner = WORD_JOINERS.has(segment.segment);
      segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
      start = end;
    }
    const clicked = segments.findIndex(segment => point.col >= segment.start && point.col < segment.end);
    if (clicked < 0) return undefined;
    const join = (left: typeof segments[number], right: typeof segments[number]): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
    let first = clicked;
    while (first > 0 && join(segments[first - 1], segments[first])) first--;
    let last = clicked;
    while (last < segments.length - 1 && join(segments[last], segments[last + 1])) last++;
    return { start: { ...point, col: segments[first].start }, end: { ...point, col: segments[last].end, boundary: true } };
  }

  private lineAt(point: Point): Range {
    return { start: { ...point, col: 0 }, end: { ...point, col: visibleWidth(this.sourceLine(point)), boundary: true } };
  }

  private clickCount(point: Point, word: Range | undefined): number {
    const now = Date.now();
    const previous = this.lastClick;
    const count = word && previous && now - previous.time <= DOUBLE_CLICK_INTERVAL_MS && previous.row === point.row &&
      previous.view === point.view && previous.start === word.start.col && previous.end === word.end.col ? previous.count % 3 + 1 : 1;
    this.lastClick = word ? { time: now, count, row: point.row, view: point.view, start: word.start.col, end: word.end.col } : undefined;
    return count;
  }

  private startSelection(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const view = this.scrollViewsAt(event.x, event.y)[0];
    const anchor = view && this.point(view, event.x, event.y);
    if (!anchor) return undefined;
    this.stopAutoScroll();
    const word = this.wordAt(anchor);
    const count = this.clickCount(anchor, word);
    const range = count === 2 ? word : count === 3 ? this.lineAt(anchor) : undefined;
    this.granularity = range ? count === 2 ? "word" : "line" : "character";
    this.initial = range;
    this.anchor = range?.start ?? anchor;
    this.focus = range?.end ?? anchor;
    this.dragged = false;
    this.pendingClick = false;
    this.pressing = true;
    this.pressedUrl = range ? undefined : getOsc8LinkAtColumn(this.frame?.lines[event.y] ?? "", event.x);
    return { capture: true, render: true };
  }

  private updateFocus(point: Point | undefined): void {
    if (!point) return;
    if (this.granularity === "character" || !this.initial) {
      this.focus = point;
      return;
    }
    const range = this.granularity === "word" ? this.wordAt(point) : this.lineAt(point);
    if (!range) return;
    const initial = this.initial;
    if (range.start.row < initial.start.row || (range.start.row === initial.start.row && range.start.col < initial.start.col)) {
      this.anchor = initial.end;
      this.focus = range.start;
    } else {
      this.anchor = initial.start;
      this.focus = range.end;
    }
  }

  private continueSelection(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const view = this.anchor?.view;
    if (!view) {
      this.pressing = false;
      return { handled: true };
    }
    const point = this.point(view, event.x, event.y);
    if (event.type === "drag") {
      this.dragged = true;
      this.lastClick = undefined;
      this.pressedUrl = undefined;
      this.updateFocus(point);
      this.updateAutoScroll(event);
      return { handled: true, render: true };
    }
    if (event.type !== "release") return { handled: true };
    this.pressing = false;
    this.stopAutoScroll();
    const anchor = this.anchor!;
    this.updateFocus(point);
    const click = !this.dragged && point?.view === anchor.view && point.row === anchor.row && point.col === anchor.col;
    const url = click ? this.pressedUrl : undefined;
    this.pressedUrl = undefined;
    const open = Reflect.get(this.tui, "openUrl") as ((url: string) => void) | undefined;
    if (url && typeof open === "function") {
      this.anchor = undefined;
      this.focus = undefined;
      try { open(url); } catch { /* URL activation is best-effort, as in Pi. */ }
      return { handled: true, render: true };
    }
    // Pi follows an unmoved release with a click event; components may handle it.
    if (click) this.pendingClick = true;
    else if ((this.tui as TUI & { getCopyOnSelect?(): boolean }).getCopyOnSelect?.() ?? true) void this.copySelection();
    return { handled: true, render: true };
  }

  private finishClick(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    this.pendingClick = false;
    const result = this.dispatch(event);
    if (result) {
      this.clearSelection();
      return result;
    }
    return { handled: true, render: true };
  }

  private updateAutoScroll(event: TuiMouseEvent): void {
    const view = this.anchor?.view;
    const box = view && this.frame?.scrolls.get(view);
    if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
      this.stopAutoScroll();
      return;
    }
    const top = Math.max(0, box.rect.y, box.clip.y);
    const bottom = Math.min(this.frame!.height - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
    const direction = event.y <= top ? -1 : event.y >= bottom ? 1 : 0;
    if (!direction) {
      this.stopAutoScroll();
      return;
    }
    if (this.autoScroll) {
      Object.assign(this.autoScroll, { direction, x: event.x, y: event.y });
      return;
    }
    const timer = setInterval(() => this.autoScrollSelection(), 50);
    timer.unref?.();
    this.autoScroll = { timer, direction, x: event.x, y: event.y };
  }

  private autoScrollSelection(): void {
    const scroll = this.autoScroll;
    const view = this.anchor?.view;
    const capture = Reflect.get(this.tui, "mouseCapture") as { component?: Component } | undefined;
    // Pi drops captured gestures when the terminal loses focus.
    if (!scroll || !view || !this.pressing || capture?.component !== this) {
      this.stopAutoScroll();
      return;
    }
    if (view.scrollBy(scroll.direction) === scroll.direction) {
      this.stopAutoScroll();
      return;
    }
    this.updateFocus(this.point(view, scroll.x, scroll.y));
    this.requestRender();
  }

  private stopAutoScroll(): void {
    if (this.autoScroll) clearInterval(this.autoScroll.timer);
    this.autoScroll = undefined;
  }

  private clearSelection(): void {
    this.stopAutoScroll();
    this.pressing = false;
    this.anchor = undefined;
    this.focus = undefined;
    this.granularity = "character";
    this.initial = undefined;
    this.pressedUrl = undefined;
    this.dragged = false;
    this.pendingClick = false;
  }

  /** Pi's own screen selection, or a press another component handled, replaces a panel selection. */
  private syncHostSelection(): void {
    if (!this.anchor) return;
    const target = Reflect.get(this.tui, "mousePressTarget") as { component?: Component } | undefined;
    if (Reflect.get(this.tui, "selectionAnchor") !== undefined || (target && target.component !== this)) this.clearSelection();
  }

  private selectionBounds(): Range | undefined {
    const anchor = this.anchor;
    const focus = this.focus;
    if (!anchor || !focus || anchor.view !== focus.view || (anchor.row === focus.row && anchor.col === focus.col)) return undefined;
    return anchor.row < focus.row || (anchor.row === focus.row && anchor.col < focus.col) ? { start: anchor, end: focus } : { start: focus, end: anchor };
  }

  private columns(line: string, row: number, selection: Range, maxColumn: number): { start: number; end: number } {
    const width = this.widthOf(line);
    let start = 0;
    let end = Math.min(width, maxColumn);
    if (row === selection.start.row) start = graphemeRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, width);
    if (row === selection.end.row) {
      end = selection.end.boundary ? Math.min(selection.end.col, width) :
        graphemeRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, width);
    }
    return { start: Math.max(0, start), end: Math.min(maxColumn, end) };
  }

  private highlight(line: string, row: number, selection: Range, maxColumn: number): string {
    const { start, end } = this.columns(line, row, selection, maxColumn);
    if (end <= start) return line;
    const width = this.widthOf(line);
    return sliceByColumn(line, 0, start, true) + highlightSelection(sliceByColumn(line, start, end - start, true)) +
      sliceByColumn(line, end, Math.max(0, width - end), true);
  }

  private selectedText(): string | undefined {
    const selection = this.selectionBounds();
    const lines = selection && this.frame?.scrolls.get(selection.start.view)?.scrollContentLines;
    if (!selection || !lines) return undefined;
    const text: string[] = [];
    for (let row = selection.start.row; row <= selection.end.row; row++) {
      const line = lines[row] ?? "";
      const { start, end } = this.columns(line, row, selection, Number.MAX_SAFE_INTEGER);
      text.push(stripTerminalSequences(sliceByColumn(line, start, Math.max(0, end - start), true)).trimEnd());
    }
    const joined = text.join("\n");
    return joined.length ? joined : undefined;
  }

  private async copySelection(): Promise<boolean> {
    const text = this.selectedText();
    const copy = Reflect.get(this.tui, "copyTextToClipboard") as ((text: string) => Promise<boolean>) | undefined;
    if (!text || typeof copy !== "function") return false;
    return copy.call(this.tui, text);
  }

  /** Pi's selection commands (copy without copy-on-select, transcript reset) also cover panel selections. */
  private installSelectionApi(): void {
    const host = this.tui as unknown as Partial<SelectionApi>;
    const wrap = <K extends keyof SelectionApi>(name: K, create: (original: SelectionApi[K]) => SelectionApi[K]): void => {
      const original = host[name];
      if (typeof original !== "function") return;
      const own = Object.getOwnPropertyDescriptor(host, name);
      const bound = original.bind(host) as SelectionApi[K];
      const wrapper = create(bound);
      host[name] = wrapper;
      this.restoreApi.push(() => {
        if (host[name] !== wrapper) return;
        if (own) Object.defineProperty(host, name, own);
        else Reflect.deleteProperty(host, name);
      });
    };
    wrap("hasActiveSelection", original => () => this.selectedText() !== undefined || original());
    wrap("copyActiveSelectionToClipboard", original => () => this.selectedText() !== undefined ? this.copySelection() : original());
    wrap("resetTextSelection", original => () => {
      this.clearSelection();
      this.lastClick = undefined;
      return original();
    });
  }

  /** Stop timers and give Pi back its own selection commands. */
  dispose(): void {
    this.clearSelection();
    this.setHover(undefined);
    this.scrollbarDrag = undefined;
    for (const restore of this.restoreApi.splice(0)) restore();
    this.frame = undefined;
  }
}
