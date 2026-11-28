export type MarkKind = "sel" | "hit" | "cur";
export interface Mark { c0: number; c1: number; kind: MarkKind }
/** Per part ("t" | "a" | "o"), per wrapped row: the marks drawn in it. */
export type Marks = { [part: string]: (Mark[] | undefined)[] };
export const PARTS: Record<string, string[]>;
export const HEAD_ROWS: Record<string, number>;
export function presentParts(item: { k: string }, body: { t?: string; a?: string; o?: string } | undefined): string[];
export function partRank(key: string | null): number;
export function cellsBetween(text: string, s: number, e: number): number;
export function rowSpans(text: string, cols: number): Int32Array;
export function rowOfOffset(spans: Int32Array, off: number): number;
export function caretAt(text: string, s: number, e: number, col: number): { off: number; ch: number };
export function wordRange(text: string, ch: number): [number, number];
export function lineRange(text: string, ch: number): [number, number];
export class SpanCache {
  constructor(limit?: number);
  get(item: { id: string }, body: object, key: string, cols: number): Int32Array;
}
export function mergeMarks(a: Marks | null | undefined, b: Marks | null | undefined): Marks | null;
