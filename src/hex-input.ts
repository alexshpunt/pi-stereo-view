import { Input, type Component } from "@earendil-works/pi-tui";

/** Style hooks for the hex input, from the settings theme. */
export interface HexInputTheme {
  title(text: string): string;
  hint(text: string): string;
  error(text: string): string;
}

/**
 * A settings submenu that takes one `#rrggbb` color. Enter keeps a valid color, Escape leaves the setting as it was;
 * an invalid entry stays open with a note instead of closing.
 */
export class HexInput implements Component {
  private readonly input = new Input();
  private invalid = false;

  constructor(current: string, private readonly theme: HexInputTheme, done: (value?: string) => void) {
    this.input.focused = true;
    // Typed in, so the cursor ends after the text; setValue leaves it at the start.
    for (const key of /^#[0-9a-f]{6}$/i.test(current) ? current : "#") this.input.handleInput(key);
    this.input.onSubmit = value => {
      const color = HexInput.normalize(value);
      if (color) done(color);
      else this.invalid = true;
    };
    this.input.onEscape = () => done();
  }

  /** `#rrggbb` in lowercase, accepting the color with or without `#`; undefined for anything else. */
  static normalize(value: string): string | undefined {
    const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    return match ? "#" + match[1].toLowerCase() : undefined;
  }

  render(width: number): string[] {
    return [
      this.theme.title("Hover color"),
      ...this.input.render(width),
      "",
      this.invalid ? this.theme.error("  Enter a color as #rrggbb, such as #3b82f6.") : this.theme.hint("  #rrggbb · Enter to keep · Esc to cancel"),
    ];
  }

  handleInput(data: string): void {
    this.invalid = false;
    this.input.handleInput(data);
  }

  invalidate(): void { this.input.invalidate(); }
}
