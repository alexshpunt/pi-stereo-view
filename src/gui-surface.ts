import type { Component } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { dispatchMouseEvent, type Dispatched } from "./mouse-dispatch.ts";

/** A borrowed native dialog. Pi retains its lifecycle and keyboard focus. */
export class GuiSurface {
  private serial = 0;
  private owner?: Component;
  private focused?: Component;
  private width = 0;
  private disposed = false;
  private mouseSerial = 0;
  private painted: string[] = [];
  private structure: Component[] = [];
  private gesture?: { target: Dispatched["target"]; x: number; y: number; moved: boolean };

  constructor(private readonly dialog: () => Component | undefined,
    private readonly focus: () => Component | null,
    private readonly requestRender: () => void = () => {},
    private readonly setFocus: (component: Component) => void = () => {},
    private readonly passive = false,
    private readonly terminalWidth: () => number | undefined = () => undefined) {}

  private restore(owner: Component): void {
    try {
      const width = this.terminalWidth();
      if (this.dialog() === owner && Number.isSafeInteger(width) && width! > 0 && width !== this.width) owner.render(width!);
    } finally { this.requestRender(); }
  }

  page(width: number): { frame: number; mouseFrame: number; active: boolean; focused: boolean; lines: string[] } {
    if (this.disposed || !Number.isSafeInteger(width) || width < 1 || width > 4096) throw new RangeError("Invalid surface width");
    const owner = this.dialog();
    const focused = this.focus() ?? undefined;
    if (owner !== this.owner || focused !== this.focused || width !== this.width) {
      this.owner = owner;
      this.focused = focused;
      this.width = width;
      this.serial++;
      this.mouseSerial++;
      this.gesture = undefined;
      this.painted = [];
    }
    if (!owner) return { frame: this.serial, mouseFrame: this.mouseSerial, active: false, focused: false, lines: [] };
    try {
      const lines = owner.render(width);
      const structure = descendants(owner);
      if (!sameComponents(structure, this.structure)) {
        this.structure = structure;
        this.serial++;
        this.mouseSerial++;
        this.gesture = undefined;
      }
      if (lines.length > 256 || lines.some(line => typeof line !== "string") ||
          lines.reduce((size, line) => size + Buffer.byteLength(line), 0) > 2 * 1024 * 1024) throw new Error("Surface is too large");
      if (lines.length !== this.painted.length || lines.some((line, index) => line !== this.painted[index])) {
        this.painted = [...lines];
        this.mouseSerial++;
        this.gesture = undefined;
      }
      return { frame: this.serial, mouseFrame: this.mouseSerial, active: true, focused: !!focused && contains(owner, focused), lines: [...lines] };
    } finally {
      this.restore(owner);
    }
  }

  /** Check the exact borrowed component and focus without delivering input. */
  accepts(frame: number): boolean {
    if (this.disposed || !Number.isSafeInteger(frame) || frame !== this.serial || !this.owner) return false;
    const owner = this.dialog(), focused = this.focus();
    return !!owner && owner === this.owner && !!focused && focused === this.focused &&
      sameComponents(descendants(owner), this.structure) && contains(owner, focused) && typeof focused.handleInput === "function";
  }

  key(frame: number, data: string): boolean {
    if (typeof data !== "string" || data.length < 1 || data.includes("\0")) return false;
    const pasted = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~");
    if (pasted ? data.slice(6, -6).includes("\x1b") || Buffer.byteLength(data) > 1024 * 1024 + 12 : data.length > 1024) return false;
    if (!this.accepts(frame)) return false;
    const focused = this.focus()!;
    focused.handleInput!(data);
    this.requestRender();
    return true;
  }

  /** Send a pointer gesture only to the exact surface that was painted. */
  mouse(frame: number, input: { type: "press" | "release" | "drag"; button: "left"; x: number; y: number; cancel?: boolean },
    origin: { x: number; y: number } = { x: 0, y: 0 }): boolean {
    const owner = this.owner, focused = this.focus() ?? undefined;
    if (this.disposed || !owner || this.dialog() !== owner || focused !== this.focused ||
        (!this.passive && (!focused || !contains(owner, focused))) || !sameComponents(descendants(owner), this.structure) || frame !== this.mouseSerial || !Number.isSafeInteger(input.x) ||
        !Number.isSafeInteger(input.y) || input.x < 0 || input.x >= this.width || input.y < 0 ||
        input.y >= this.painted.length || input.button !== "left" || !["press", "release", "drag"].includes(input.type)) return false;
    try {
      const lines = owner.render(this.width);
      if (!this.gesture && (lines.length !== this.painted.length || lines.some((line, i) => line !== this.painted[i]))) return false;
      const event: TuiMouseEvent = { type: input.type, button: input.button, x: input.x, y: input.y,
        screenX: input.x + origin.x, screenY: input.y + origin.y, width: this.width, height: lines.length, shift: false, alt: false, ctrl: false };
      if (input.type === "press") {
        const result = dispatchMouseEvent(owner, event);
        if (!result) return false;
        const target = result.focusTarget ?? result.target.component;
        if (result.focus && contains(owner, target)) {
          this.setFocus(target);
          this.focused = this.focus() ?? undefined;
          this.serial++;
        }
        this.gesture = { target: result.target, x: input.x, y: input.y, moved: false };
        return true;
      }
      const gesture = this.gesture;
      if (!gesture) return false;
      if (input.x !== gesture.x || input.y !== gesture.y) gesture.moved = true;
      const local = { ...event, x: event.screenX - gesture.target.originX, y: event.screenY - gesture.target.originY,
        width: gesture.target.width, height: gesture.target.height };
      gesture.target.component.handleMouse?.(local);
      if (input.type === "release") {
        this.gesture = undefined;
        if (!gesture.moved && !input.cancel) gesture.target.component.handleMouse?.({ ...local, type: "click", clickCount: 1 });
      }
      return true;
    } finally { this.restore(owner); }
  }

  dispose(): void { this.disposed = true; this.owner = undefined; this.focused = undefined; }
}

function descendants(root: Component): Component[] {
  const result: Component[] = [], pending = [root], seen = new Set<Component>();
  while (pending.length && seen.size < 10000) {
    const component = pending.pop()!;
    if (seen.has(component)) continue;
    seen.add(component); result.push(component);
    const children = (component as Component & { children?: unknown }).children;
    if (Array.isArray(children)) for (const child of children) {
      if (child && typeof child === "object") pending.push(child as Component);
    }
  }
  return result;
}
function sameComponents(a: Component[], b: Component[]): boolean {
  return a.length === b.length && a.every((component, index) => component === b[index]);
}
/** Focus may belong to a child control, but never to an unrelated Pi overlay or editor. */
function contains(root: Component, target: Component): boolean {
  const pending: Component[] = [root], seen = new Set<Component>();
  while (pending.length && seen.size < 10000) {
    const component = pending.pop()!;
    if (component === target) return true;
    if (seen.has(component)) continue;
    seen.add(component);
    const children = (component as Component & { children?: unknown }).children;
    if (Array.isArray(children)) for (const child of children) {
      if (child && typeof child === "object") pending.push(child as Component);
    }
  }
  return false;
}
