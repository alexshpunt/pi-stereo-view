import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Keep hierarchy guides outside native rendering and pointer coordinates. */
export class ToolIndent extends Container {
  private readonly prefix: string;
  constructor(component: Component, depth: number, body: boolean, private readonly theme: () => Theme, gutter = 0) {
    super(); this.addChild(component);
    this.prefix = " ".repeat(gutter) + " │".repeat(depth) + (body ? " " : "");
  }
  override render(width: number): string[] {
    const inset = Math.min(width, this.prefix.length);
    const prefix = this.theme().fg("dim", this.prefix.slice(0, inset));
    return super.render(Math.max(0, width - inset)).map(line => truncateToWidth(prefix + line, width, ""));
  }
  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const inset = Math.min(event.width, this.prefix.length);
    if (event.x < inset) return undefined;
    return super.handleMouse({ ...event, x: event.x - inset, width: Math.max(0, event.width - inset) });
  }
}
