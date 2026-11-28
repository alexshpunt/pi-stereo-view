import type { TreeModel } from "./tree-model.js";
export class TreeSearch {
  constructor(model: TreeModel);
  hits: { index: number; id: string; at: number }[]; done: boolean; missing: number;
  start(query: string): void;
  step(budgetMs?: number): number;
}
