import type { TreeClient } from "./tree-client.js";
import type { TreeChange } from "./tree-model.js";
import type { TreeLayout } from "./tree-layout.js";
export class TreeView {
  constructor(client: Pick<TreeClient, "model" | "closed" | "get" | "rows">, options?: { viewport?: number; cols?: number; budgetMs?: number; prefetchScreens?: number; maxChars?: number });
  layout: TreeLayout; anchor: { index: number; offset: number }; following: boolean;
  readonly top: number; readonly maxTop: number; readonly exact: boolean; readonly settled: boolean; maxChars: number;
  changed(change: TreeChange): void;
  setViewport(rows: number): void;
  setCols(cols: number): void;
  scrollTo(row: number): void; scrollBy(rows: number): void; toTop(): void; toBottom(): void; toItem(index: number): void;
  frame(): { top: number; total: number; window: { index: number; row: number }[]; pending: number[]; blank: number[]; spentMs: number; measuredCount: number };
}
