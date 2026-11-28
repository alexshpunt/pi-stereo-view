export function cellWidth(code: number): number;
export function stringWidth(text: string): number;
export function wrapLine(line: string, cols: number, out: string[]): void;
export function wrapAscii(line: string, cols: number, out: string[]): void;
export function wrapGeneral(line: string, cols: number, out: string[]): void;
export function wrapRows(text: string, cols: number): string[];
export function bodyRows(body: { t?: string; a?: string; o?: string }, cols: number): number;
export function estimateRows(lines: number, chars: number, cols: number): number;
