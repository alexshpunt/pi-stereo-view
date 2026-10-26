import type { Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { searchText, type SearchEntry, type SearchHit } from "./search.js";
import { highlightSearchRows, searchHitRow, type SearchClock } from "./search-highlight.js";
import { CompactMessage, type TranscriptTimestamps } from "./timestamps.js";
import { NativeContentIndex, type ContentEntry, type Pane } from "./content.js";
import { CompactTool } from "./compact-tools.js";
import { toolPresentations, type ToolPresentation } from "./tool-presentation.js";
import { toolGroups, groupSummary, type ToolGroup } from "./tool-groups.js";
export type { Pane } from "./content.js";

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

/** Keep hierarchy guides outside native rendering, search and pointer coordinates. */
class ToolIndent extends Container {
  private readonly prefix: string;

  constructor(component: Component, depth: number, body: boolean, private readonly theme: () => Theme) {
    super();
    this.addChild(component);
    this.prefix = " │".repeat(depth) + (body ? " " : "");
  }

  override render(width: number): string[] {
    const inset = Math.min(width, this.prefix.length);
    const prefix = this.theme().fg("dim", this.prefix.slice(0, inset));
    return super.render(Math.max(0, width - inset)).map(line => truncateToWidth(prefix + line, width, ""));
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const inset = Math.min(event.width, this.prefix.length);
    if (event.x < inset) return undefined;
    return super.handleMouse({ ...event, x: event.x - inset, width: Math.max(0, event.width - inset) });
  }
}
/**
 * Project the live native component tree, not messages or renderer strings.
 * Assistant shells keep the native render method and original content components.
 * Their separate children and mouse layout leave the combined tree untouched.
 * Set invalidatesSource to false only when a shared root owns source invalidation.
 */
export class NativeDocument extends Container {
  private readonly stamped = new WeakMap<Component, CompactMessage>();
  private readonly toolRows = new WeakMap<Component, CompactTool>();
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
  private disposed = false;

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
  ) {
    super();
  }

  /** Start a native frame; only repeated measurements within that frame may reuse routing. */
  beginFrame(): void {
    this.frameActive = true;
    this.frameWidth = undefined;
    if (this.compactBlocks.size) {
      const present = new Set((this.source.children[2] as Container | undefined)?.children ?? []);
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
    for (const component of chat.children) {
      this.timestamps.check(component);
    }
    this.index.entries(this.pane);
    this.checked = true;
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
    for (const block of this.compactBlocks.values()) block.dispose();
    this.compactBlocks.clear();
    this.frameWidth = undefined;
    this.frameLines = undefined;
  }
  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.type === "wheel" || (event.type === "press" && event.button === "left")) this.interact();
    return super.handleMouse(event);
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
  override render(width: number): string[] {
    if (this.frameActive && this.frameWidth === width && this.frameLines) return this.frameLines;
    const chat = this.source.children[2] as Container;
    this.timestamps.prepare(chat.children);
    this.lastWidth = width;
    this.positions.clear();
    if (this.excerpt && !this.index.contains(this.excerpt.entry.source, this.pane)) this.excerpt = undefined;
    if (this.searchAnchor && !this.index.contains(this.searchAnchor.entry.source, this.pane)) this.searchAnchor = undefined;
    const result: Component[] = [];
    const locateMatch = this.searchAnchor !== undefined || this.excerpt !== undefined;
    let row = 0;
    let visibleBlock = false;
    let toolRun = false;
    const compactTools = this.pane === "activity" && this.compactTools();
    this.present = toolPresentations(compactTools ? this.getTools() : []);
    const groups = compactTools ? toolGroups(this.index.entries(), this.present) : new Map<Component, ToolGroup>();
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
    this.searchTool = this.searchAnchor ? this.index.entries(this.pane).find(entry => entry.source === this.searchAnchor!.entry.source)?.owner : undefined;
    for (const entry of this.index.entries(this.pane)) {
      const component = entry.source;
      const routed = entry.component;
      this.clockOwners.set(component, entry.owner);
      const start = result.length;
      const wasVisible = visibleBlock;
      let clock: SearchClock | undefined;
      let nativeBody = true;
      let bodyDepth = 0;
      const compactTool = compactTools && entry.kind === "tool";
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
      if (nativeBody && !entry.compact) {
        toolRun = false;
        result.push(...entry.spacing, routed);
      } else if (nativeBody) {
        if (!compactTool) toolRun = false;
        let stamped = this.stamped.get(routed);
        if (!stamped) {
          stamped = new CompactMessage(routed, () => this.timestamps.label(this.clockOwners.get(component) ?? component),
            this.theme, this.timestampGutter, () => this.showTimestamps() && !(this.pane === "activity" && this.compactTools() && entry.kind === "tool"),
            this.copy ? () => this.copyBlock(component) : undefined, this.showCopy);
          this.stamped.set(routed, stamped);
        }
        this.compactBlocks.set(component, stamped);
        visibleBlock = stamped.prepare(bodyWidth, compactTool ? false : visibleBlock) || visibleBlock;
        result.push(stamped);
        clock = stamped.searchClock();
      }
      if (this.searchAnchor?.entry.source === component && !this.excerpt && result.length > start) {
        const last = result.length - 1;
        result[last] = this.highlighted(result[last]);
      }
      if (locateMatch) {
        const prefix = result.slice(start, contentStart).flatMap(child => child.render(width));
        const lines = [...prefix, ...result.slice(contentStart).flatMap(child => child.render(bodyWidth))];
        let excerptRow: number | undefined;
        if (this.excerpt?.entry.source === component) {
          const fragment = new Text(this.theme().fg("accent", "Search match: ") + searchText(this.excerpt.text), 1, 0);
          if (!lines.length && wasVisible) {
            result.push(new Spacer(1));
            lines.push("");
          }
          excerptRow = row + lines.length;
          const decorated = this.highlighted(fragment, true);
          result.push(decorated);
          lines.push(...decorated.render(bodyWidth));
          visibleBlock = true;
        }
        // Compact controls/clocks are not saved text. Search the original body only.
        const prefixRows = prefix.length;
        this.positions.set(component, { row: row + prefixRows, lines: lines.slice(prefixRows), clock, excerptRow });
        row += lines.length;
      }
      for (let child = contentStart; child < result.length; child++) result[child] = this.indent(result[child], bodyDepth, true);
    }
    // Native follow-end guidance overlays the bottom row. Keep the selected last line above it.
    if (this.searchAnchor) result.push(new Spacer(1));
    this.children = result;
    this.frameWidth = width;
    this.frameLines = super.render(width);
    return this.frameLines;
  }

  override invalidate(): void {
    this.highlightRevision++;
    this.frameWidth = undefined;
    this.checked = false;
    // Theme changes must rebuild native parents, including collapsed thinking text.
    if (this.invalidatesSource) this.source.invalidate();
  }
}
