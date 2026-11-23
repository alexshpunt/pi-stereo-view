import { matchesKey, wrapTextWithAnsi, type Component, type SettingItem, type SettingsList, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Rows of Pi's settings list under its items: a blank row and the key hint. */
const HINT_ROWS = 2;
/** Pi's key hint, extended with the arrow keys this list adds. */
const PI_HINT = "Enter/Space to change";
const ARROW_HINT = "←/→ or Enter/Space to change";

/** Group titles by the id of the setting each group starts with, and how a title looks. */
export interface SettingGroups {
  titles: ReadonlyMap<string, string>;
  style(title: string): string;
}

/**
 * Keep a settings list at one height, show group titles, and step values with the arrow keys.
 *
 * Pi's list shows the selected item's description between the items and the key hint, so its height follows the
 * description's length; a centered overlay then jumps. Blank rows before the hint make every selection as tall as
 * the one with the longest description. Left and Right pick the previous or next value, wrapping around at either
 * end like Enter and Space, so a strength can be tuned in both directions.
 *
 * Pi's list has no group titles. While it shows every item, its item rows are the items in order, so a title and a
 * blank row before it are inserted above a group's first item; the selection never lands on them, and pointer rows are
 * mapped back to the list's own rows.
 */
export class SteadySettings implements Component {
  private measured?: { width: number; rows: number };

  constructor(
    private readonly list: SettingsList,
    private readonly items: readonly SettingItem[],
    private readonly visible: number,
    private readonly change: (id: string, value: string) => void,
    private readonly groups?: SettingGroups,
  ) {}

  render(width: number): readonly string[] {
    const rows = this.rows(width);
    // A submenu, such as a color input, keeps the list's height too: blank rows follow it.
    if (this.submenuOpen()) {
      const lines = this.list.render(width);
      return lines.length >= rows ? lines : [...lines, ...Array<string>(rows - lines.length).fill("")];
    }
    const lines = this.withTitles(this.list.render(width).map(line => line.replace(PI_HINT, ARROW_HINT)));
    // A list taller than measured renders as it is.
    if (lines.length >= rows) return lines;
    const cut = Math.max(0, lines.length - HINT_ROWS);
    return [...lines.slice(0, cut), ...Array<string>(rows - lines.length).fill(""), ...lines.slice(cut)];
  }

  /** Each item's row in the rendered list, or undefined while the list scrolls and has no titles. */
  private itemRows(): number[] | undefined {
    if (!this.groups || this.items.length > this.visible) return undefined;
    let row = 0;
    return this.items.map((item, index) => {
      if (this.groups?.titles.has(item.id)) row += index === 0 ? 1 : 2;
      return row++;
    });
  }

  private withTitles(lines: readonly string[]): readonly string[] {
    const groups = this.groups;
    if (!groups || !this.itemRows()) return lines;
    const result: string[] = [];
    this.items.forEach((item, index) => {
      const title = groups.titles.get(item.id);
      if (title !== undefined) {
        if (index > 0) result.push("");
        result.push(groups.style(title));
      }
      result.push(lines[index] ?? "");
    });
    return [...result, ...lines.slice(this.items.length)];
  }

  /** The list's height with the longest description, as Pi's list lays it out at this width. */
  private rows(width: number): number {
    if (this.measured?.width === width) return this.measured.rows;
    const shown = Math.min(this.visible, this.items.length);
    const scroll = this.items.length > this.visible ? 1 : 0;
    const titles = (this.itemRows()?.at(-1) ?? shown - 1) + 1 - shown;
    const description = Math.max(0, ...this.items.map(item => item.description ? 1 + wrapTextWithAnsi(item.description, width - 4).length : 0));
    const rows = shown + titles + scroll + description + HINT_ROWS;
    this.measured = { width, rows };
    return rows;
  }

  /** Pi's list keeps an open submenu in a plain field. */
  private submenuOpen(): boolean {
    return Reflect.get(this.list, "submenuComponent") != null;
  }

  handleInput(data: string): void {
    const step = matchesKey(data, "left") ? -1 : matchesKey(data, "right") ? 1 : 0;
    // In a submenu, such as a text input, the arrows move its cursor.
    if (!step || this.submenuOpen()) {
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

  handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
    const rows = this.itemRows();
    if (!rows || this.submenuOpen()) return this.list.handleMouse(event);
    const last = rows.at(-1) ?? -1;
    // Rows below the items, such as the description, shift up by the titles above them.
    if (event.y > last) return this.list.handleMouse({ ...event, y: event.y - (last + 1 - this.items.length) });
    const item = rows.indexOf(event.y);
    // A title or a blank row between groups is not a setting.
    if (item < 0) return event.type === "wheel" ? this.list.handleMouse(event) : undefined;
    return this.list.handleMouse({ ...event, y: item });
  }

  invalidate(): void { this.measured = undefined; this.list.invalidate(); }
}
