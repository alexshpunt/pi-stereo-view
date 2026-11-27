import type { TuiMouseButton, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Pane } from "./content.ts";
import type { NativeDocument, DocumentViewport } from "./native.ts";
import { guiSelectionCells, type GuiSelectionRow } from "./gui-selection-cells.ts";
import { GuiImages, type GuiImagePlacement } from "./gui-images.ts";
type TuiMouseDispatchTarget = NonNullable<ReturnType<NativeDocument["handleMouse"]>>["target"];
export type GuiPane = Pane | "combined";
type GuiDocument = Pick<NativeDocument, "setViewport" | "beginFrame" | "render" | "takeScrollShift" | "handleMouse" | "dispose">;

export interface GuiViewport extends DocumentViewport { width: number }
export interface GuiDocumentPage {
  frame: number;
  total: number;
  top: number;
  width: number;
  height: number;
  /** How far the content above this viewport moved during this render. */
  scrollShift: number;
  lines: readonly string[];
  selection: readonly GuiSelectionRow[];
  images: readonly GuiImagePlacement[];
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
  private serial = 0;
  private readonly images = new GuiImages();
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
    document.beginFrame();
    let lines = document.render(view.width);
    if (view.following) {
      // Native layout can change its row count when the viewport moves. Converge on
      // the tail before publishing a frame, but bound work for live components.
      for (let attempt = 0; attempt < 3; attempt++) {
        const tail = Math.max(0, lines.length - view.height);
        if (view.top === tail) break;
        view.top = tail;
        document.beginFrame();
        lines = document.render(view.width);
      }
    }
    const extracted = this.images.page(lines, view.top, view.height);
    const visible = extracted.lines;
    const frame: Frame = {
      frame: ++this.serial, top: view.top, width: view.width, height: view.height,
      total: lines.length, scrollShift: document.takeScrollShift(),
      lines: visible, selection: visible.map(guiSelectionCells), images: extracted.images, viewport: view,
    };
    this.frames[pane] = frame;
    return { frame: frame.frame, top: frame.top, width: frame.width, height: frame.height,
      total: frame.total, scrollShift: frame.scrollShift, lines: frame.lines, selection: frame.selection, images: frame.images };
  }

  imageChunk(id: string, offset: number, length: number): { data: string; total: number } | undefined {
    return this.images.chunk(id, offset, length);
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
        (input.clickCount !== undefined && ![1, 2, 3].includes(input.clickCount))) return false;
    const outside = input.x < 0 || input.x >= frame.width || input.y < 0 || input.y >= frame.height || frame.top + input.y >= frame.total;
    // Captured drags and releases may leave the pane; keep their coordinates bounded.
    if (outside && (!gesture || (input.type !== "drag" && input.type !== "move" && input.type !== "release") ||
        input.x < -frame.width || input.x >= frame.width * 2 || input.y < -frame.height || input.y >= frame.height * 2)) return false;
    const event: TuiMouseEvent = {
      type: input.type, button: input.button, x: input.x, y: frame.top + input.y,
      screenX: input.x, screenY: frame.top + input.y, width: frame.width, height: frame.total,
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
        if (!gesture.moved) toTarget("click", gesture.target);
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
