import { stripTerminalSequences, type Component, type Container } from "@earendil-works/pi-tui";

// Native components survive extension reload. Keep only routing metadata on them,
// not a module-owned registry that would lose their startup identity on reload.
const startupText = Symbol.for("pi-stereo-view.startup-notice");
type Notice = Component & { stale?: boolean; text?: string; [startupText]?: string };

/** Remember native notifications from initialization, without matching their wording. */
export class StartupNotices {
  constructor(private initializing = false) {}

  /** Close the session_start window after every extension's awaited handler finishes. */
  finish(source: Container, width: number): void {
    if (!this.initializing) return;
    for (const component of source.children) this.contains(component, width);
    this.initializing = false;
  }

  /** Route an unchanged startup notice; a reused status with new content is operational. */
  contains(component: Component, width: number): boolean {
    if (component.constructor.name !== "ThemedText") return false;
    const notice = component as Notice;
    if (!this.initializing && notice[startupText] === undefined) return false;
    if (notice.stale) notice.render(width);
    if (typeof notice.text !== "string") throw new Error("Pi's status text metadata is not supported");
    const text = stripTerminalSequences(notice.text);
    if (this.initializing) notice[startupText] = text;
    if (notice[startupText] === text) return true;
    delete notice[startupText];
    return false;
  }
}
