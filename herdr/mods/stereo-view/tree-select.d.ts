import type { TreeView } from "./tree-view.js";
import type { SpanCache, Marks } from "./tree-text.js";
import type { TreeBody, TreeHeader } from "./tree-model.js";
export interface TreePoint { id: string; part: string | null; off: number; ch: number }
export class TreeSelection {
  constructor(view: TreeView, spans?: SpanCache);
  anchor: TreePoint | null; focus: TreePoint | null;
  pointAt(row: number, col: number): TreePoint | null;
  start(point: TreePoint, mode?: "char" | "word" | "line"): void;
  extend(point: TreePoint): void;
  clear(): void;
  atFocus(point: TreePoint): boolean;
  range(): { start: TreePoint; end: TreePoint; si: number; ei: number } | undefined;
  text(): string | undefined;
  marks(index: number, item: TreeHeader, body: TreeBody, rows: { parts: Record<string, string[] | undefined> }): Marks | null;
}
