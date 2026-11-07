import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Keep hierarchy guides outside native rendering and pointer coordinates. */
export class ToolIndent extends Container {
  private readonly prefix: string;
  constructor(component: Component, depth: number, body: boolean, private readonly theme: () => Theme, gutter = 0) {
    super(); this.addChild(component);
    this.prefix = " ".repeat(gutter) + " │".repeat(depth) + (body ? " " : "");
  }
  // Expanded runs are re-indented on every frame; reuse rows while the native rows are unchanged.
  private cached?: { width: number; prefix: string; source: string[]; lines: string[] };
  override render(width: number): string[] {
    const inset = Math.min(width, this.prefix.length);
    const prefix = this.theme().fg("dim", this.prefix.slice(0, inset));
    const source = super.render(Math.max(0, width - inset));
    const cached = this.cached;
    if (cached && cached.width === width && cached.prefix === prefix && cached.source.length === source.length &&
      cached.source.every((line, index) => line === source[index])) return cached.lines;
    const lines = source.map(line => truncateToWidth(prefix + line, width, ""));
    this.cached = { width, prefix, source, lines };
    return lines;
  }
  override invalidate(): void {
    this.cached = undefined;
    super.invalidate();
  }
  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const inset = Math.min(event.width, this.prefix.length);
    if (event.x < inset) return undefined;
    return super.handleMouse({ ...event, x: event.x - inset, width: Math.max(0, event.width - inset) });
  }
}
