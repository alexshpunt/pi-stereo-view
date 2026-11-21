import { matchesKey, wrapTextWithAnsi, type Component, type SettingItem, type SettingsList, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Rows of Pi's settings list under its items: a blank row and the key hint. */
const HINT_ROWS = 2;
/** Pi's key hint, extended with the arrow keys this list adds. */
const PI_HINT = "Enter/Space to change";
const ARROW_HINT = "←/→ or Enter/Space to change";

/**
 * Keep a settings list at one height while the selection moves, and step values with the arrow keys.
 *
 * Pi's list shows the selected item's description between the items and the key hint, so its height follows the
 * description's length; a centered overlay then jumps. Blank rows before the hint make every selection as tall as
 * the one with the longest description. Left and Right pick the previous or next value, wrapping around at either
 * end like Enter and Space, so a strength can be tuned in both directions.
 */
export class SteadySettings implements Component {
  private measured?: { width: number; rows: number };

  constructor(
    private readonly list: SettingsList,
    private readonly items: readonly SettingItem[],
    private readonly visible: number,
    private readonly change: (id: string, value: string) => void,
  ) {}

  render(width: number): string[] {
    const lines = this.list.render(width).map(line => line.replace(PI_HINT, ARROW_HINT));
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

  handleInput(data: string): void {
    const step = matchesKey(data, "left") ? -1 : matchesKey(data, "right") ? 1 : 0;
    if (!step) {
      this.list.handleInput(data);
      return;
    }
    // Pi's list does not expose its selection; it keeps it in a plain field.
    const index: unknown = Reflect.get(this.list, "selectedIndex");
    const item = typeof index === "number" ? this.items[index] : undefined;
    const values = item?.values;
    if (!item || !values?.length) return;
    const next = values[(values.indexOf(item.currentValue) + step + values.length) % values.length];
    if (next === item.currentValue) return;
    this.list.updateValue(item.id, next);
    this.change(item.id, next);
  }

  handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> { return this.list.handleMouse(event); }
  invalidate(): void { this.measured = undefined; this.list.invalidate(); }
}
