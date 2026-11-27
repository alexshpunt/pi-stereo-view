import type { Pane } from "./content.ts";
import type { NativeDocument } from "./native.ts";
import { matchSearchLines } from "./search-matcher.ts";
import { searchText, type SearchEntry, type SearchHit } from "./search.ts";

/** The scroll position to restore when search closes. */
export interface GuiSearchViewport { top: number; height: number; following: boolean }
export interface GuiSearchState {
  open: boolean;
  query: string;
  count: number;
  /** One-based selected match, or zero with no results. */
  current: number;
  /** Requested scroll position after navigating to a match. */
  top?: number;
  following?: boolean;
  pending: boolean;
  error?: string;
}
interface Session {
  saved: GuiSearchViewport;
  query: string;
  index?: SearchHit[];
  hits: SearchHit[];
  selected: number;
  generation: number;
  pending?: AbortController;
  top?: number;
  following?: boolean;
  error?: string;
}

/** Search saved full text, including collapsed tool results, through the GUI's own documents. */
export class GuiHistorySearch {
  private readonly sessions: Partial<Record<Pane, Session>> = {};
  private disposed = false;

  constructor(private readonly documents: Record<Pane, NativeDocument>,
    /** Invalidate the pane's frame and notify its GUI after search presentation changes. */
    private readonly changed: (pane: Pane) => void = () => {}) {}

  open(pane: Pane, viewport: GuiSearchViewport): GuiSearchState {
    if (this.disposed) throw new Error("Search is closed");
    if (!Number.isSafeInteger(viewport.top) || viewport.top < 0 || !Number.isSafeInteger(viewport.height) || viewport.height < 1 ||
        typeof viewport.following !== "boolean") throw new RangeError("Invalid search viewport");
    if (!this.sessions[pane]) this.sessions[pane] = { saved: { ...viewport }, query: "", hits: [], selected: 0, generation: 0 };
    return this.state(pane);
  }

  state(pane: Pane): GuiSearchState {
    const session = this.sessions[pane];
    if (!session) return { open: false, query: "", count: 0, current: 0, pending: false };
    return { open: true, query: session.query, count: session.hits.length,
      current: session.hits.length ? session.selected + 1 : 0, pending: !!session.pending,
      ...(session.top === undefined ? {} : { top: session.top }),
      ...(session.following === undefined ? {} : { following: session.following }),
      ...(session.error === undefined ? {} : { error: session.error }) };
  }

  /** Cancel outstanding work and rebuild saved text the next time this query runs. */
  markDirty(pane?: Pane): void {
    for (const key of pane ? [pane] : ["chat", "activity"] as const) {
      const session = this.sessions[key];
      if (!session) continue;
      session.generation++;
      session.pending?.abort();
      session.pending = undefined;
      session.index = undefined;
    }
  }

  /** Refresh an open query only when its history has changed. */
  async refresh(pane: Pane): Promise<GuiSearchState> {
    const session = this.sessions[pane];
    if (session && session.query.trim() && !session.index && !session.pending)
      return this.query(pane, session.query);
    return this.state(pane);
  }

  /** Set or refresh a query. Literal and Boolean terms and explicit regex use the TUI matcher. */
  async query(pane: Pane, query: string): Promise<GuiSearchState> {
    const session = this.sessions[pane];
    if (!session || this.disposed) return this.state(pane);
    const changed = query !== session.query;
    const previous = session.hits[session.selected];
    const generation = ++session.generation;
    session.pending?.abort();
    session.pending = undefined;
    session.query = query;
    session.error = undefined;
    if (!query.trim()) {
      session.hits = [];
      session.selected = 0;
      this.clear(pane, session);
      return this.state(pane);
    }
    try {
      if (!session.index) {
        this.documents[pane].beginFrame();
        session.index = candidates(this.documents[pane].searchEntries());
      }
      const index = session.index;
      const controller = new AbortController();
      const result = matchSearchLines(index.map(hit => hit.text), query, controller.signal);
      if (!Array.isArray(result)) {
        session.pending = controller;
        if (changed) { session.hits = []; session.selected = 0; this.clear(pane, session); }
        else this.changed(pane);
      }
      const matches = await result;
      if (this.sessions[pane] !== session || session.generation !== generation) return this.state(pane);
      session.pending = undefined;
      session.hits = matches.map(hit => ({ ...index[hit.index]!, ranges: hit.ranges }));
      const retained = !changed && previous ? session.hits.findIndex(hit => hit.entry.source === previous.entry.source &&
        hit.entry.label === previous.entry.label && hit.line === previous.line && hit.text === previous.text) : -1;
      session.selected = Math.max(0, retained);
      const selected = session.hits[session.selected];
      if (changed || retained < 0 || previous?.entry.text !== selected?.entry.text) this.reveal(pane, session, selected);
      else this.changed(pane);
    } catch (error) {
      if (this.sessions[pane] !== session || session.generation !== generation) return this.state(pane);
      session.pending = undefined;
      session.hits = [];
      session.selected = 0;
      session.error = error instanceof Error ? error.message : String(error);
      this.clear(pane, session);
    }
    return this.state(pane);
  }

  step(pane: Pane, direction: -1 | 1): GuiSearchState {
    const session = this.sessions[pane];
    if (!session || !session.hits.length || session.pending) return this.state(pane);
    session.selected = (session.selected + direction + session.hits.length) % session.hits.length;
    this.reveal(pane, session, session.hits[session.selected]);
    return this.state(pane);
  }

  /** Keep the selected match in view when the GUI panel changes height. */
  resize(pane: Pane, height: number): GuiSearchState {
    const session = this.sessions[pane];
    if (!session) return this.state(pane);
    if (!Number.isSafeInteger(height) || height < 1) throw new RangeError("Invalid search height");
    session.saved.height = height;
    if (session.hits.length) this.reveal(pane, session, session.hits[session.selected]);
    return this.state(pane);
  }

  /** Close search, remove temporary highlights/expansion and return the saved scroll. */
  close(pane: Pane): { top: number; following: boolean } | undefined {
    const session = this.sessions[pane];
    if (!session) return undefined;
    delete this.sessions[pane];
    session.generation++;
    session.pending?.abort();
    this.documents[pane].clearSearch();
    this.changed(pane);
    return { top: session.saved.top, following: session.saved.following };
  }

  dispose(): void {
    if (this.disposed) return;
    this.close("chat");
    this.close("activity");
    this.disposed = true;
  }

  private clear(pane: Pane, session: Session): void {
    this.documents[pane].clearSearch();
    session.top = undefined;
    session.following = undefined;
    this.changed(pane);
  }

  private reveal(pane: Pane, session: Session, hit: SearchHit | undefined): void {
    const document = this.documents[pane];
    if (!hit || !document.reveal(hit, session.query)) { this.clear(pane, session); return; }
    let row = document.searchRow(hit);
    if (row === undefined) {
      document.showSearchExcerpt(hit);
      row = document.searchRow(hit);
    }
    if (row !== undefined) {
      session.top = Math.max(0, row - Math.min(2, session.saved.height - 1));
      session.following = false;
    } else {
      session.top = undefined;
      session.following = undefined;
    }
    this.changed(pane);
  }
}

function candidates(entries: SearchEntry[]): SearchHit[] {
  return entries.slice().reverse().flatMap(entry => searchText(entry.text).split("\n").flatMap((text, line) =>
    text.trim() ? [{ entry, line, text: text.trim() }] : []));
}
