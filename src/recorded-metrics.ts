import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface MetricDisplay {
  durations(): boolean;
  usage(): boolean;
}

export interface ToolMetrics {
  durationMs?: number;
  usage?: RecordedUsage;
  inclusive?: boolean;
}

export interface RecordedUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

const measured = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function durationLabel(ms: number | undefined): string {
  if (!measured(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Match Pi's footer without importing a private Pi module.
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 12 });
const labels = new WeakMap<RecordedUsage, { text: string; hasUsage: boolean }>();

export function usageLabel(usage: RecordedUsage | undefined, scope: "response" | "tool" | "inclusive"): string {
  if (!usage || typeof usage !== "object") return "";
  let label = labels.get(usage);
  if (label === undefined) {
    const parts: string[] = [];
    let hasUsage = false;
    for (const [field, prefix] of [["input", "↑"], ["output", "↓"], ["cacheRead", "R"], ["cacheWrite", "W"]] as const) {
      const tokens = usage[field];
      if (measured(tokens)) { parts.push(prefix + formatTokens(tokens)); hasUsage ||= tokens > 0; }
    }
    const total = usage.cost?.total;
    if (measured(total)) { parts.push(dollars.format(total)); hasUsage ||= total > 0; }
    label = { text: parts.join(" "), hasUsage };
    labels.set(usage, label);
  }
  // Pi creates an all-zero usage object even if a model returned no accounting.
  if (!label.text || (scope === "response" && !label.hasUsage)) return "";
  if (scope === "response") return label.text;
  return `${scope === "inclusive" ? "Tool usage incl. nested" : "Tool usage"}: ${label.text}`;
}

/** Keep all recorded fields readable when panes are narrow without clipping original rows. */
export function metricRows(label: string, width: number, theme: Theme): string[] {
  if (!label || width < 2) return [];
  return wrapTextWithAnsi(label, width - 1).map(line => " " + theme.fg("dim", line));
}
