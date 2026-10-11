import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings, HStack, Input, matchesKey, MouseRegion, stripTerminalSequences, Text, truncateToWidth, visibleWidth, VStack,
  type Component, type TUI,
} from "@earendil-works/pi-tui";

import { matchSearchLines, type LineMatch, type SearchRange } from "./search-matcher.js";
const NATIVE_SEARCH = "tui.altScreen.search";

/** Reserve Ctrl+F in split mode without changing any saved keyboard settings. */
export class PanelSearchShortcut {
  private restore?: () => void;

  sync(enabled: boolean): void {
    if (!enabled) {
      this.dispose();
      return;
    }
    const manager = getKeybindings();
    const keys = manager.getKeys(NATIVE_SEARCH);
    if (!keys.includes("ctrl+f")) return;
    // Pi reloads keybindings after session_start; renew the reservation on the next render.
    this.dispose();
    const saved = manager.getUserBindings()[NATIVE_SEARCH];
    const replacement = keys.filter(key => key !== "ctrl+f");
    manager.setUserBindings({ ...manager.getUserBindings(), [NATIVE_SEARCH]: replacement });
    this.restore = () => {
      if (JSON.stringify(manager.getUserBindings()[NATIVE_SEARCH]) !== JSON.stringify(replacement)) return;
      const bindings = { ...manager.getUserBindings() };
      if (saved === undefined) delete bindings[NATIVE_SEARCH];
      else bindings[NATIVE_SEARCH] = saved;
      manager.setUserBindings(bindings);
    };
  }

  dispose(): void {
    this.restore?.();
    this.restore = undefined;
  }
}

/** Saved text attached to an exact native block in the currently mounted branch. */
export interface SearchEntry {
  source: Component;
  label: string;
  text: string;
  reveal?: () => void;
}

/** One matching line, retaining its block identity and occurrence within that block. */
export interface SearchHit {
  entry: SearchEntry;
  line: number;
  text: string;
  /** Positive matching spans in this saved line, before wrapping and clock decoration. */
  ranges?: SearchRange[];
}

/** Read searchable text without terminal control sequences. */
export function searchText(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "  ");
}

function candidates(entries: SearchEntry[]): SearchHit[] {
  return entries.slice().reverse().flatMap(entry => searchText(entry.text).split("\n").flatMap((text, line) =>
    text.trim() ? [{ entry, line, text: text.trim() }] : []));
}

class SearchInput extends Input {
  constructor(private readonly changed: () => void, private readonly previous: () => void) {
    super({ prompt: "Search: " });
  }

  /** Native overlays may refocus this removed Input even after its layout is gone. */
  retire(restoreFocus: () => void): void {
    let focused = this.focused;
    Object.defineProperty(this, "focused", {
      configurable: true, enumerable: true,
      get: () => focused,
      set: (value: boolean) => {
        focused = value;
        if (value) queueMicrotask(restoreFocus);
      },
    });
  }
  override handleInput(data: string): void {
    if (matchesKey(data, "shift+enter")) {
      this.previous();
      return;
    }
    const before = this.getValue();
    super.handleInput(data);
    if (this.getValue() !== before) this.changed();
  }
}

class SearchControls extends HStack {
  constructor(private readonly count: () => string) { super([], { gap: 1 }); }
  override render(width: number): string[] {
    // Keep query space usable even in the smallest panel.
    this.entries[1].basis = Math.min(this.count().length,
      Math.max(3, width - 19));
    return super.render(width);
  }
}

/** Height reserved for the search field and its closed border. */
export const PANEL_SEARCH_ROWS = 3;

/** A framed literal, Boolean or explicit regex search inside a panel. */
export class PanelSearch extends VStack {
  readonly input: SearchInput;
  private readonly controls = new SearchControls(() => this.count());
  private index?: SearchHit[];
  private hits: SearchHit[] = [];
  private selected = 0;
  private dirty = true;
  private query = "";
  private width?: number;
  private pending?: AbortController;
  private generation = 0;
  private error?: string;

  private count(): string {
    return this.error ? "!" : this.pending ? "…" : `${this.hits.length ? this.selected + 1 : 0}/${this.hits.length}`;
  }

  constructor(
    private readonly savedEntries: () => SearchEntry[],
    private readonly tui: TUI,
    private readonly theme: () => Theme,
    private readonly match: (hit: SearchHit | undefined, query: string) => void,
    private readonly close: () => void,
  ) {
    super();
    this.input = new SearchInput(() => this.refresh(true), () => this.step(-1));
    this.input.onEscape = close;
    this.input.onSubmit = () => this.step(1);
    const button = (label: string, action: () => void): Component => new MouseRegion({
      render: width => new Text(this.theme().fg("accent", label), 0, 0).render(width),
      invalidate() {},
    }, event => {
      if (event.button !== "left") return;
      if (event.type === "press") return { capture: true };
      if (event.type === "click") {
        action();
        return { handled: true, render: true };
      }
      return { handled: true };
    });
    this.controls.addChild(this.input, { basis: 0, grow: 1, minSize: 10 });
    this.controls.addChild({
      render: width => new Text(this.theme().fg(this.hits.length ? "accent" : "dim",
        truncateToWidth(this.count(), width, "…")), 0, 0).render(width),
      invalidate() {},
    }, { basis: 7, shrink: 0 });
    this.controls.addChild(button("[↓]", () => { this.step(1); this.focus(); }), { basis: 3, shrink: 0 });
    this.controls.addChild(button("[×]", close), { basis: 3, shrink: 0 });
    const border = (render: (width: number) => string): Component => ({
      render: width => [this.theme().fg("border", render(width))], invalidate() {},
    });
    this.addChild(border(width => {
      const message = this.error ? truncateToWidth(" " + searchText(this.error.replace(/[\r\n]+/g, " ")) + " ", Math.max(0, width - 2), "…") : "";
      return "┌" + message + "─".repeat(Math.max(0, width - 2 - visibleWidth(message))) + "┐";
    }), { basis: 1, shrink: 0 });
    this.addChild(new HStack([
      { component: border(() => "│"), basis: 1, shrink: 0 },
      { component: this.controls, basis: 0, grow: 1, minSize: 1 },
      { component: border(() => "│"), basis: 1, shrink: 0 },
    ]), { basis: 1, shrink: 0 });
    this.addChild(border(width => "└" + "─".repeat(Math.max(0, width - 2)) + "┘"), { basis: 1, shrink: 0 });
  }

  /** Focus the existing native Input without opening another interface. */
  focus(): void { this.tui.setFocus(this.input); }

  /** Retire focus ownership without taking input away from an unrelated overlay. */
  retire(restoreFocus: () => void): void {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
    this.input.retire(restoreFocus);
  }
  /** Keep the selected result visible after a viewport height change. */
  reposition(): void {
    const hit = this.hits[this.selected];
    if (hit) this.match(hit, this.query);
  }
  /** Defer indexing until an open, non-empty search actually needs updated history. */
  markDirty(): void {
    this.dirty = true;
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
  }

  private refresh(queryChanged = false): void {
    const query = this.input.getValue();
    if (!queryChanged && !this.dirty) return;
    const old = this.hits[this.selected];
    const generation = ++this.generation;
    this.pending?.abort();
    this.pending = undefined;
    this.error = undefined;
    if (this.dirty) this.index = undefined;
    this.dirty = false;
    this.query = query;
    const index = query.trim() ? this.index ??= candidates(this.savedEntries()) : [];
    const apply = (matches: LineMatch[]): void => {
      if (this.generation !== generation) return;
      this.pending = undefined;
      this.hits = matches.map(hit => ({ ...index[hit.index], ranges: hit.ranges }));
      const retained = !queryChanged && old ? this.hits.findIndex(hit => hit.entry.source === old.entry.source &&
        hit.entry.label === old.entry.label && hit.line === old.line && hit.text === old.text) : -1;
      this.selected = Math.max(0, retained);
      if (queryChanged || retained < 0 || old?.entry.text !== this.hits[this.selected]?.entry.text) {
        this.match(this.hits[this.selected], query);
      }
      this.tui.requestRender();
    };
    const failed = (error: unknown): void => {
      if (this.generation !== generation) return;
      this.pending = undefined;
      this.hits = [];
      this.error = (error instanceof Error ? error.message : String(error))
        .replace(/^Invalid Boolean search query at column (\d+): /, "Column $1: ");
      this.match(undefined, query);
      this.tui.requestRender();
    };
    try {
      const controller = new AbortController();
      const result = matchSearchLines(index.map(hit => hit.text), query, controller.signal);
      if (Array.isArray(result)) apply(result);
      else {
        this.pending = controller;
        if (queryChanged) {
          this.hits = [];
          this.match(undefined, query);
        }
        this.tui.requestRender();
        void result.then(apply, failed);
      }
    } catch (error) { failed(error); }
  }

  private step(direction: number): void {
    this.refresh();
    if (this.pending || !this.hits.length) return;
    this.selected = (this.selected + direction + this.hits.length) % this.hits.length;
    this.match(this.hits[this.selected], this.query);
    this.tui.requestRender();
  }

  override render(width: number): string[] {
    this.refresh();
    if (this.width !== width && this.width !== undefined && this.hits.length) {
      this.match(this.hits[this.selected], this.query);
    }
    this.width = width;
    return super.render(width);
  }
}
