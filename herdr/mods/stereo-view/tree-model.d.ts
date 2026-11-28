export interface TreeBody { t?: string; a?: string; o?: string }
export interface TreeHeader { id: string; k: string; n: number; c: number; m?: { name?: string; status?: string }; b?: TreeBody; p?: string }
export interface TreeChange { kind: string; at: number; removed: number; inserted: number; last?: boolean; resync?: boolean }
export class TreeModel {
  epoch: number; rev: number; items: TreeHeader[]; bodies: Map<string, TreeBody>; ready: boolean;
  readonly length: number;
  reset(): void;
  indexOf(id: string): number;
  apply(message: unknown): TreeChange | undefined;
  storeBodies(bodies: Record<string, TreeBody | null>): string[];
  readonly bodyChars: number;
  evict(center: number, maxChars: number): number;
  body(at: number): TreeBody | undefined;
}
export function bodyText(body: TreeBody | undefined): string;
