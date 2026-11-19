import type { Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { searchText, type SearchEntry, type SearchHit } from "./search.ts";
import { highlightSearchRows, searchHitRow, type SearchClock } from "./search-highlight.ts";
import { CompactMessage, type TranscriptTimestamps } from "./timestamps.ts";
import { NativeContentIndex, type ContentEntry, type Pane } from "./content.ts";
import { CompactTool } from "./compact-tools.ts";
import { toolPresentations, type ToolPresentation } from "./tool-presentation.ts";
import { ToolStreaming } from "./tool-streaming.ts";
import { toolGroups, groupSummary, type ToolGroup } from "./tool-groups.ts";
import { ToolIndent } from "./tool-indent.ts";
import { NestedTree, type NativeTreeBody } from "./nested-tree.ts";
import { pushShellInputs, sameValues } from "./render-cache.ts";
export type { Pane } from "./content.ts";

/** Decorate one selected block without changing native text or mouse coordinates. */
class SearchHighlight implements Component {
  private cache?: { lines: string[]; result: string[]; width: number; query: string; hit: SearchHit; revision: number };

  constructor(
    private readonly component: Component,
    private readonly hit: () => SearchHit,
    private readonly query: () => string,
    private readonly theme: () => Theme,
    private readonly revision: () => number,
  ) {}

  render(width: number): string[] {
    const lines = this.component.render(width);
    const hit = this.hit();
    const query = this.query();
    const revision = this.revision();
    const cache = this.cache;
    if (cache && cache.lines === lines && cache.width === width && cache.query === query &&
      cache.hit === hit && cache.revision === revision) return cache.result;
    const clock = this.component instanceof CompactMessage ? this.component.searchClock() : undefined;
    const result = highlightSearchRows(lines, hit, this.theme(), clock);
    this.cache = { lines, result, width, query, hit, revision };
    return result;
  }

  invalidate(): void { this.cache = undefined; }
  handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
    return this.component.handleMouse?.(event);
  }
}

/** Scroll state of the panel showing a document, read before the panel's layout in a frame. */
export interface DocumentViewport { top: number; height: number; following: boolean }

/** Time per frame for measuring offscreen entries that are new, changed or stale. */
const LAZY_BUDGET_MS = 4;
/** Offscreen entries checked for native changes per frame, in rotation. */
const SWEEP_ENTRIES = 64;

/** One projected entry's rows, the components that produced them, and the inputs they depend on. */
interface Segment {
  components: Component[];
  heights: number[];
  lines: string[];
  width: number;
  epoch: number;
  /** Rows are blank placeholders with the entry's last known height. */
  estimate: boolean;
  visibleIn: boolean;
  toolRunIn: boolean;
  visibleOut: boolean;
  toolRunOut: boolean;
  /** Cheap fingerprint of native state, compared while the entry stays offscreen. */
  print: unknown[];
  /** First row and build of the last document this segment was part of. */
  start: number;
  build: number;
}

/** The last document: segment order with the row and child offsets of each segment. */
interface Built {
  order: Segment[];
  lines: string[][];
  components: Component[][];
  rows: number[];
  childRows: number[];
  document: string[];
  children: Component[];
}

const blankLines = (height: number): string[] => Array<string>(height).fill("");

/**
 * Project the live native component tree, not messages or renderer strings.
 * Assistant shells keep the native render method and original content components.
 * Their separate children and mouse layout leave the combined tree untouched.
 * Set invalidatesSource to false only when a shared root owns source invalidation.
 */
export class NativeDocument extends Container {
  private readonly stamped = new WeakMap<Component, CompactMessage>();
  private readonly toolRows = new WeakMap<Component, CompactTool>();
  private readonly nestedTrees = new WeakMap<Component, NestedTree>();
  private readonly groupRows = new WeakMap<Component, CompactTool>();
  private readonly indented = new WeakMap<Component, ToolIndent[]>();
  private readonly openGroups = new WeakSet<Component>();
  private readonly openTools = new WeakSet<Component>();
  private groups = new Map<Component, ToolGroup>();
  private present: (name: string) => ToolPresentation = name => ({ name, key: name });
  private searchTool?: Component;
  private readonly clockOwners = new WeakMap<Component, Component>();
  private readonly compactBlocks = new Map<Component, CompactMessage>();
  private readonly positions = new Map<Component, { row: number; lines: string[]; clock?: SearchClock; excerptRow?: number }>();
  private excerpt?: SearchHit;
  private searchAnchor?: SearchHit;
  private searchQuery = "";
  private highlightRevision = 0;
  private highlights = new WeakMap<Component, SearchHighlight>();
  private lastWidth = 1;
  private frameActive = false;
  private frameWidth?: number;
  private frameLines?: string[];
  private checked = false;
  private releasedFor?: readonly ContentEntry[];
  private disposed = false;
  // Virtualized history: one cached segment per projected entry, reused while it stays offscreen.
  private readonly segments = new Map<Component, Segment>();
  private built?: Built;
  private segmentsFor?: readonly ContentEntry[];
  private buildId = 0;
  private epoch = 0;
  private presentation: unknown[] = [];
  private invalidations = 0;
  private scrollShift = 0;
  private sweep = 0;
  /** Entries whose native nodes invalidated since they last rendered. */
  private readonly dirty = new Set<Component>();
  private viewport?: () => DocumentViewport | undefined;
  private requestRender?: () => void;
  private followUp = false;
  private readonly print: unknown[] = [];

  constructor(
    private readonly source: Container,
    private readonly pane: Pane,
    private readonly timestamps: TranscriptTimestamps,
    private readonly theme: () => Theme,
    private readonly timestampGutter: () => number,
    private readonly showTimestamps: () => boolean,
    private readonly interact: () => void = () => {},
    private readonly invalidatesSource = true,
    private readonly index = new NativeContentIndex(source),
    private readonly copy?: (text: string | undefined) => void,
    private readonly showCopy: () => boolean = () => true,
    private readonly compactTools: () => boolean = () => false,
    private readonly getTools: () => readonly ToolInfo[] = () => [],
    private readonly beforeExpand: () => void = () => {},
    private readonly buttonStyle: () => "icons" | "text" = () => "text",
    private readonly streaming?: { enabled(): boolean; delay(): number; changed(): void },
  ) {
    super();
    if (streaming) this.streamer = new ToolStreaming(() => streaming.delay(), () => streaming.changed());
  }
  private readonly streamer?: ToolStreaming;
  /** Calls Compact Activity still shows as full native cards. */
  private live(source: Component): boolean { return this.compactActive && this.streamer?.isLive(source) === true; }
  private compactActive = false;

  /**
   * Start a native frame; only repeated measurements within that frame may reuse routing.
   * Documents sharing one index pass `indexStarted` after the owner started the index's frame,
   * so the shared history is verified once per frame, not once per panel.
   */
  beginFrame(indexStarted = false): void {
    this.frameActive = true;
    this.frameWidth = undefined;
    if (!indexStarted) this.index.beginFrame();
    // Blocks are only added from the current entries, so an unchanged index has nothing to release.
    const entries = this.index.entries(this.pane);
    if (this.compactBlocks.size && entries !== this.releasedFor) {
      this.releasedFor = entries;
      const present = new Set(entries.map(entry => entry.source));
      for (const [component, block] of this.compactBlocks) if (!present.has(component)) {
        block.dispose();
        this.compactBlocks.delete(component);
      }
    }
    this.checked = false;
  }
  check(): void {
    if (this.frameActive && this.checked) return;
    const chat = this.source.children[2] as Container;
    if (!Array.isArray(chat?.children)) throw new Error("Pi's history document is not supported");
    // Existing blocks can change shape too; this cheap type check covers the whole history.
    for (const component of chat.children) this.timestamps.check(component);
    this.index.entries(this.pane);
    this.checked = true;
  }

  /**
   * Render only entries near the panel's viewport; other entries keep their rows from earlier frames.
   * Without a provider, or before the panel has a height, every entry renders each frame.
   */
  setViewport(provider: (() => DocumentViewport | undefined) | undefined, requestRender?: () => void): void {
    this.viewport = provider;
    this.requestRender = requestRender;
  }

  /** Rows entries above the viewport grew by since the last call; the panel adds them to keep its content in place. */
  takeScrollShift(): number {
    const shift = this.scrollShift;
    this.scrollShift = 0;
    return shift;
  }

  /** Render a segment again on its next frame, even offscreen. */
  private stale(source: Component | undefined): void {
    const segment = source && this.segments.get(source);
    if (segment) segment.epoch = -1;
  }

  /** Read full saved text from the current native branch, including collapsed blocks. */
  searchEntries(): SearchEntry[] {
    return this.index.entries(this.pane).flatMap(entry => {
      const saved = entry.search(this.lastWidth);
      return saved.text.trim() ? [{ source: entry.source, ...saved }] : [];
    });
  }

  /** Keyboard choices are built only when requested; callbacks recheck current ownership. */
  copyBlocks(): { label: string; copy: () => void }[] {
    return this.index.entries(this.pane).filter(entry => entry.compact).map((entry, index) => {
      const saved = entry.search(this.lastWidth);
      const preview = searchText(saved.text).replace(/\s+/g, " ").slice(0, 80);
      return { label: `${index + 1}. ${saved.label}: ${preview}`, copy: () => this.copyBlock(entry.source) };
    });
  }

  private copyBlock(source: Component): void {
    const entry = this.disposed ? undefined : this.index.entries(this.pane).find(entry => entry.source === source);
    this.copy?.(entry ? this.index.copy(entry, this.lastWidth) : undefined);
  }
  /** Reject hits whose native owner was removed by a branch change or history rebuild. */
  containsSearchHit(hit: SearchHit): boolean {
    return this.index.contains(hit.entry.source, this.pane);
  }
  /** Reveal one selected block without replacing its native renderer. */
  reveal(hit: SearchHit, query = ""): boolean {
    if (!this.containsSearchHit(hit)) return false;
    this.excerpt = undefined;
    if (this.searchAnchor?.entry.source !== hit.entry.source) this.highlights = new WeakMap();
    this.searchAnchor = hit;
    this.searchQuery = query;
    this.frameWidth = undefined;
    hit.entry.reveal?.();
    return true;
  }

  /** Clear search-only fragments, measurements and highlighting without invalidating native blocks. */
  clearSearch(): void {
    // Highlights and excerpts live in these entries' cached rows.
    this.stale(this.searchAnchor?.entry.source);
    this.stale(this.excerpt?.entry.source);
    this.searchTool = undefined;
    this.searchAnchor = undefined;
    this.excerpt = undefined;
    this.searchQuery = "";
    this.highlights = new WeakMap();
    this.frameWidth = undefined;
  }

  private highlighted(component: Component, fragment = false): Component {
    let decoration = this.highlights.get(component);
    if (!decoration) {
      decoration = new SearchHighlight(component, () => {
        const hit = this.searchAnchor!;
        return fragment ? { ...hit, line: 0, entry: { ...hit.entry, text: hit.text } } : hit;
      }, () => this.searchQuery, this.theme, () => this.highlightRevision);
      this.highlights.set(component, decoration);
    }
    return decoration;
  }

  /** Add a temporary fragment when the renderer does not display the saved matching text. */
  showSearchExcerpt(hit: SearchHit): void {
    this.excerpt = hit;
    this.frameWidth = undefined;
  }

  /** Locate the selected occurrence after native wrapping, padding and timestamp decoration. */
  searchRow(hit: SearchHit): number | undefined {
    // Async regex can complete between paints. Measure this document at its last
    // allocated width instead of assuming requestRender already emitted a frame.
    if (this.searchAnchor === hit && this.frameWidth === undefined) this.render(this.lastWidth);
    const block = this.positions.get(hit.entry.source);
    if (!block) return undefined;
    if (block.excerptRow !== undefined) return block.excerptRow;
    const found = searchHitRow(block.lines, hit, block.clock);
    return found === undefined ? undefined : block.row + found;
  }

  /** Stop native observers when the layout is detached or falls back. */
  dispose(): void {
    this.disposed = true;
    this.streamer?.dispose();
    for (const block of this.compactBlocks.values()) block.dispose();
    this.compactBlocks.clear();
    this.segments.clear();
    this.dirty.clear();
    this.built = undefined;
    this.frameWidth = undefined;
    this.frameLines = undefined;
  }
  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.type === "wheel" || (event.type === "press" && event.button === "left")) this.interact();
    const built = this.built;
    if (!built || event.y < 0) return undefined;
    // Find the entry under the pointer, then route like a container of that entry's components.
    let low = 0;
    let high = built.order.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (built.rows[middle] <= event.y) low = middle; else high = middle - 1;
    }
    const segment = built.order[low];
    const row = event.y - (built.rows[low] ?? 0);
    if (!segment || segment.estimate || row >= segment.lines.length) return undefined;
    const entry = {
      children: segment.components,
      mouseLayout: { width: event.width, children: segment.components.map((component, index) => ({ component, height: segment.heights[index] })) },
    };
    return Container.prototype.handleMouse.call(entry, { ...event, y: row, height: segment.lines.length });
  }
  private toolOpen(source: Component): boolean {
    return this.openTools.has(source) || this.searchTool === source;
  }
  private groupOpen(group: ToolGroup): boolean {
    return this.openGroups.has(group.calls[0].source) || (this.searchTool !== undefined && this.groups.get(this.searchTool) === group);
  }
  private compactRow(entry: ContentEntry): CompactTool {
    let row = this.toolRows.get(entry.source);
    if (!row) {
      row = new CompactTool(() => {
        const summary = entry.tool!();
        return { ...summary, name: this.present(summary.name).name };
      }, this.theme, {
        clock: () => this.showTimestamps() ? this.timestamps.label(entry.source) : "",
        gutter: this.timestampGutter,
        expanded: () => this.toolOpen(entry.source),
        toggle: () => {
          if (!this.index.contains(entry.source, this.pane)) return;
          this.beforeExpand();
          if (this.toolOpen(entry.source)) { this.openTools.delete(entry.source); if (this.searchTool === entry.source) this.clearSearch(); }
          else { this.openTools.add(entry.source); entry.search(this.lastWidth).reveal?.(); }
          this.frameWidth = undefined;
        },
      });
      this.toolRows.set(entry.source, row);
    }
    return row;
  }
  private indent(component: Component, depth: number, body = false): Component {
    if (!depth) return component;
    let levels = this.indented.get(component);
    if (!levels) { levels = []; this.indented.set(component, levels); }
    const inset = depth * 2 + (body ? 1 : 0);
    return levels[inset] ??= new ToolIndent(component, depth, body, this.theme);
  }
  private groupRow(group: ToolGroup): CompactTool {
    const source = group.calls[0].source;
    let row = this.groupRows.get(source);
    if (!row) {
      row = new CompactTool(() => groupSummary(this.groups.get(source)!), this.theme, {
        count: () => this.groups.get(source)!.calls.length,
        clock: () => this.showTimestamps() ? this.timestamps.label(source) : "",
        gutter: this.timestampGutter,
        expanded: () => this.groupOpen(this.groups.get(source)!),
        toggle: () => {
          const current = this.groups.get(source);
          if (!current || !this.index.contains(source, this.pane)) return;
          this.beforeExpand();
          if (this.groupOpen(current)) { this.openGroups.delete(source); if (current.calls.some(call => call.source === this.searchTool)) this.clearSearch(); }
          else this.openGroups.add(source);
          this.frameWidth = undefined;
        },
      });
      this.groupRows.set(source, row);
    }
    return row;
  }
  private nativeBlock(entry: ContentEntry): CompactMessage {
    const component = entry.source;
    const routed = entry.component;
    this.clockOwners.set(component, entry.owner);
    let stamped = this.stamped.get(routed);
    if (!stamped) {
      stamped = new CompactMessage(routed, () => this.timestamps.label(this.clockOwners.get(component) ?? component),
        this.theme, this.timestampGutter, () => this.showTimestamps() && !(this.pane === "activity" && this.compactTools() && entry.kind === "tool" && !this.live(entry.owner)),
        this.copy ? () => this.copyBlock(component) : undefined, this.showCopy, this.buttonStyle, () => {
          // Nested panels render inside their owner's segment.
          this.dirty.add(component).add(entry.owner);
        });
      this.stamped.set(routed, stamped);
    }
    this.compactBlocks.set(component, stamped);
    return stamped;
  }
  private searchExcerpt(): Component {
    return this.highlighted(new Text(this.theme().fg("accent", "Search match: ") + searchText(this.excerpt!.text), 1, 0), true);
  }
  private treeBody(entry: ContentEntry): NativeTreeBody {
    const block = this.nativeBlock(entry);
    return { entry, component: this.searchAnchor?.entry.source === entry.source && !this.excerpt ? this.highlighted(block) : block,
      clock: () => block.searchClock(),
      excerpt: this.excerpt?.entry.source === entry.source && entry.owner !== entry.source ? this.searchExcerpt() : undefined };
  }
  override render(width: number): string[] {
    if (this.frameActive && this.frameWidth === width && this.frameLines) return this.frameLines;
    const chat = this.source.children[2] as Container;
    this.timestamps.prepare(chat.children);
    this.lastWidth = width;
    this.positions.clear();
    if (this.excerpt && !this.index.contains(this.excerpt.entry.source, this.pane)) this.excerpt = undefined;
    if (this.searchAnchor && !this.index.contains(this.searchAnchor.entry.source, this.pane)) this.searchAnchor = undefined;
    const locateMatch = this.searchAnchor !== undefined || this.excerpt !== undefined;
    let row = 0;
    let visibleBlock = false;
    let toolRun = false;
    const compactTools = this.pane === "activity" && this.compactTools();
    this.present = toolPresentations(compactTools ? this.getTools() : []);
    this.compactActive = compactTools && this.streaming?.enabled() === true;
    if (this.compactActive) this.streamer!.observe(this.index.entries());
    else this.streamer?.clear();
    const groups = compactTools ? toolGroups(this.index.entries(), this.present, source => this.live(source)) : new Map<Component, ToolGroup>();
    // Carry visible expansion through state-driven splits and merges, without
    // reopening explicitly collapsed runs. Read the old state before adding heads.
    const opening: Component[] = [];
    for (const [source, group] of groups) {
      if (group.calls[0].source !== source || group.calls.length < 2 || this.openGroups.has(source)) continue;
      if (group.calls.some(call => {
        const previous = this.groups.get(call.source);
        return previous && (previous.calls.length > 1 ? this.openGroups.has(previous.calls[0].source) : this.openTools.has(call.source));
      })) opening.push(source);
    }
    if (compactTools) for (const [source, previous] of this.groups) {
      const current = groups.get(source);
      if (previous.calls[0].source === source && previous.calls.length > 1 &&
        (!current || current.calls.length < 2 || current.calls[0].source !== source)) this.openGroups.delete(source);
    }
    for (const source of opening) this.openGroups.add(source);
    this.groups = groups;
    const searched = this.searchAnchor ? this.index.entries(this.pane).find(entry => entry.source === this.searchAnchor!.entry.source) : undefined;
    this.searchTool = searched?.owner;
    const entries = this.index.entries(this.pane);
    const trees = new Map<Component, NestedTree>();
    if (this.pane === "activity") for (const entry of entries) {
      if (!entry.tool) continue;
      const id = Reflect.get(entry.source, "toolCallId") as string | undefined;
      if (!id || (!this.index.nested.entries(id).length && !this.index.nested.isIncomplete(id))) continue;
      let tree = this.nestedTrees.get(entry.source);
      if (!tree) {
        tree = new NestedTree(id, this.index.nested, this.theme, name => this.present(name), () => this.compactTools() && !this.live(entry.source), () => {
          this.beforeExpand(); if (this.searchAnchor) this.clearSearch(); this.frameWidth = undefined;
        }, () => {
          const clock = this.showTimestamps() && this.compactTools() ? this.timestamps.label(entry.source) : "";
          return clock ? clock.length + 1 : 0;
        });
        this.nestedTrees.set(entry.source, tree);
      }
      trees.set(entry.source, tree);
    }
    const view = locateMatch ? undefined : this.viewport?.();
    // The first frame and search measure every entry; later frames reuse offscreen rows.
    const virtual = view !== undefined && view.height > 0 && this.built !== undefined;
    const presentation = [this.theme(), compactTools, this.compactActive, this.showTimestamps(), this.showCopy(), this.buttonStyle(),
      this.timestampGutter(), this.invalidations];
    if (!sameValues(presentation, this.presentation)) {
      this.presentation = presentation;
      this.epoch++;
    }
    const build = ++this.buildId;
    const started = performance.now();
    // Render the viewport plus half a viewport on each side; scrolling moves the window before layout.
    const margin = virtual ? Math.ceil(view.height / 2) : 0;
    // A following panel shows the end; find the entries of its last rows from cached heights.
    let tail = 0;
    if (virtual && view.following) {
      let rows = 0;
      tail = entries.length;
      while (tail > 0 && rows < view.height + margin) rows += this.segments.get(entries[--tail].source)?.lines.length ?? 1;
    }
    const sweep = entries.length ? this.sweep % entries.length : 0;
    this.sweep = sweep + SWEEP_ENTRIES;
    const top = virtual && !view.following ? view.top : 0;
    let shift = 0;
    let pending = false;
    const order: Segment[] = [];
    const renderEntry = (entry: ContentEntry, compactTool: boolean, tree: NestedTree | undefined): Segment => {
      const component = entry.source;
      const routed = entry.component;
      const result: Component[] = [];
      const visibleIn = visibleBlock;
      const toolRunIn = toolRun;
      let clock: SearchClock | undefined;
      let nativeBody = true;
      let bodyDepth = 0;
      if (compactTool) {
        const group = this.groups.get(entry.owner);
        const grouped = group !== undefined && group.calls.length > 1;
        bodyDepth = grouped ? 2 : 1;
        const members = !grouped || this.groupOpen(group);
        if (entry.tool) {
          if (visibleBlock && !toolRun) result.push(new Spacer(1));
          if (grouped && group.calls[0].source === component) result.push(this.groupRow(group));
          if (members) result.push(this.indent(this.compactRow(entry), grouped ? 1 : 0));
          toolRun = true;
          visibleBlock = true;
        }
        nativeBody = members && this.toolOpen(entry.owner);
      }
      const contentStart = result.length;
      const bodyWidth = Math.max(0, width - (bodyDepth ? bodyDepth * 2 + 1 : 0));
      if (nativeBody && tree) {
        const panels = entries.filter(panel => panel.owner === component && panel.source !== component);
        tree.setBodies(this.treeBody(entry), panels.map(panel => this.treeBody(panel)), this.searchAnchor?.entry.source);
        result.push(tree);
        visibleBlock = true;
      } else if (nativeBody && !entry.compact) {
        toolRun = false;
        result.push(...entry.spacing, routed);
      } else if (nativeBody) {
        if (!compactTool) toolRun = false;
        const stamped = this.nativeBlock(entry);
        visibleBlock = stamped.prepare(bodyWidth, compactTool ? false : visibleBlock) || visibleBlock;
        result.push(stamped);
        clock = stamped.searchClock();
      }
      if (!tree && this.searchAnchor?.entry.source === component && !this.excerpt && result.length > 0) {
        const last = result.length - 1;
        result[last] = this.highlighted(result[last]);
      }
      if (locateMatch) {
        const prefix = result.slice(0, contentStart).flatMap(child => child.render(width));
        const lines = [...prefix, ...result.slice(contentStart).flatMap(child => child.render(bodyWidth))];
        let excerptRow: number | undefined;
        if (this.excerpt?.entry.source === component) {
          if (!lines.length && visibleIn) {
            result.push(new Spacer(1));
            lines.push("");
          }
          excerptRow = row + lines.length;
          const decorated = this.searchExcerpt();
          result.push(decorated);
          lines.push(...decorated.render(bodyWidth));
          visibleBlock = true;
        }
        // Compact controls/clocks are not saved text. Search the original body only.
        const prefixRows = prefix.length;
        if (tree && nativeBody) {
          for (const [source, position] of tree.positions) this.positions.set(source, {
            ...position, row: row + prefixRows + position.row,
            excerptRow: position.excerptRow === undefined ? undefined : row + prefixRows + position.excerptRow,
          });
          if (excerptRow !== undefined) this.positions.set(component, { row, lines: [], excerptRow });
        } else this.positions.set(component, { row: row + prefixRows, lines: lines.slice(prefixRows), clock, excerptRow });
      }
      for (let child = contentStart; child < result.length; child++) result[child] = this.indent(result[child], bodyDepth, true);
      const heights: number[] = [];
      // Copy rows: native renderers may reuse and later mutate their row arrays.
      const lines: string[] = [];
      for (const child of result) {
        const childLines = child.render(width);
        heights.push(childLines.length);
        for (const line of childLines) lines.push(line);
      }
      const print: unknown[] = [];
      this.fingerprint(entry, compactTool, tree, print);
      let segment = this.segments.get(component);
      if (!segment) {
        segment = { components: result, heights, lines, width, epoch: this.epoch, estimate: false, visibleIn, toolRunIn,
          visibleOut: visibleBlock, toolRunOut: toolRun, print, start: row, build };
        this.segments.set(component, segment);
        return segment;
      }
      // Keep unchanged arrays, so the document can reuse the rows before the first changed entry.
      if (segment.estimate || !sameValues(segment.lines, lines)) segment.lines = lines;
      if (!sameValues(segment.components, result)) segment.components = result;
      Object.assign(segment, { heights, width, epoch: this.epoch, estimate: false, visibleIn, toolRunIn,
        visibleOut: visibleBlock, toolRunOut: toolRun, print });
      return segment;
    };
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.owner !== entry.source && trees.has(entry.owner)) continue;
      const component = entry.source;
      const compactTool = compactTools && entry.kind === "tool" && !this.live(entry.owner);
      const tree = trees.get(component);
      let segment = this.segments.get(component);
      const previous = segment?.build === build - 1 ? { start: segment.start, height: segment.lines.length } : undefined;
      let render = !virtual;
      if (virtual) {
        const height = segment?.lines.length ?? 1;
        // Rows near the viewport always render; offscreen entries render only when changed, within a budget.
        const hot = view.following ? index >= tail :
          row + height > top + shift - margin && row < top + shift + view.height + margin;
        if (hot) render = true;
        else {
          const measured = segment !== undefined && !segment.estimate && segment.width === width && segment.epoch === this.epoch &&
            segment.visibleIn === visibleBlock && segment.toolRunIn === toolRun;
          // Offscreen changes are invisible until the entry nears the viewport, where it renders anyway.
          // Check a rotating slice per frame so heights converge without reading every entry each frame.
          const swept = this.dirty.delete(component) ||
            (index >= sweep && index < sweep + SWEEP_ENTRIES) || index + entries.length < sweep + SWEEP_ENTRIES;
          if (measured && swept) this.fingerprint(entry, compactTool, tree, this.print);
          if (!measured || (swept && !sameValues(segment!.print, this.print))) {
            if (performance.now() < started + LAZY_BUDGET_MS) render = true;
            // Native changes request their own frames; only unmeasured layout needs follow-up frames.
            // This also keeps an unstable fingerprint from scheduling frames forever.
            else if (!measured) pending = true;
            else this.dirty.add(component);
          }
        }
      }
      if (render) {
        this.dirty.delete(component);
        segment = renderEntry(entry, compactTool, tree);
      }
      else {
        if (!segment) {
          segment = { components: [], heights: [], lines: blankLines(1), width, epoch: -1, estimate: true, visibleIn: visibleBlock,
            toolRunIn: toolRun, visibleOut: visibleBlock, toolRunOut: toolRun, print: [], start: row, build };
          this.segments.set(component, segment);
        } else if (segment.width !== width && !segment.estimate) {
          // Rows at another width would overflow the panel; keep only the height until measured.
          Object.assign(segment, { lines: blankLines(segment.lines.length), components: [], heights: [], estimate: true });
        }
        // An entry without rows passes the separator state through.
        if (segment.lines.length) {
          visibleBlock = segment.visibleOut;
          toolRun = segment.toolRunOut;
        }
      }
      // Entries above the viewport that changed height move the visible rows; the panel scrolls by the difference.
      if (virtual && !view.following && previous && previous.start + previous.height <= top) shift += segment.lines.length - previous.height;
      segment.start = row;
      segment.build = build;
      order.push(segment);
      row += segment.lines.length;
    }
    const built = this.document(order);
    if (entries !== this.segmentsFor) {
      this.segmentsFor = entries;
      for (const [source, segment] of this.segments) if (segment.build !== build) this.segments.delete(source);
      for (const source of this.dirty) if (!this.segments.has(source)) this.dirty.delete(source);
    }
    if (virtual && !view.following) this.scrollShift += shift;
    let lines = built.document;
    let children = built.children;
    // Native follow-end guidance overlays the bottom row. Keep the selected last line above it.
    if (this.searchAnchor) {
      lines = [...lines, ""];
      children = [...children, new Spacer(1)];
    }
    this.children = children;
    this.frameWidth = width;
    this.frameLines = lines;
    if (pending) this.scheduleFollowUp();
    return lines;
  }

  /** Join segment rows, reusing the previous document up to the first changed segment. */
  private document(order: Segment[]): Built {
    const built = this.built;
    let same = 0;
    if (built) {
      const limit = Math.min(order.length, built.order.length);
      while (same < limit && order[same] === built.order[same] && order[same].lines === built.lines[same] &&
        order[same].components === built.components[same]) same++;
      if (same === order.length && same === built.order.length) return built;
    }
    const rowEnd = !built || same === 0 ? 0 : same < built.order.length ? built.rows[same] : built.document.length;
    const childEnd = !built || same === 0 ? 0 : same < built.order.length ? built.childRows[same] : built.children.length;
    const next: Built = {
      order, lines: order.map(segment => segment.lines), components: order.map(segment => segment.components),
      rows: built ? built.rows.slice(0, same) : [], childRows: built ? built.childRows.slice(0, same) : [],
      document: built ? built.document.slice(0, rowEnd) : [], children: built ? built.children.slice(0, childEnd) : [],
    };
    for (let index = same; index < order.length; index++) {
      const segment = order[index];
      next.rows.push(next.document.length);
      next.childRows.push(next.children.length);
      for (const line of segment.lines) next.document.push(line);
      for (const component of segment.components) next.children.push(component);
    }
    this.built = next;
    return next;
  }

  /** Native state an offscreen entry's rows depend on, read without rendering it. */
  private fingerprint(entry: ContentEntry, compactTool: boolean, tree: NestedTree | undefined, out: unknown[]): void {
    out.length = 0;
    const routed = entry.component;
    pushShellInputs(routed, out);
    const children = (routed as Partial<Container>).children;
    const group = compactTool ? this.groups.get(entry.owner) : undefined;
    out.push(children, (children?.[0] as Partial<Container> | undefined)?.children, entry.spacing.length,
      this.stamped.get(routed)?.revision, compactTool, this.toolOpen(entry.owner),
      group?.calls[0].source, group?.calls.length, group && group.calls.length > 1 ? this.groupOpen(group) : undefined,
      tree ? this.index.nested.revision : undefined);
  }

  /** Measure the remaining offscreen entries in later frames. */
  private scheduleFollowUp(): void {
    if (this.followUp || !this.requestRender || this.disposed) return;
    this.followUp = true;
    setImmediate(() => {
      this.followUp = false;
      if (!this.disposed) this.requestRender?.();
    });
  }

  override invalidate(): void {
    this.highlightRevision++;
    this.invalidations++;
    this.frameWidth = undefined;
    this.checked = false;
    // Theme changes must rebuild native parents, including collapsed thinking text.
    if (this.invalidatesSource) this.source.invalidate();
  }
}
