import type { TreeModel, TreeBody } from "./tree-model.js";
export class TreeLayout {
  constructor(model: TreeModel);
  cols: number; version: number; heights: Int32Array; measured: Uint8Array;
  fallbackRows: Map<string, { rows: number; lines: readonly string[] }>;
  readonly count: number; readonly totalRows: number;
  rebuild(cols?: number): void;
  splice(at: number, removed: number, inserted: number): void;
  prefix(i: number): number;
  locate(row: number): { index: number; offset: number };
  setHeight(i: number, rows: number): number;
  measure(i: number, keep?: boolean): number | undefined;
  measureSlice(budgetMs: number): boolean;
  remeasure(id: string): number;
  unmeasured: number;
  rowsOf(item: { id: string }, body: TreeBody): { parts: { t?: string[]; a?: string[]; o?: string[] }; total: number };
  setFallback(id: string, lines: readonly string[], cols: number): boolean;
  window(top: number, rows: number): { index: number; row: number }[];
}
