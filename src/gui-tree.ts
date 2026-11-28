import type { Component } from "@earendil-works/pi-tui";
import { bodyRows } from "../herdr/mods/stereo-view/wrap.js";
import { GuiImages } from "./gui-images.ts";
import { componentText, contentText, type ContentEntry, type NativeContentIndex, type Pane as NativePane } from "./content.ts";
/** The tree panes: Chat and Activity, and Pi's single history for Combined. */
export type Pane = NativePane | "combined";

/**
 * LPT-1943 element tree: what the GUI needs to draw every native element itself.
 * Text travels unwrapped; wrapping, layout and selection are the GUI's work.
 */
export type ItemKind = "user" | "md" | "think" | "tool" | "bash" | "rows";
export interface ItemBody { t?: string; a?: string; o?: string }
export interface TreeItem {
  id: string;
  k: ItemKind;
  /** Logical lines of the unwrapped text. */
  n: number;
  /** Characters of the unwrapped text. */
  c: number;
  /** Small facts: tool name, status. */
  m?: { name?: string; status?: string };
  /** Body, only when it is small or the item is at the tail. */
  b?: ItemBody;
  /** Images of a tool result: id (fetched with `op: "image"`), pixel size, type. The GUI draws them under the text. */
  im?: { id: string; mime: string; w: number; h: number }[];
  /** Lines hidden by the collapsed body (what the TUI shows folded); the full body comes with `get` + `full`. */
  x?: number;
}
export type ServerMessage =
  | { t: "snap"; pane: Pane; epoch: number; rev: number; total: number; at: number; items: TreeItem[]; last: boolean }
  | { t: "delta"; pane: Pane; epoch: number; rev: number; at: number; remove: number; items: TreeItem[] }
  /** Exact wrapped rows (without the GUI's chrome rows) of items at `cols` text cells, so the GUI never estimates. */
  | { t: "heights"; pane: Pane; cols: number; ids: string[]; h: number[]; last: boolean }
  | { t: "bodies"; rq: number; bodies: Record<string, ItemBody | null>; truncated?: string[] }
  | { t: "rows"; rq: number; id: string; lines: readonly string[] }
  | { t: "cp"; rq: number; pane?: Pane; id: string | null };

/** Items at the end of a pane that always carry their body: streaming happens there. */
export const TAIL = 16;
const SNAPSHOT_CHUNK = 1500;
/** A body above this is cut: the GUI shows the head and the item's real line count. */
export const BODY_LIMIT = 512 * 1024;
const ARGS_LIMIT = 64 * 1024;
/** Collapsed form, like the folded rows of the TUI: every item's body is always on the wire, big ones cut. */
const COLLAPSED_TEXT = 20_000;
const COLLAPSED_ARGS_LINES = 12;
const COLLAPSED_OUTPUT_LINES = 10;
const COLLAPSED_PART_CHARS = 4_000;

const lineCount = (text: string): number => {
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
  return count;
};
const nameOf = (component: Component): string => component.constructor.name;
const tailHash = (text: string): number => {
  let hash = text.length;
  for (let i = Math.max(0, text.length - 48); i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash;
};

/** Image blocks of a tool result, stored for the GUI to fetch (`op: "image"`); the item carries only id and shape. */
export const treeImages = new GuiImages();
function imageRefs(content: unknown): NonNullable<TreeItem["im"]> {
  const out: NonNullable<TreeItem["im"]> = [];
  if (!Array.isArray(content)) return out;
  for (const block of content as { type?: string; data?: unknown }[]) {
    if (block?.type !== "image" || typeof block.data !== "string") continue;
    const ref = treeImages.register(block.data);
    if (ref) out.push(ref);
  }
  return out;
}

interface Described { k: ItemKind; body?: ItemBody; meta?: TreeItem["m"]; images?: NonNullable<TreeItem["im"]>; chars: number; lines: number; collapsed?: { body: ItemBody; hidden: number }; rows?: { cols: number; full: boolean; n: number } }

function describe(entry: ContentEntry): Described {
  const source = entry.source as Component & { text?: unknown; command?: unknown; outputLines?: unknown; customComponent?: unknown };
  if (entry.kind === "dialogue" && nameOf(source) === "UserMessageComponent" && typeof source.text === "string") {
    return text("user", source.text);
  }
  if ((entry.kind === "dialogue" || entry.kind === "thinking") && nameOf(source) === "AssistantMessageComponent") {
    // The pane's view of one assistant message holds its Markdown runs (dialogue) or its thinking blocks (activity).
    const message = (source as { lastMessage?: { content?: { type: string; text?: string; thinking?: string }[] } }).lastMessage;
    const children = (entry.component as { contentContainer?: { children?: Component[] } }).contentContainer?.children ?? [];
    const value = entry.kind === "thinking"
      ? (message?.content ?? []).filter(block => block.type === "thinking" && block.thinking?.trim()).map(block => block.thinking).join("\n\n")
      : children.filter(child => nameOf(child) === "Markdown").map(child => componentText(child) ?? "").join("\n\n");
    if (value) return text(entry.kind === "thinking" ? "think" : "md", value);
  } else if (entry.kind === "dialogue" || entry.kind === "thinking") {
    const value = componentText(entry.component);
    if (value !== undefined) return text(entry.kind === "thinking" ? "think" : "md", value);
  }
  if (entry.kind === "shell" && typeof source.command === "string" && Array.isArray(source.outputLines)) {
    const out = source.outputLines.join("\n");
    return pair("bash", source.command, out, undefined);
  }
  const summary = entry.kind === "tool" ? entry.tool?.() : undefined;
  if (summary && !source.customComponent) {
    const result = (source as { result?: { content?: unknown } }).result;
    let args = "";
    try { args = JSON.stringify(summary.args, null, 2) ?? ""; } catch { /* unserializable arguments */ }
    const described = pair("tool", args.length > ARGS_LIMIT ? args.slice(0, ARGS_LIMIT) : args, contentText(result?.content),
      { name: summary.name, status: summary.status });
    const images = imageRefs(result?.content);
    if (images.length) described.images = images;
    return described;
  }
  return { k: "rows", chars: 0, lines: 1 };
}
/** Colour and link escapes of Pi's own rows (notices render with them) have no place in the GUI's text. */
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;
function text(k: ItemKind, raw: string): Described {
  const value = raw.includes("\u001b") ? raw.replace(ESCAPES, "") : raw;
  return { k, body: { t: value }, chars: value.length, lines: lineCount(value) };
}
function pair(k: ItemKind, a: string, o: string, meta: TreeItem["m"]): Described {
  return { k, body: { a, o }, meta, chars: a.length + o.length, lines: lineCount(a) + (o ? lineCount(o) : 0) };
}
const bodyChars = (body: ItemBody): number => (body.t?.length ?? 0) + (body.a?.length ?? 0) + (body.o?.length ?? 0);
const head = (value: string, lines: number, chars: number): string => {
  let end = 0;
  for (let n = 0; n < lines; n++) { const at = value.indexOf("\n", end); if (at < 0) { end = value.length; break; } end = at + 1; }
  if (end === 0) end = value.length;
  return value.slice(0, Math.min(end, chars)).replace(/\n$/, "");
};
/** The folded body of an item (memoized on its description) and how many lines it hides. */
function collapse(d: Described): { body: ItemBody; hidden: number } {
  if (d.collapsed) return d.collapsed;
  const body = d.body ?? {};
  let cut: ItemBody;
  if (body.t !== undefined) cut = { t: body.t.length <= COLLAPSED_TEXT ? body.t : head(body.t, Infinity, COLLAPSED_TEXT) };
  else cut = { a: head(body.a ?? "", COLLAPSED_ARGS_LINES, COLLAPSED_PART_CHARS), o: head(body.o ?? "", COLLAPSED_OUTPUT_LINES, COLLAPSED_PART_CHARS) };
  const shown = (cut.t !== undefined ? lineCount(cut.t) : 0) + (cut.a !== undefined ? lineCount(cut.a) : 0) + (cut.o ? lineCount(cut.o) : 0);
  const stored = bodyChars(cut) < bodyChars(body);
  const hidden = stored ? Math.max(1, d.lines - shown) : 0;
  d.collapsed = { body: cut, hidden };
  return d.collapsed;
}
function limited(body: ItemBody): { body: ItemBody; truncated: boolean } {
  if (bodyChars(body) <= BODY_LIMIT) return { body, truncated: false };
  const cut = (value: string | undefined, budget: number): string | undefined => value === undefined || value.length <= budget ? value : value.slice(0, budget);
  const half = BODY_LIMIT / 2;
  return { body: { t: cut(body.t, BODY_LIMIT), a: cut(body.a, half), o: cut(body.o, half) }, truncated: true };
}

/** Shared per-pane view of the native index: stable ids and cheap fingerprints. */
class PaneModel {
  private readonly ids = new WeakMap<Component, Map<string, string>>();
  private readonly described = new WeakMap<ContentEntry, { d: Described; id: string; f: string }>();
  private next = 0;
  constructor(readonly pane: Pane) {}

  private idOf(entry: ContentEntry, ordinal: number): string {
    let byKey = this.ids.get(entry.source);
    if (!byKey) { byKey = new Map(); this.ids.set(entry.source, byKey); }
    const key = `${entry.kind}:${ordinal}`;
    let id = byKey.get(key);
    if (!id) { id = `${this.pane[0]}${(++this.next).toString(36)}`; byKey.set(key, id); }
    return id;
  }

  /** Entries with their ids and fingerprints; unchanged non-tail entries reuse their cached description. */
  scan(entries: readonly ContentEntry[]): { id: string; f: string; d: Described; entry: ContentEntry }[] {
    const occurrence = new Map<Component, number>();
    const out: { id: string; f: string; d: Described; entry: ContentEntry }[] = [];
    const hot = entries.length - TAIL;
    entries.forEach((entry, position) => {
      const ordinal = occurrence.get(entry.source) ?? 0;
      occurrence.set(entry.source, ordinal + 1);
      let cached = this.described.get(entry);
      const running = cached?.d.meta?.status === "running";
      if (!cached || position >= hot || running) {
        const d = describe(entry);
        const id = cached?.id ?? this.idOf(entry, ordinal);
        const f = `${id}|${d.k}|${d.lines}|${d.chars}|${d.images?.length ?? 0}|${d.meta?.status ?? ""}|${d.body ? tailHash(d.body.t ?? d.body.o ?? d.body.a ?? "") : 0}`;
        if (!cached || cached.f !== f) { cached = { d, id, f }; this.described.set(entry, cached); }
      }
      out.push({ id: cached.id, f: cached.f, d: cached.d, entry });
    });
    return out;
  }
}

/** `full`: the whole body (the tail, which streams); otherwise the folded one. */
function header(row: { id: string; d: Described }, full: boolean): { item: TreeItem; truncated: boolean } {
  const item: TreeItem = { id: row.id, k: row.d.k, n: row.d.lines, c: row.d.chars };
  if (row.d.meta) item.m = row.d.meta;
  if (row.d.images) item.im = row.d.images;
  let truncated = false;
  if (row.d.body && full) {
    const cut = limited(row.d.body);
    item.b = cut.body; truncated = cut.truncated;
  } else if (row.d.body) {
    const folded = collapse(row.d);
    item.b = folded.body;
    if (folded.hidden) item.x = folded.hidden;
  }
  return { item, truncated };
}

/** The tree of every pane, shared by all open streams. */
export class GuiTree {
  private readonly models: Record<Pane, PaneModel> = { activity: new PaneModel("activity"), chat: new PaneModel("chat"), combined: new PaneModel("combined") };
  private epoch = 0;
  private lastIndex: NativeContentIndex | undefined;
  constructor(private readonly index: () => NativeContentIndex | undefined, private readonly width = () => 100) {}

  private rows(pane: Pane) {
    const index = this.index();
    if (!index) throw new Error("History is unavailable");
    if (index !== this.lastIndex) { this.lastIndex = index; this.epoch++; }
    index.beginFrame();
    return this.models[pane].scan(index.entries(pane === "combined" ? undefined : pane));
  }

  /** A stream: its own idea of what the client already has. */
  open(pane: Pane): TreeStream { return new TreeStream(this, pane); }

  /** @internal */ scanFor(pane: Pane) { return { rows: this.rows(pane), epoch: this.epoch }; }
  /** Pi's own rendered rows for one item: the fallback for elements without a native component. */
  renderRows(pane: Pane, id: string, width: number): readonly string[] {
    const found = this.rows(pane).find(row => row.id === id);
    return found ? found.entry.component.render(width) : [];
  }
  /** The element of the other pane at the same point of history, by Pi's own rule (NativeContentIndex.counterpart). */
  counterpart(pane: Pane, id: string): { pane: Pane; id: string } | undefined {
    const index = this.index();
    const found = this.rows(pane).find(row => row.id === id);
    if (!index || !found || pane === "combined") return undefined;
    const target = index.counterpart(found.entry.source, pane);
    if (!target) return undefined;
    const other: Pane = pane === "chat" ? "activity" : "chat";
    const row = this.rows(other).find(candidate => candidate.entry.source === target);
    return row ? { pane: other, id: row.id } : undefined;
  }
  defaultWidth(): number { return this.width(); }
}

export class TreeStream {
  private sentFps: string[] = [];
  private epoch = -1;
  private rev = 0;
  constructor(private readonly tree: GuiTree, readonly pane: Pane) {}

  /** The full snapshot in chunks: headers only, bodies for the tail. */
  snapshot(): ServerMessage[] {
    const { rows, epoch } = this.tree.scanFor(this.pane);
    this.epoch = epoch;
    this.rev++;
    this.sentFps = rows.map(row => row.f);
    const messages: ServerMessage[] = [];
    const total = rows.length;
    for (let at = 0; at < total || at === 0; at += SNAPSHOT_CHUNK) {
      const items = rows.slice(at, at + SNAPSHOT_CHUNK).map((row, i) => header(row, at + i >= total - TAIL).item);
      messages.push({ t: "snap", pane: this.pane, epoch, rev: this.rev, total, at, items, last: at + SNAPSHOT_CHUNK >= total });
      if (total === 0) break;
    }
    return messages;
  }

  /** One splice against what the client has, or nothing when nothing changed. */
  delta(): ServerMessage[] | undefined {
    const { rows, epoch } = this.tree.scanFor(this.pane);
    if (epoch !== this.epoch) return this.snapshot();
    const fps = rows.map(row => row.f);
    const old = this.sentFps;
    let start = 0;
    while (start < old.length && start < fps.length && old[start] === fps[start]) start++;
    let oldEnd = old.length, newEnd = fps.length;
    while (oldEnd > start && newEnd > start && old[oldEnd - 1] === fps[newEnd - 1]) { oldEnd--; newEnd--; }
    if (start === oldEnd && start === newEnd) return undefined;
    this.sentFps = fps;
    this.rev++;
    const total = rows.length;
    const items = rows.slice(start, newEnd).map((row, i) => header(row, start + i >= total - TAIL || newEnd - start <= TAIL).item);
    return [{ t: "delta", pane: this.pane, epoch, rev: this.rev, at: start, remove: oldEnd - start, items }];
  }

  /**
   * Exact heights of every text item at `cols`, in chunks of `chunk` items (the caller yields between them so Pi's
   * own UI stays responsive). Cached on each item's description: unchanged items cost nothing on a repeat.
   */
  *heightChunks(cols: number, chunk = 400): Generator<ServerMessage> {
    const { rows } = this.tree.scanFor(this.pane);
    const total = rows.length;
    for (let at = 0; at < total || at === 0; at += chunk) {
      const ids: string[] = [];
      const h: number[] = [];
      for (let i = at; i < Math.min(total, at + chunk); i++) {
        const row = rows[i];
        if (row.d.k === "rows") {
          // Pi's own rows (notices): their height is the rendered row count, so the GUI never guesses it either.
          let n = 1;
          try { n = Math.max(1, row.entry.component.render(cols).length); } catch { /* keep one row */ }
          ids.push(row.id); h.push(n);
          continue;
        }
        if (!row.d.body) continue;
        const full = i >= total - TAIL;
        let cached = row.d.rows;
        if (!cached || cached.cols !== cols || cached.full !== full) {
          cached = { cols, full, n: bodyRows(full ? limited(row.d.body).body : collapse(row.d).body, cols) };
          row.d.rows = cached;
        }
        ids.push(row.id); h.push(cached.n);
      }
      yield { t: "heights", pane: this.pane, cols, ids, h, last: at + chunk >= total };
      if (total === 0) break;
    }
  }

  /** Bodies of the asked items; undefined when the item is gone or has no text body. */
  bodies(rq: number, ids: readonly string[], full = true): ServerMessage {
    const { rows } = this.tree.scanFor(this.pane);
    const wanted = new Set(ids);
    const bodies: Record<string, ItemBody | null> = {};
    const truncated: string[] = [];
    for (const row of rows) {
      if (!wanted.has(row.id)) continue;
      if (!row.d.body) { bodies[row.id] = null; continue; }
      if (!full) { bodies[row.id] = collapse(row.d).body; continue; }
      const cut = limited(row.d.body);
      bodies[row.id] = cut.body;
      if (cut.truncated) truncated.push(row.id);
    }
    return { t: "bodies", rq, bodies, ...(truncated.length ? { truncated } : {}) };
  }

  counterpart(rq: number, id: string): ServerMessage {
    const found = this.tree.counterpart(this.pane, id);
    return { t: "cp", rq, ...(found ? { pane: found.pane, id: found.id } : { id: null }) };
  }

  rows(rq: number, id: string, width: number): ServerMessage {
    return { t: "rows", rq, id, lines: this.tree.renderRows(this.pane, id, width) };
  }
}
