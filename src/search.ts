import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box, Container, fuzzyFilter, getKeybindings, Input, Spacer, SelectList, stripTerminalSequences, Text,
  type Component, type Focusable, type TUI, type TuiMouseEvent,
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
      // Do not overwrite another extension's later keyboard change.
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

/** Keep transcript text readable without allowing terminal control sequences in the picker. */
export function searchText(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "  ");
}

/** Search complete block text; equally ranked results prefer more recent blocks. */
export function searchHits(entries: SearchEntry[], query: string): SearchHit[] {
  const hits = entries.slice().reverse().flatMap(entry => searchText(entry.text).split("\n").flatMap((text, line) =>
    text.trim() ? [{ entry, line, text: text.trim() }] : []));
  return fuzzyFilter(hits, query, hit => hit.text).slice(0, 200);
}

/** A single fuzzy picker that never submits or edits the main prompt. */
export class PanelSearch implements Component, Focusable {
  private readonly input = new Input({ prompt: "Search: " });
  private readonly content = new Container();
  private readonly box: Box;
  private list?: SelectList;
  private hits: SearchHit[] = [];
  private snapshot = "";
  private query?: string;
  private visibleRows = 0;

  constructor(
    private readonly title: string,
    private readonly entries: () => SearchEntry[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (hit: SearchHit | undefined) => void,
  ) {
    this.box = new Box(1, 1, text => theme.bg("customMessageBg", text));
    this.box.addChild(this.content);
    this.input.onEscape = () => done(undefined);
    this.input.onSubmit = () => this.select();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private select(): void {
    const selected = this.list?.getSelectedItem();
    if (selected) this.done(this.hits[Number(selected.value)]);
  }

  private refresh(): void {
    const entries = this.entries();
    const snapshot = entries.map(entry => entry.label + "\0" + entry.text).join("\0");
    const query = this.input.getValue();
    const visibleRows = Math.max(1, Math.min(8, this.tui.terminal.rows - 10));
    if (snapshot === this.snapshot && query === this.query && visibleRows === this.visibleRows && this.list) return;
    this.visibleRows = visibleRows;
    const previous = this.list?.getSelectedItem();
    const selected = previous ? this.hits[Number(previous.value)] : undefined;
    this.hits = searchHits(entries, query);
    this.list = new SelectList(this.hits.map((hit, index) => ({
      value: String(index), label: hit.text, description: hit.entry.label,
    })), visibleRows, getSelectListTheme(), {
      maxPrimaryColumnWidth: 70,
    });
    if (query === this.query && selected) {
      const index = this.hits.findIndex(hit => hit.entry.source === selected.entry.source &&
        hit.entry.label === selected.entry.label && hit.line === selected.line);
      if (index >= 0) this.list.setSelectedIndex(index);
    }
    this.list.onSelect = () => this.select();
    this.list.onCancel = () => this.done(undefined);
    this.snapshot = snapshot;
    this.query = query;
    this.content.children = [
      new Text(this.theme.fg("accent", this.theme.bold(this.title)), 0, 0),
      this.input, new Spacer(1),
      this.hits.length ? this.list : new Text(this.theme.fg("dim", "No matches"), 0, 0),
      new Spacer(1), new Text(this.theme.fg("dim", "↑/↓ choose · Enter jump · Esc close"), 0, 0),
    ];
  }

  render(width: number): string[] {
    this.refresh();
    return this.box.render(width);
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    const navigation = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const;
    if (navigation.some(key => keys.matches(data, key))) this.list?.handleInput(data);
    else this.input.handleInput(data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): ReturnType<Box["handleMouse"]> {
    return this.box.handleMouse(event);
  }

  invalidate(): void { this.box.invalidate(); }
}
