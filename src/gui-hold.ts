import { execFile } from "node:child_process";
import type { Component } from "@earendil-works/pi-tui";

/** Terminal label the Herdr App reads: while it has text, the pane shows the terminal instead of the GUI. */
export const HOLD_LABEL = "herdr.view.unavailable";
/** What the App prints over the terminal while the GUI cannot show Pi's screen. */
export const HOLD_REASON = "Pi opened a screen the GUI can't show";

export function publishTerminalLabel(terminal: string, name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.env.HC_BIN || "hc", ["label", terminal, `${name}=${value}`], { timeout: 4000, windowsHide: true }, error => {
      if (error) reject(error); else resolve();
    });
  });
}

type Host = {
  stop(...args: unknown[]): unknown;
  start(...args: unknown[]): unknown;
  getFocusedComponent(): Component | null;
};

/**
 * Tells Herdr while Pi shows a screen the GUI cannot draw: its terminal is handed to a child program
 * (Pi's `stop()` until `start()`), or the focused component is outside everything the bridge projects.
 * The App then shows the terminal and returns to the GUI when the label is cleared. A focus-based hold
 * needs two polls in a row, so a focus handover inside Pi does not flash the terminal.
 */
export class GuiHold {
  private stopped = false;
  private pending = false;
  private held = false;
  private disposed = false;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private restore: Array<() => void> = [];

  constructor(private readonly host: () => Host | undefined, private readonly projectable: (focused: Component) => boolean,
    private readonly publish: (reason: string) => Promise<void>, private readonly interval = 200) {}

  /** Start watching. Clears a label a previous process left behind. */
  async start(): Promise<void> {
    const host = this.host();
    if (host) this.wrap(host);
    await this.send("");
    this.timer = setInterval(() => this.evaluate(), this.interval);
    this.timer.unref();
  }

  private wrap(host: Host): void {
    const { stop, start } = host;
    host.stop = (...args) => { this.stopped = true; this.evaluate(true); return stop.apply(host, args); };
    host.start = (...args) => { const result = start.apply(host, args); this.stopped = false; this.evaluate(); return result; };
    this.restore.push(() => { host.stop = stop; host.start = start; });
  }

  /** Re-check now. `immediate` skips the two-poll rule for a terminal handed to a child program. */
  evaluate(immediate = false): void {
    if (this.disposed) return;
    const focused = this.host()?.getFocusedComponent() ?? null;
    const unprojectable = this.stopped || (focused !== null && !this.projectable(focused));
    if (!unprojectable) { this.pending = false; if (this.held) this.set(false); return; }
    if (this.held) return;
    if (immediate || this.stopped || this.pending) this.set(true);
    else this.pending = true;
  }

  private set(held: boolean): void {
    this.held = held;
    this.pending = false;
    void this.send(held ? HOLD_REASON : "");
  }

  /** Label writes keep their order. A failed one is dropped; the next change writes again. */
  private send(reason: string): Promise<void> {
    this.chain = this.chain.then(() => this.publish(reason)).catch(() => undefined);
    return this.chain;
  }

  /** Resolves once every label write so far has finished. */
  idle(): Promise<void> { return this.chain; }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const undo of this.restore) undo();
    this.restore = [];
    await this.send("");
  }
}
