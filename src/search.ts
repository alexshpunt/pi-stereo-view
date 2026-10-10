import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter, getKeybindings, HStack, Input, matchesKey, MouseRegion, stripTerminalSequences, Text, truncateToWidth,
  type Component, type TUI,
} from "@earendil-works/pi-tui";

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

/** A one-row live fuzzy search mounted inside a panel, never over the editor. */
export class PanelSearch extends HStack {
  readonly input: Input;
  private index?: SearchHit[];
  private hits: SearchHit[] = [];
  private selected = 0;
  private dirty = true;
  private query = "";
  private width?: number;

  constructor(
    private readonly savedEntries: () => SearchEntry[],
    private readonly tui: TUI,
    private readonly theme: () => Theme,
    private readonly match: (hit: SearchHit | undefined, query: string) => void,
    private readonly close: () => void,
  ) {
    super([], { gap: 1 });
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
    this.addChild(this.input, { basis: 0, grow: 1, minSize: 10 });
    this.addChild({
      render: width => new Text(this.theme().fg(this.hits.length ? "accent" : "dim",
        truncateToWidth(`${this.hits.length ? this.selected + 1 : 0}/${this.hits.length}`, width, "…")), 0, 0).render(width),
      invalidate() {},
    }, { basis: 7, shrink: 0 });
    this.addChild(button("[↓]", () => { this.step(1); this.focus(); }), { basis: 3, shrink: 0 });
    this.addChild(button("[×]", close), { basis: 3, shrink: 0 });
  }

  /** Focus the existing native Input without opening another interface. */
  focus(): void { this.tui.setFocus(this.input); }

  /** Keep the selected result visible after a viewport height change. */
  reposition(): void {
    const hit = this.hits[this.selected];
    if (hit) this.match(hit, this.query);
  }
  /** Defer indexing until an open, non-empty search actually needs updated history. */
  markDirty(): void { this.dirty = true; }

  private refresh(queryChanged = false): void {
    const query = this.input.getValue();
    if (!queryChanged && !this.dirty) return;
    const old = this.hits[this.selected];
    if (this.dirty) this.index = undefined;
    this.dirty = false;
    this.hits = query.trim() ? fuzzyFilter(this.index ??= candidates(this.savedEntries()), query, hit => hit.text) : [];
    const retained = !queryChanged && old ? this.hits.findIndex(hit => hit.entry.source === old.entry.source &&
      hit.entry.label === old.entry.label && hit.line === old.line && hit.text === old.text) : -1;
    this.selected = Math.max(0, retained);
    this.query = query;
    if (queryChanged || retained < 0) this.match(this.hits[this.selected], query);
    this.tui.requestRender();
  }

  private step(direction: number): void {
    this.refresh();
    if (!this.hits.length) return;
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
    // A short counter leaves usable query space even in a 24-column panel.
    this.entries[1].basis = Math.min(`${this.hits.length ? this.selected + 1 : 0}/${this.hits.length}`.length,
      Math.max(3, width - 19));
    return super.render(width);
  }
}
