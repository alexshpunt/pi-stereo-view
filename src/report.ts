import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

export const ISSUES_URL = "https://github.com/alexshpunt/pi-stereo-view/issues";
/** GitHub rejects longer new-issue links; long stacks lose their last frames first. */
const MAX_URL_LENGTH = 7000;
const MAX_STACK_LINES = 15;
const WIDGET = "pi-stereo-view-problem";

/** Something that stopped the split: an unexpected error, or a Pi layout the extension cannot use. */
export interface Problem {
  /** What happened, in a few words, for the user. */
  summary: string;
  error?: unknown;
}

export interface ProblemReport {
  title: string;
  /** Issue body with the error, its stack and versions. */
  body: string;
  /** New-issue link with the title and body filled in. */
  url: string;
}

function extensionVersion(): string {
  try {
    const value: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const version = (value as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Pi's version, whether it is the Pi-Bolt build, the runtime and the platform. */
function hostDescription(): string {
  const bolt = /pi-bolt/i.test(process.execPath) ? " (Pi-Bolt)" : "";
  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`;
  return `Pi ${VERSION}${bolt}, ${runtime}, ${process.platform}-${process.arch}`;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : error === undefined ? "" : String(error);

/** Stack frames without the user's home folder, which appears in every installed extension path. */
function stackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || !error.stack) return [];
  const home = homedir();
  return error.stack.split("\n").slice(1).map(line => line.trim()).filter(Boolean)
    .map(line => home ? line.replaceAll(home, "~") : line).slice(0, MAX_STACK_LINES);
}

/** Build the issue a user can review and submit; nothing is sent automatically. */
export function problemReport(problem: Problem): ProblemReport {
  const message = errorMessage(problem.error);
  const title = truncateToWidth(message || problem.summary, 100, "…");
  const frames = stackFrames(problem.error);
  const body = (lines: string[]): string => [
    "### What happened",
    problem.summary,
    "",
    ...(message ? ["### Error", "```text", message, ...lines, "```", ""] : []),
    "### Environment",
    `- pi-stereo-view ${extensionVersion()}`,
    `- ${hostDescription()}`,
    "",
    "### What I was doing",
    "<!-- For example: streaming a reply, switching to Combined, resizing the terminal. -->",
    "",
  ].join("\n");
  const link = (text: string): string =>
    `${ISSUES_URL}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
  let shown = frames;
  while (shown.length && link(body(shown)).length > MAX_URL_LENGTH) shown = shown.slice(0, -1);
  return { title, body: body(frames), url: link(body(shown)) };
}

const hyperlink = (url: string, text: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

type Action = "open" | "copy" | "close";
const ACTIONS: { action: Action; label: string }[] = [
  { action: "open", label: "[Open issue]" },
  { action: "copy", label: "[Copy report]" },
  { action: "close", label: "[Close]" },
];

/**
 * Widget above the editor that names the problem and offers a prefilled GitHub issue. It stays until closed,
 * because a short notification is easy to miss while the split silently falls back to combined history.
 */
export class ProblemPanel implements Component {
  private actionsRow = -1;
  private readonly spans: { action: Action; start: number; end: number }[] = [];

  constructor(
    private readonly problem: Problem,
    private readonly report: ProblemReport,
    private readonly theme: Theme,
    private readonly act: (action: Action) => void,
  ) {}

  render(width: number): string[] {
    const theme = this.theme;
    const message = errorMessage(this.problem.error);
    const inner = Math.max(1, width - 3);
    const wrap = (text: string): string[] => wrapTextWithAnsi(text, inner).map(line => "   " + line);
    const lines = [
      truncateToWidth(" " + theme.fg("warning", "⚠ ") + theme.bold("pi-stereo-view " + this.problem.summary), width),
      ...(message ? wrap(theme.fg("muted", message)) : []),
      ...wrap(theme.fg("dim", "Pi keeps working with its own history view. Please report this so it can be fixed:")),
      truncateToWidth("   " + hyperlink(ISSUES_URL, theme.fg("accent", ISSUES_URL)), width),
    ];
    this.spans.length = 0;
    let column = 3;
    let row = "   ";
    for (const { action, label } of ACTIONS) {
      const text = action === "open" ? hyperlink(this.report.url, theme.fg("accent", label)) : theme.fg("accent", label);
      this.spans.push({ action, start: column, end: column + visibleWidth(label) });
      row += text + " ";
      column += visibleWidth(label) + 1;
    }
    this.actionsRow = lines.length;
    lines.push(truncateToWidth(row, width));
    return lines;
  }

  handleMouse(event: TuiMouseEvent): { handled: true; render?: boolean } | { capture: true } | undefined {
    if (event.button !== "left" || event.y !== this.actionsRow) return undefined;
    const span = this.spans.find(candidate => event.x >= candidate.start && event.x < candidate.end);
    if (!span) return undefined;
    // Like Pi's own buttons: capture the press, act on the click that follows its release.
    if (event.type === "press") return { capture: true };
    if (event.type === "click") {
      this.act(span.action);
      return { handled: true, render: true };
    }
    return { handled: true };
  }

  invalidate(): void {}
}

/** Show one problem at a time and never reopen a problem the user closed in this session. */
export class ProblemReporter {
  private readonly closed = new Set<string>();
  private current?: string;

  constructor(private readonly ui: {
    setWidget(key: string, content: ((tui: TUI, theme: Theme) => Component) | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  }, private readonly copy: (text: string) => Promise<void>) {}

  show(problem: Problem): void {
    const key = problem.summary + "\n" + errorMessage(problem.error);
    if (this.closed.has(key) || this.current === key) return;
    this.current = key;
    const report = problemReport(problem);
    this.ui.setWidget(WIDGET, (tui, theme) => new ProblemPanel(problem, report, theme, action => {
      if (action === "close") {
        this.closed.add(key);
        this.clear();
        return;
      }
      if (action === "open") {
        const open = Reflect.get(tui, "openUrl") as ((url: string) => void) | undefined;
        if (typeof open === "function") {
          try { open.call(tui, report.url); return; } catch { /* Fall back to copying the link. */ }
        }
        void this.copy(report.url).then(() => this.ui.notify("Issue link copied to the clipboard.", "info"),
          error => this.ui.notify("Could not copy the issue link: " + String(error), "error"));
        return;
      }
      void this.copy(report.body).then(() => this.ui.notify("Problem report copied to the clipboard.", "info"),
        error => this.ui.notify("Could not copy the problem report: " + String(error), "error"));
    }));
  }

  clear(): void {
    this.current = undefined;
    this.ui.setWidget(WIDGET, undefined);
  }
}
