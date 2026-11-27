import type { Component } from "@earendil-works/pi-tui";

/** A borrowed native dialog. Pi retains its lifecycle and keyboard focus. */
export class GuiSurface {
  private serial = 0;
  private owner?: Component;
  private focused?: Component;
  private width = 0;
  private disposed = false;

  constructor(private readonly dialog: () => Component | undefined,
    private readonly focus: () => Component | null,
    private readonly requestRender: () => void = () => {}) {}

  page(width: number): { frame: number; active: boolean; lines: string[] } {
    if (this.disposed || !Number.isSafeInteger(width) || width < 10 || width > 300) throw new RangeError("Invalid surface width");
    const owner = this.dialog();
    const focused = this.focus() ?? undefined;
    if (owner !== this.owner || focused !== this.focused || width !== this.width) {
      this.owner = owner;
      this.focused = focused;
      this.width = width;
      this.serial++;
    }
    if (!owner) return { frame: this.serial, active: false, lines: [] };
    try {
      const lines = owner.render(width);
      if (lines.length > 256 || lines.some(line => typeof line !== "string") ||
          lines.reduce((size, line) => size + Buffer.byteLength(line), 0) > 2 * 1024 * 1024) throw new Error("Surface is too large");
      return { frame: this.serial, active: true, lines: [...lines] };
    } finally {
      // The GUI width can differ from the terminal. Repaint Pi's own geometry.
      this.requestRender();
    }
  }

  key(frame: number, data: string): boolean {
    if (this.disposed || !Number.isSafeInteger(frame) || frame !== this.serial || !this.owner ||
        typeof data !== "string" || data.length < 1 || data.length > 1024 || data.includes("\0")) return false;
    const owner = this.dialog(), focused = this.focus();
    if (owner !== this.owner || !focused || focused !== this.focused || !contains(owner, focused) ||
        typeof focused.handleInput !== "function") return false;
    focused.handleInput(data);
    this.requestRender();
    return true;
  }

  dispose(): void { this.disposed = true; this.owner = undefined; this.focused = undefined; }
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
