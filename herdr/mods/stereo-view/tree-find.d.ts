import type { TreeView } from "./tree-view.js";
import type { SpanCache, Marks } from "./tree-text.js";
import type { TreeSearch } from "./tree-search.js";
import type { TreeBody, TreeHeader } from "./tree-model.js";
export interface FindState { open: boolean; query: string; count: number; current: number; pending: boolean; error?: string }
export interface FindTarget { index: number; id: string; key: string; row: number; rowInItem: number; col: number }
export class TreeFind {
  constructor(view: TreeView, spans?: SpanCache);
  open: boolean; query: string; search: TreeSearch; current: number;
  readonly busy: boolean;
  begin(): void; close(): void;
  setQuery(text: string): void;
  changed(now?: number): void;
  step(budgetMs?: number, now?: number): boolean;
  move(direction: number): boolean;
  takeJump(): FindTarget | null;
  state(): FindState;
  target(hit: { id: string; at: number }): FindTarget | null;
  marks(index: number, item: TreeHeader, body: TreeBody, rows: { parts: Record<string, string[] | undefined> }): Marks | null;
}
