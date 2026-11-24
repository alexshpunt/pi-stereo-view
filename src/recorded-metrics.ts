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

const counts = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 12 });
const labels = new WeakMap<RecordedUsage, { text: string; hasUsage: boolean }>();

export function usageLabel(usage: RecordedUsage | undefined, scope: "response" | "tool" | "inclusive"): string {
  if (!usage || typeof usage !== "object") return "";
  let label = labels.get(usage);
  if (label === undefined) {
    const parts: string[] = [];
    let hasUsage = false;
    for (const [field, name] of [["input", "in"], ["output", "out"], ["cacheRead", "cache read"], ["cacheWrite", "cache write"]] as const) {
      const tokens = usage[field];
      if (measured(tokens)) { parts.push(`${counts.format(tokens)} ${name}`); hasUsage ||= tokens > 0; }
    }
    const total = usage.cost?.total;
    if (measured(total)) { parts.push(dollars.format(total)); hasUsage ||= total > 0; }
    label = { text: parts.join(" · "), hasUsage };
    labels.set(usage, label);
  }
  // Pi creates an all-zero usage object even if a model returned no accounting.
  if (!label.text || (scope === "response" && !label.hasUsage)) return "";
  return `${scope === "response" ? "Model usage" : scope === "inclusive" ? "Tool usage incl. nested" : "Tool usage"}: ${label.text}`;
}

/** Keep all recorded fields readable when panes are narrow without clipping original rows. */
export function metricRows(label: string, width: number, theme: Theme): string[] {
  if (!label || width < 2) return [];
  return wrapTextWithAnsi(label, width - 1).map(line => " " + theme.fg("dim", line));
}
