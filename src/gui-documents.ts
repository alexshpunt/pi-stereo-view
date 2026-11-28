import type { Component, TuiMouseButton, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Pane } from "./content.ts";
import type { NativeDocument, DocumentViewport } from "./native.ts";
import { guiSelectionCells, type GuiSelectionRow } from "./gui-selection-cells.ts";
import { GuiImages, type GuiImagePlacement } from "./gui-images.ts";
type TuiMouseDispatchTarget = NonNullable<ReturnType<NativeDocument["handleMouse"]>>["target"];
export type GuiPane = Pane | "combined";
type GuiDocument = Pick<NativeDocument, "setViewport" | "beginFrame" | "render" | "takeScrollShift" | "handleMouse" | "dispose"> &
  Partial<Pick<NativeDocument, "locate" | "setLazyBudget" | "settling">>;

/** Time per page for measuring offscreen entries while a panel's width has just changed or rows are still being measured. */
const SETTLE_BUDGET_MS = 30;
/** The steady budget of a document's pages. */
const STEADY_BUDGET_MS = 4;

export interface GuiViewport extends DocumentViewport { width: number }
export interface GuiDocumentPage {
  frame: number;
  total: number;
  top: number;
  width: number;
  height: number;
  /** How far the content above this viewport moved during this render. */
  scrollShift: number;
  /** Rows outside the viewport are still being measured, so the total can change; ask again soon. Absent when settled. */
  settling?: true;
  lines: readonly string[];
  selection: readonly GuiSelectionRow[];
  images: readonly GuiImagePlacement[];
  jump?: { serial: number; top: number };
}
export interface GuiMouse {
  type: "press" | "release" | "move" | "drag" | "wheel";
  button: TuiMouseButton;
  x: number;
  y: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  wheelDelta?: number;
  clickCount?: 1 | 2 | 3;
  cancel?: boolean;
}

type Frame = GuiDocumentPage & { viewport: GuiViewport };
type Gesture = { target: TuiMouseDispatchTarget; x: number; y: number; moved: boolean };

/**
 * Independent native history projections for a GUI. The caller owns the source index and must construct
 * separate NativeDocument instances, wired with the same preferences and callbacks as its terminal layout.
 * The caller must invalidate the affected pane whenever live source data or presentation changes, before
 * dispatching another input event. A page request replaces that pane's frame and cancels its gesture.
 */
export class GuiDocuments {
  private readonly frames: Partial<Record<GuiPane, Frame>> = {};
  private readonly viewports: Partial<Record<GuiPane, GuiViewport>> = {};
  private readonly gestures: Partial<Record<GuiPane, Gesture>> = {};
  /** The width of each panel's last page and whether that page left rows unmeasured. */
  private readonly lastWidths: Partial<Record<GuiPane, { width: number; settling: boolean }>> = {};
  private serial = 0;
  private readonly images = new GuiImages();
  private jumpSerial = 0;
  private pendingJump?: { pane: Pane; source: Component; serial: number };
  private readonly jumps: Partial<Record<Pane, { serial: number; top: number; at: number }>> = {};
  private disposed = false;

  constructor(private readonly documents: Record<Pane, GuiDocument> & { combined?: GuiDocument },
    private readonly beforeFrame: () => void = () => {},
    private readonly requestRender: () => void = () => {},
    private readonly focus: (target: TuiMouseDispatchTarget["component"]) => void = () => {}) {
    for (const pane of ["chat", "activity", "combined"] as const) {
      documents[pane]?.setViewport(() => this.viewports[pane], () => {
        this.invalidate(pane);
        this.requestRender();
      });
    }
  }

  /** Resolve the target when the destination GUI panel next supplies its width. */
  requestJump(pane: Pane, source: Component): void {
    this.pendingJump = { pane, source, serial: ++this.jumpSerial };
    this.invalidate(pane);
    this.requestRender();
  }

  page(pane: GuiPane, viewport: GuiViewport): GuiDocumentPage {
    if (this.disposed) throw new Error("Documents are closed");
    if (!this.documents[pane] || !Number.isSafeInteger(viewport.width) || viewport.width < 10 || viewport.width > 300 ||
        !Number.isSafeInteger(viewport.height) || viewport.height < 1 || viewport.height > 256 ||
        !Number.isSafeInteger(viewport.top) || viewport.top < 0 || viewport.top > Number.MAX_SAFE_INTEGER - 512 ||
        typeof viewport.following !== "boolean") {
      throw new RangeError("Invalid viewport");
    }
    this.invalidate(pane);
    const view = { ...viewport };
    this.viewports[pane] = view;
    this.beforeFrame();
    const document = this.documents[pane];
    // While the width changes or rows are still unmeasured, the first render measures more of them, so the total settles
    // in a page or two. Later renders of this page only converge on the tail and leave the rest as it is.
    const previous = this.lastWidths[pane];
    document.setLazyBudget?.(!previous || previous.width !== view.width || previous.settling ? SETTLE_BUDGET_MS : STEADY_BUDGET_MS);
    document.beginFrame();
    let lines = document.render(view.width);
    if (this.pendingJump?.pane === pane) {
      const request = this.pendingJump;
      this.pendingJump = undefined;
      const row = document.locate?.(request.source);
      if (row !== undefined) this.jumps[pane] = { serial: request.serial, top: Math.max(0, row - 1), at: Date.now() };
      document.beginFrame();
      lines = document.render(view.width);
    }
    if (view.following) {
      // Native layout can change its row count when the viewport moves. Converge on
      // the tail before publishing a frame, but bound work for live components.
      document.setLazyBudget?.(0);
      for (let attempt = 0; attempt < 3; attempt++) {
        const tail = Math.max(0, lines.length - view.height);
        if (view.top === tail) break;
        view.top = tail;
        document.beginFrame();
        lines = document.render(view.width);
      }
      // Rows still being measured can change the row count in the last render. Show that render's own last rows: a window
      // taken from the count before it would lie past the end or over rows not measured yet.
      view.top = Math.max(0, lines.length - view.height);
    }
    document.setLazyBudget?.(STEADY_BUDGET_MS);
    const settling = document.settling === true;
    this.lastWidths[pane] = { width: view.width, settling };
    const jump = pane === "combined" ? undefined : this.jumps[pane];
    if (jump && Date.now() - jump.at > 5000 && pane !== "combined") delete this.jumps[pane];
    const extracted = this.images.page(lines, view.top, view.height);
    const visible = extracted.lines;
    const frame: Frame = {
      frame: ++this.serial, top: view.top, width: view.width, height: view.height,
      total: lines.length, scrollShift: document.takeScrollShift(), ...(settling ? { settling: true as const } : {}),
      lines: visible, selection: visible.map(guiSelectionCells), images: extracted.images, viewport: view,
      ...(pane === "combined" ? {} : { jump: this.jumps[pane] }),
    };
    this.frames[pane] = frame;
    return { frame: frame.frame, top: frame.top, width: frame.width, height: frame.height,
      total: frame.total, scrollShift: frame.scrollShift, ...(frame.settling ? { settling: true as const } : {}), lines: frame.lines, selection: frame.selection, images: frame.images,
      ...(frame.jump ? { jump: frame.jump } : {}) };
  }

  imageChunk(id: string, offset: number, length: number): { data: string; total: number } | undefined {
    const cached = this.images.chunk(id, offset, length);
    if (cached || !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 1 || length > 524288) return cached;
    // A page can exceed the bounded image cache. Re-extract just the requested
    // image from its still-current native frame instead of retaining all payloads.
    for (const pane of ["chat", "activity", "combined"] as const) {
      const frame = this.frames[pane], document = this.documents[pane];
      if (!frame || !document || !frame.images.some(image => image.id === id)) continue;
      this.images.page(document.render(frame.width), frame.top, frame.height, id);
      const recovered = this.images.chunk(id, offset, length);
      if (recovered) return recovered;
    }
    return undefined;
  }

  /** Invalidates a geometry token and cancels any press before a document can change under it. */
  invalidate(pane?: GuiPane): void {
    for (const key of pane ? [pane] : ["chat", "activity", "combined"] as const) {
      delete this.frames[key];
      delete this.gestures[key];
    }
  }

  /** Inputs are local zero-based character cells. A release synthesizes a click if the pointer did not move. */
  mouse(pane: GuiPane, frameId: number, input: GuiMouse): boolean {
    const frame = this.frames[pane];
    const gesture = this.gestures[pane];
    if (!frame || frame.frame !== frameId || !Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y) ||
        !["press", "release", "move", "drag", "wheel"].includes(input.type) ||
        !["left", "middle", "right", "none"].includes(input.button) ||
        (input.wheelDelta !== undefined && (!Number.isFinite(input.wheelDelta) || Math.abs(input.wheelDelta) > 10000)) ||
        (input.clickCount !== undefined && ![1, 2, 3].includes(input.clickCount)) ||
        (input.cancel !== undefined && (typeof input.cancel !== "boolean" || input.type !== "release"))) return false;
    const outside = input.x < 0 || input.x >= frame.width || input.y < 0 || input.y >= frame.height || frame.top + input.y >= frame.total;
    // A sentinel move clears hover without treating arbitrary outside coordinates as hits.
    const leave = !gesture && input.type === "move" && input.button === "none" && input.x === -1 && input.y === -1;
    // Captured drags and releases may leave the pane; keep their coordinates bounded.
    if (outside && !leave && (!gesture || (input.type !== "drag" && input.type !== "move" && input.type !== "release") ||
        input.x < -frame.width || input.x >= frame.width * 2 || input.y < -frame.height || input.y >= frame.height * 2)) return false;
    const event: TuiMouseEvent = {
      type: input.type, button: input.button, x: input.x, y: leave ? -1 : frame.top + input.y,
      screenX: input.x, screenY: leave ? -1 : frame.top + input.y, width: frame.width, height: frame.total,
      shift: input.shift === true, alt: input.alt === true, ctrl: input.ctrl === true,
      ...(input.wheelDelta === undefined ? {} : { wheelDelta: input.wheelDelta }),
    };
    if (gesture && (input.x !== gesture.x || input.y !== gesture.y)) gesture.moved = true;
    const toTarget = (type: TuiMouseEvent["type"], target: TuiMouseDispatchTarget) => {
      const local = { ...event, type, x: event.screenX - target.originX, y: event.screenY - target.originY,
        width: target.width, height: target.height, ...(type === "click" ? { clickCount: input.clickCount ?? 1 } : {}) };
      return target.component.handleMouse?.(local);
    };
    if (gesture && (input.type === "drag" || input.type === "move" || input.type === "release")) {
      const result = toTarget(input.type, gesture.target);
      if (input.type === "release") {
        if (!gesture.moved && !input.cancel) toTarget("click", gesture.target);
        // A click may change the document's row layout even when the target does not request a render.
        this.invalidate(pane);
      }
      if (result?.render !== false || input.type === "release") this.requestRender();
      return true;
    }
    const result = this.documents[pane]?.handleMouse(event);
    if (result?.focus) this.focus(result.focusTarget ?? result.target.component);
    if (input.type === "press" && result?.target) this.gestures[pane] = { target: result.target, x: input.x, y: input.y, moved: false };
    if (result?.render ?? (result && input.type !== "move" && input.type !== "release")) this.requestRender();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.documents.chat.dispose();
    this.documents.activity.dispose();
    this.documents.combined?.dispose();
  }
}
