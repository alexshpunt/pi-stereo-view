export interface TreeBody { t?: string; a?: string; o?: string }
export interface TreeHeader { id: string; k: string; n: number; c: number; m?: { name?: string; status?: string }; b?: TreeBody; x?: number }
export interface TreeChange { kind: string; at: number; removed: number; inserted: number; last?: boolean; resync?: boolean }
export class TreeModel {
  epoch: number; rev: number; items: TreeHeader[]; bodies: Map<string, TreeBody>; ready: boolean; full: Set<string>; folded: Map<string, TreeBody>;
  readonly length: number;
  reset(): void;
  indexOf(id: string): number;
  apply(message: unknown): TreeChange | undefined;
  storeBodies(bodies: Record<string, TreeBody | null>): string[];
  readonly bodyChars: number;
  readonly expandedChars: number;
  isFolded(item: TreeHeader): boolean;
  fold(id: string): boolean;
  evictExpanded(center: number, maxChars: number): string[];
  body(at: number): TreeBody | undefined;
}
export function bodyText(body: TreeBody | undefined): string;
