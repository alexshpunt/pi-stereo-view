import type { TUI } from "@earendil-works/pi-tui";

/** Wait for an actual synchronized native frame, optionally after a readiness change. */
export function emittedFrame(tui: TUI, action: () => void, ready = (): boolean => true): Promise<void> {
  return new Promise((resolve, reject) => {
    const write = tui.terminal.write;
    const restore = (): void => {
      if (tui.terminal.write === observe) tui.terminal.write = write;
      clearTimeout(timeout);
    };
    const observe = (data: string): void => {
      write.call(tui.terminal, data);
      if (data.includes("\x1b[?2026l") && ready()) { restore(); resolve(); }
    };
    const timeout = setTimeout(() => { restore(); reject(new Error("No ready native frame within 30s")); }, 30_000);
    tui.terminal.write = observe;
    try { action(); }
    catch (error) { restore(); reject(error); }
  });
}
