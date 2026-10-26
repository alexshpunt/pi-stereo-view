import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolSummary } from "./content.js";

const singleLine = (text: string): string => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

/** Prefer the useful argument, falling back to a bounded preview of custom input. */
export function toolDescription(args: unknown): string {
  if (typeof args === "string") return singleLine(args);
  if (!args || typeof args !== "object") return args == null ? "" : String(args);
  const record = args as Record<string, unknown>;
  const values = ["command", "query", "pattern", "url", "path", "file_path", "file", "description", "code"];
  for (const key of values) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return singleLine(value);
  }
  // Streamed args are JSON values; don't stringify a large file body just to label a call.
  return Object.entries(record).slice(0, 3).map(([key, value]) => {
    const preview = typeof value === "string" ? value.slice(0, 160) :
      value === null || typeof value !== "object" ? String(value) : Array.isArray(value) ? "[…]" : "{…}";
    return `${singleLine(key)}: ${singleLine(preview)}`;
  }).join(" ");
}

/** One call, one row. Results and native renderer state remain with the full document. */
export class CompactTool implements Component {
  constructor(private readonly summary: () => ToolSummary, private readonly theme: () => Theme) {}

  render(width: number): string[] {
    const { name, args, status } = this.summary();
    const theme = this.theme();
    const dot = theme.fg(status === "running" ? "warning" : status, "●");
    const description = toolDescription(args);
    return [truncateToWidth(`${dot} ${singleLine(name)}${description ? " " + theme.fg("muted", description) : ""}`, Math.max(0, width), "…")];
  }
  invalidate(): void {}
}
