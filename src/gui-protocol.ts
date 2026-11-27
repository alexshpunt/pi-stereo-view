import type { Pane } from "./content.ts";

export interface GuiPageRequest {
  v: 1;
  op: "page";
  pane: Pane;
  start: number;
  count: number;
  width: number;
}

/** Reject invalid and oversized requests before looking at Pi's live components. */
export function parseGuiRequest(value: unknown): GuiPageRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  const integer = (n: unknown, min: number, max: number): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
  if (request.v !== 1 || request.op !== "page" || (request.pane !== "chat" && request.pane !== "activity") ||
      !integer(request.start, 0, Number.MAX_SAFE_INTEGER) || !integer(request.count, 0, 64) ||
      !integer(request.width, 10, 300)) return undefined;
  return { v: 1, op: "page", pane: request.pane, start: request.start, count: request.count, width: request.width };
}
