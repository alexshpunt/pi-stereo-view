import type { TreeView } from "./tree-view.js";
import type { TreeLayout } from "./tree-layout.js";
import type { TreeSelection } from "./tree-select.js";
import type { TreeFind, FindState, FindTarget } from "./tree-find.js";
import type { Marks } from "./tree-text.js";
import type { TreeBody, TreeHeader } from "./tree-model.js";
export interface PointerState { handle: { offset(): { x: number; y: number }; viewport_size(): { width: number; height: number }; scroll_to_item(index: number, strategy?: "top" | "center"): void }; height: number }
export interface PointerCx { notify(): void; timer: { after(ms: number, cb: (cx: PointerCx) => void): unknown }; write_to_clipboard(text: string): void }
export function autoScrollTarget(layout: TreeLayout, top: number, direction: number): number;
export class TreeInteraction {
  constructor(view: TreeView);
  selection: TreeSelection; find: TreeFind;
  metrics: { lineHeight: number; cellWidth: number; textLeft: number };
  readonly busy: boolean; readonly dragging: boolean; readonly hasSelection: boolean;
  changed(): void;
  down(state: PointerState, pos: { x: number; y: number; count: number; shift: boolean; maxX?: number }, cx: PointerCx): boolean;
  move(state: PointerState, pos: { x: number; y: number; pressed: boolean }, cx: PointerCx): boolean;
  up(): void;
  copy(cx: PointerCx): boolean;
  clear(): void;
  marks(index: number, item: TreeHeader, body: TreeBody, rows: { parts: Record<string, string[] | undefined> }): Marks | null;
  findActions(hooks: { state(state: FindState): void; closed?(cx: PointerCx): void }): {
    query(text: string, cx: PointerCx): void; next(cx: PointerCx): void; previous(cx: PointerCx): void; close(cx: PointerCx): void };
  frame(): FindTarget | null;
}
