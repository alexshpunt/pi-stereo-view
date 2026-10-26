import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
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

interface CompactToolOptions {
  clock?(): string;
  gutter?(): number;
  count?(): number;
  expanded?(): boolean;
  toggle?(): void;
}

/** A display-only call or group header; the original renderer owns the body. */
export class CompactTool implements Component {
  constructor(private readonly summary: () => ToolSummary, private readonly theme: () => Theme,
    private readonly options: CompactToolOptions = {}) {}

  render(width: number): string[] {
    width = Math.max(0, width - (this.options.gutter?.() ?? 0));
    const { name, args, status } = this.summary();
    const theme = this.theme();
    const dot = theme.fg(status === "running" ? "warning" : status, "●");
    const count = this.options.count?.();
    const description = count ? "" : toolDescription(args);
    const control = this.options.toggle ? theme.fg("muted", this.options.expanded?.() ? "▾" : "▸") + " " : "";
    const text = `${dot} ${control}${singleLine(name)}${count ? ` ×${count}` : ""}${description ? " " + theme.fg("muted", description) : ""}`;
    const label = this.options.clock?.() ?? "";
    const clock = label && width >= visibleWidth(label) + 8 ? label : "";
    const available = Math.max(0, width - 1 - (clock ? visibleWidth(clock) + 1 : 0));
    const body = truncateToWidth(text, available, "…");
    return [(width > 0 ? " " : "") + (clock ? theme.fg("dim", clock) + " " : "") + body];
  }
  handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
    if (!this.options.toggle || event.button !== "left") return undefined;
    if (event.type === "press") return { capture: true };
    if (event.type === "click" && event.x >= 0 && event.x < event.width && event.y === 0) {
      this.options.toggle();
      return { handled: true, render: true };
    }
    return { handled: true };
  }
  invalidate(): void {}
}
