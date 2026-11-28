import type { TreeModel } from "./tree-model.js";
export const RELAY: string;
export interface StreamProcess { onLine(cb: (line: string) => void): void; onExit(cb: (code?: number | null, why?: string) => void): void; write(line: string): void; kill(): void }
export type SpawnStream = (command: string, args: string[], options?: { on?: string; cwd?: string }) => StreamProcess;
export class TreeClient {
  constructor(spawnStream: SpawnStream, target: { socket: string; pane: string; on?: string; cwd?: string }, hooks?: {
    change?(change: import("./tree-model.js").TreeChange): void; message?(message: { t: string }, parseMs: number): void;
    bodies?(loaded: string[], truncated: string[]): void; exit?(): void; error?(text: string): void });
  model: TreeModel; closed: boolean;
  start(): this;
  get(ids: string[]): Promise<string[] | undefined>;
  rows(id: string, width: number): Promise<readonly string[] | undefined>;
  close(): void;
}
