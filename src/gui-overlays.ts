import type { Component } from "@earendil-works/pi-tui";
import { GuiSurface, type SurfacePointer } from "./gui-surface.ts";

type Entry = { component: Component; focusOrder?: number };
type Layout = { entry: Entry; row: number; col: number; width: number; height: number };
type Host = {
  terminal: { columns: number; rows: number };
  renderedOverlayLayouts: Layout[];
  overlayStack?: Entry[];
  isOverlayVisible?(entry: Entry): boolean;
  getFocusedComponent(): Component | null;
  setFocus(component: Component): void;
  resolveMouseFocusTarget?(component: Component): Component;
  requestRender(): void;
  resolveFakeCursors?(lines: readonly string[]): string[];
  applyLineResets?(lines: string[]): string[];
};
type SurfaceRecord = { id: number; surface: GuiSurface };
type Snapshot = { entry: Entry; row: number; col: number; width: number; height: number };

/** Borrow Pi's painted overlay layers and their actual terminal-relative geometry. */
export class GuiOverlays {
  private records = new Map<Entry, SurfaceRecord>();
  private nextId = 1;
  private revision = 0;
  private snapshot: Snapshot[] = [];
  private columns = 0;
  private rows = 0;
  private disposed = false;

  constructor(private readonly host: Host) {}

  private layouts(): Layout[] {
    return (this.host.renderedOverlayLayouts ?? []).filter(layout =>
      (!this.host.overlayStack || this.host.overlayStack.includes(layout.entry)) &&
      (!this.host.isOverlayVisible || this.host.isOverlayVisible(layout.entry)));
  }

  private unchanged(layouts: Layout[]): boolean {
    const visible = this.host.overlayStack?.filter(entry => !this.host.isOverlayVisible || this.host.isOverlayVisible(entry));
    visible?.sort((a, b) => (a.focusOrder ?? 0) - (b.focusOrder ?? 0));
    return (!visible || (visible.length === layouts.length && visible.every((entry, index) => layouts[index].entry === entry))) &&
      this.columns === this.host.terminal.columns && this.rows === this.host.terminal.rows &&
      layouts.length === this.snapshot.length && layouts.every((layout, index) => {
        const old = this.snapshot[index];
        return layout.entry === old.entry && layout.row === old.row && layout.col === old.col &&
          layout.width === old.width && layout.height === old.height;
      });
  }

  page() {
    if (this.disposed) throw new Error("Overlay projection is closed");
    const layouts = this.layouts();
    if (!this.unchanged(layouts)) {
      this.columns = this.host.terminal.columns;
      this.rows = this.host.terminal.rows;
      this.snapshot = layouts.map(({ entry, row, col, width, height }) => ({ entry, row, col, width, height }));
      this.revision++;
    }
    const live = new Set(layouts.map(layout => layout.entry));
    for (const [entry, record] of this.records) if (!live.has(entry)) {
      record.surface.dispose(); this.records.delete(entry);
    }
    const overlays = layouts.map(({ entry, row, col, width, height }) => {
      let record = this.records.get(entry);
      if (!record) {
        const surface = new GuiSurface(() => this.layouts().some(layout => layout.entry === entry) ? entry.component : undefined,
          () => this.host.getFocusedComponent(), () => this.host.requestRender(), component =>
            this.host.setFocus(this.host.resolveMouseFocusTarget?.(component) ?? component), true,
          () => this.layouts().find(layout => layout.entry === entry)?.width);
        record = { id: this.nextId++, surface };
        this.records.set(entry, record);
      }
      const page = record.surface.page(width);
      const resolved = this.host.resolveFakeCursors?.(page.lines) ?? [...page.lines];
      const lines = this.host.applyLineResets?.(resolved) ?? resolved;
      return { id: record.id, frame: page.frame, mouseFrame: page.mouseFrame, focused: page.focused,
        row, col, width, height, lines: lines.slice(0, height) };
    });
    return { revision: this.revision, columns: this.columns, rows: this.rows, overlays };
  }

  /** Validate the visible overlay and its focused component without delivering input. */
  accepts(revision: number, id: number, frame: number): boolean {
    if (this.disposed || revision !== this.revision || !this.unchanged(this.layouts())) return false;
    const record = [...this.records.values()].find(value => value.id === id);
    return record?.surface.accepts(frame) ?? false;
  }

  key(revision: number, id: number, frame: number, data: string): boolean {
    if (!this.accepts(revision, id, frame)) return false;
    const record = [...this.records.values()].find(value => value.id === id);
    return record?.surface.key(frame, data) ?? false;
  }

  mouse(revision: number, id: number, frame: number, event: SurfacePointer): boolean {
    if (this.disposed || revision !== this.revision || !this.unchanged(this.layouts())) return false;
    const index = this.snapshot.findIndex(layout => this.records.get(layout.entry)?.id === id);
    if (index < 0) return false;
    const target = this.snapshot[index], x = target.col + event.x, y = target.row + event.y;
    if (((event.type !== "drag" && event.type !== "release") && (event.x < 0 || event.y < 0 || event.x >= target.width || event.y >= target.height)) ||
        ((event.type === "press" || event.type === "move" || event.type === "wheel") && this.snapshot.slice(index + 1).some(layer => x >= layer.col && x < layer.col + layer.width &&
          y >= layer.row && y < layer.row + layer.height))) return false;
    return this.records.get(target.entry)?.surface.mouse(frame, event, { x: target.col, y: target.row }) ?? false;
  }

  dispose(): void {
    this.disposed = true;
    for (const record of this.records.values()) record.surface.dispose();
    this.records.clear();
  }
}
