import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Color, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolSummary } from "./content.ts";

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
  alignControl?: boolean;
  clock?(): string;
  gutter?(): number;
  count?(): number;
  expanded?(): boolean;
  toggle?(): void;
  /** Turn color behind the clock. */
  clockBackground?(): Color | undefined;
  /** When it returns an action, clicking the clock runs it instead of toggling the row. */
  clockAction?(): (() => void) | undefined;
}

interface HeaderInputs {
  width: number; name: string; args: unknown; status: ToolSummary["status"]; images: number; count?: number; expanded?: boolean;
  label: string; background?: Color; theme: Theme;
}
const sameInputs = (a: HeaderInputs, b: HeaderInputs): boolean => a.width === b.width && a.name === b.name &&
  a.args === b.args && a.status === b.status && a.images === b.images && a.count === b.count && a.expanded === b.expanded && a.label === b.label && a.background === b.background && a.theme === b.theme;

/** A display-only call or group header; the original renderer owns the body. */
export class CompactTool implements Component {
  // Headers are rebuilt every frame for the whole history. Completed calls keep their
  // argument object, so reuse the row until a displayed input changes.
  private cached?: { inputs: HeaderInputs; lines: string[] };
  /** Columns of the clock in the last row, which a click may open in the other panel. */
  private clockSpan?: { start: number; end: number };
  private clockPressed = false;

  constructor(private readonly summary: () => ToolSummary, private readonly theme: () => Theme,
    private readonly options: CompactToolOptions = {}) {}

  render(width: number): string[] {
    width = Math.max(0, width - (this.options.gutter?.() ?? 0));
    const { name, args, status, images = 0 } = this.summary();
    const inputs: HeaderInputs = { width, name, args, status, images, count: this.options.count?.(),
      expanded: this.options.toggle ? this.options.expanded?.() : undefined, label: this.options.clock?.() ?? "",
      background: this.options.clockBackground?.(), theme: this.theme() };
    // Streamed arguments may be updated in place, so running calls always rebuild.
    if (this.cached && status !== "running" && sameInputs(this.cached.inputs, inputs)) return this.cached.lines;
    const lines = this.header(inputs);
    this.cached = { inputs, lines };
    return lines;
  }
  private header({ width, name, args, status, images, count, expanded, label, background, theme }: HeaderInputs): string[] {
    const dot = theme.fg(status === "running" ? "warning" : status === "unknown" ? "dim" : status, "●");
    const description = count ? "" : toolDescription(args);
    const control = this.options.toggle ? theme.fg("muted", expanded ? "▾" : "▸") + " " : this.options.alignControl ? "  " : "";
    // Before the description, so truncation keeps it: the collapsed row is the only sign of a hidden image.
    const attachment = images ? " " + theme.fg("accent", `(${images} ${images === 1 ? "image" : "images"})`) : "";
    const text = `${dot} ${control}${singleLine(name)}${count ? ` ×${count}` : ""}${attachment}${description ? " " + theme.fg("muted", description) : ""}`;
    const clock = label && width >= visibleWidth(label) + 8 ? label : "";
    const available = Math.max(0, width - 1 - (clock ? visibleWidth(clock) + 1 : 0));
    const body = truncateToWidth(text, available, "…");
    const gutter = width > 0 ? 1 : 0;
    this.clockSpan = clock ? { start: gutter, end: gutter + visibleWidth(clock) } : undefined;
    const shown = !clock ? "" : background ? theme.style(clock, { fg: "text", bg: background }) : theme.fg("dim", clock);
    return [(gutter ? " " : "") + (clock ? shown + " " : "") + body];
  }
  handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
    if (event.button !== "left") return undefined;
    const span = this.clockSpan;
    const action = span && event.y === 0 && event.x >= span.start && event.x < span.end ? this.options.clockAction?.() : undefined;
    if (!this.options.toggle && !action && !this.clockPressed) return undefined;
    if (event.type === "press") {
      this.clockPressed = action !== undefined;
      return { capture: true };
    }
    if (event.type === "click") {
      const pressed = this.clockPressed;
      this.clockPressed = false;
      if (event.x < 0 || event.x >= event.width || event.y !== 0) return { handled: true };
      if (pressed) {
        if (action) action();
        return { handled: true, render: true };
      }
      this.options.toggle?.();
      return { handled: true, render: true };
    }
    return { handled: true };
  }
  invalidate(): void { this.cached = undefined; }
}
