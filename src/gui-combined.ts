import type { Component, Container, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { DocumentViewport } from "./native.ts";
import { dispatchMouseEvent, type Dispatched } from "./mouse-dispatch.ts";

/**
 * The original Pi history in combined mode. Pi retains ownership of the container and its children.
 *
 * Native components cache their most recent width. Restore the terminal's content width after each
 * GUI render or input dispatch, including captured events, so the two views don't leave each other
 * with the wrong hit-test geometry. The caller must supply the original ScrollView's content width,
 * not merely the terminal width. Use only while that ScrollView is mounted.
 *
 * This adapts Pi's original container; unlike NativeDocument, it renders the whole history before
 * GuiDocuments slices the requested viewport. It cannot virtualize components that Pi does not expose
 * individually, and arbitrary extensions can have render side effects beyond width caches.
 */
export class GuiCombinedDocument {
  private width?: number;
  private closed = false;

  constructor(private readonly source: Container, private readonly terminalWidth: () => number) {}

  beginFrame(): void {}
  setViewport(_provider: (() => DocumentViewport | undefined) | undefined, _requestRender?: () => void): void {}
  takeScrollShift(): number { return 0; }

  private atWidth<T>(width: number, run: (lines: readonly string[]) => T): T {
    if (this.closed) throw new Error("Document is closed");
    const terminal = this.terminalWidth();
    if (!Number.isSafeInteger(terminal) || terminal < 1 || !Number.isSafeInteger(width) || width < 1) {
      throw new RangeError("Invalid width");
    }
    try {
      return run(this.source.render(width));
    } finally {
      if (terminal !== width) this.source.render(terminal);
    }
  }

  render(width: number): string[] {
    this.width = width;
    // Snapshot the output before restoring the terminal's layout caches.
    return this.atWidth(width, lines => Array.from(lines));
  }

  handleMouse(event: TuiMouseEvent): Dispatched | undefined {
    const width = this.width;
    if (width === undefined || event.width !== width) return undefined;
    const result = this.atWidth(width, () => dispatchMouseEvent(this.source, event));
    if (!result) return undefined;
    const target = result.target;
    const component = target.component;
    // GuiDocuments sends captured releases and clicks straight to the target. Prepare the GUI width
    // for those calls as well, then restore Pi's caches as for the initial dispatch.
    const relay: Component = {
      render: requested => component.render(requested),
      invalidate: () => {},
      handleMouse: input => this.atWidth(width, () => component.handleMouse?.(input)),
    };
    return {
      ...result,
      ...(result.focus && !result.focusTarget ? { focusTarget: component } : {}),
      target: { ...target, component: relay },
    };
  }

  /** Drop this adapter without clearing, invalidating or disposing Pi's live component tree. */
  dispose(): void { this.closed = true; }
}
