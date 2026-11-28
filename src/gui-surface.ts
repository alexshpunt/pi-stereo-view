import type { Component } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { dispatchMouseEvent, type Dispatched } from "./mouse-dispatch.ts";

export type SurfacePointer = {
  type: "press" | "release" | "drag" | "move" | "wheel";
  button: "left" | "middle" | "right" | "none";
  x: number; y: number;
  shift?: boolean; alt?: boolean; ctrl?: boolean;
  wheelDelta?: number; clickCount?: number; cancel?: boolean;
};

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
  private gestures = new Map<SurfacePointer["button"], { target: Dispatched["target"]; x: number; y: number; moved: boolean; clickCount: number }>();

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
      this.gestures.clear();
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
        this.gestures.clear();
      }
      if (lines.length > 256 || lines.some(line => typeof line !== "string") ||
          lines.reduce((size, line) => size + Buffer.byteLength(line), 0) > 2 * 1024 * 1024) throw new Error("Surface is too large");
      if (lines.length !== this.painted.length || lines.some((line, index) => line !== this.painted[index])) {
        this.painted = [...lines];
        this.mouseSerial++;
        this.gestures.clear();
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

  /** Send pointer input only to the exact surface that was painted. */
  mouse(frame: number, input: SurfacePointer, origin: { x: number; y: number } = { x: 0, y: 0 }): boolean {
    const owner = this.owner, focused = this.focus() ?? undefined;
    const captured = input.type === "drag" || input.type === "release";
    const button = input.button;
    if (this.disposed || !owner || this.dialog() !== owner || focused !== this.focused ||
        (!this.passive && (!focused || !contains(owner, focused))) || !sameComponents(descendants(owner), this.structure) ||
        frame !== this.mouseSerial || !Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y) ||
        Math.abs(input.x) > 1000000 || Math.abs(input.y) > 1000000 ||
        (!captured && (input.x < 0 || input.x >= this.width || input.y < 0 || input.y >= this.painted.length)) ||
        !["press", "release", "drag", "move", "wheel"].includes(input.type) ||
        ((input.type === "move" || input.type === "wheel") ? button !== "none" : !["left", "middle", "right"].includes(button)) ||
        [input.shift, input.alt, input.ctrl].some(value => value !== undefined && typeof value !== "boolean") ||
        (input.type === "wheel" ? !Number.isSafeInteger(input.wheelDelta) || !input.wheelDelta || Math.abs(input.wheelDelta) > 10000 : input.wheelDelta !== undefined) ||
        (input.clickCount !== undefined && (![1, 2, 3].includes(input.clickCount) || input.type !== "press")) ||
        (input.cancel !== undefined && (input.type !== "release" || typeof input.cancel !== "boolean"))) return false;
    const gesture = captured ? this.gestures.get(button) : undefined;
    if (captured && !gesture) return false;
    try {
      const lines = owner.render(this.width);
      if (!captured && (lines.length !== this.painted.length || lines.some((line, i) => line !== this.painted[i]))) return false;
      const event: TuiMouseEvent = { type: input.type, button, x: input.x, y: input.y,
        screenX: input.x + origin.x, screenY: input.y + origin.y, width: this.width, height: lines.length,
        shift: input.shift ?? false, alt: input.alt ?? false, ctrl: input.ctrl ?? false,
        ...(input.wheelDelta === undefined ? {} : { wheelDelta: input.wheelDelta }),
        ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount }) };
      if (input.type === "move" || input.type === "wheel") return !!dispatchMouseEvent(owner, event);
      if (input.type === "press") {
        if (this.gestures.has(button)) return false;
        const result = dispatchMouseEvent(owner, event);
        if (!result) return false;
        const target = result.focusTarget ?? result.target.component;
        if (result.focus && contains(owner, target)) {
          this.setFocus(target);
          this.focused = this.focus() ?? undefined;
          this.serial++;
        }
        this.gestures.set(button, { target: result.target, x: input.x, y: input.y, moved: false, clickCount: input.clickCount ?? 1 });
        return true;
      }
      if (!gesture) return false;
      if (input.x !== gesture.x || input.y !== gesture.y) gesture.moved = true;
      const local = { ...event, x: event.screenX - gesture.target.originX, y: event.screenY - gesture.target.originY,
        width: gesture.target.width, height: gesture.target.height };
      gesture.target.component.handleMouse?.(local);
      if (input.type === "release") {
        this.gestures.delete(button);
        if (!gesture.moved && !input.cancel) gesture.target.component.handleMouse?.({ ...local, type: "click", clickCount: gesture.clickCount });
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
