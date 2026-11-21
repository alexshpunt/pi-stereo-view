import { wrapTextWithAnsi, type Component, type SettingItem, type SettingsList, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Rows of Pi's settings list under its items: a blank row and the key hint. */
const HINT_ROWS = 2;

/**
 * Keep a settings list at one height while the selection moves. Pi's list shows the selected item's description
 * between the items and the key hint, so its height follows the description's length; a centered overlay then jumps.
 * Blank rows before the hint make every selection as tall as the one with the longest description.
 */
export class SteadySettings implements Component {
  private measured?: { width: number; rows: number };

  constructor(private readonly list: SettingsList, private readonly items: readonly SettingItem[], private readonly visible: number) {}

  render(width: number): string[] {
    const lines = this.list.render(width);
    const rows = this.rows(width);
    // A submenu, or a list taller than measured, renders as it is.
    if (lines.length >= rows) return lines;
    const cut = Math.max(0, lines.length - HINT_ROWS);
    return [...lines.slice(0, cut), ...Array<string>(rows - lines.length).fill(""), ...lines.slice(cut)];
  }

  /** The list's height with the longest description, as Pi's list lays it out at this width. */
  private rows(width: number): number {
    if (this.measured?.width === width) return this.measured.rows;
    const shown = Math.min(this.visible, this.items.length);
    const scroll = this.items.length > this.visible ? 1 : 0;
    const description = Math.max(0, ...this.items.map(item => item.description ? 1 + wrapTextWithAnsi(item.description, width - 4).length : 0));
    const rows = shown + scroll + description + HINT_ROWS;
    this.measured = { width, rows };
    return rows;
  }

  handleInput(data: string): void { this.list.handleInput(data); }
  handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> { return this.list.handleMouse(event); }
  invalidate(): void { this.measured = undefined; this.list.invalidate(); }
}
