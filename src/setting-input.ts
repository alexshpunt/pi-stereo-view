import { Input, type Component } from "@earendil-works/pi-tui";

/** Style hooks from the settings theme. */
export interface SettingInputTheme {
  title(text: string): string;
  hint(text: string): string;
  error(text: string): string;
}

interface SettingInputOptions {
  title: string;
  hint: string;
  error: string;
  /** Return the value to save, or undefined to keep the editor open. */
  normalize(value: string): string | undefined;
}

/** A settings submenu that edits one value. Escape closes it without saving. */
export class SettingInput implements Component {
  private readonly input = new Input();
  private invalid = false;

  constructor(current: string, private readonly theme: SettingInputTheme,
    private readonly options: SettingInputOptions, done: (value?: string) => void) {
    this.input.focused = true;
    // Typed in, so the cursor ends after the text; setValue leaves it at the start.
    for (const key of current) this.input.handleInput(key);
    this.input.onSubmit = value => {
      const normalized = options.normalize(value);
      if (normalized !== undefined) done(normalized);
      else this.invalid = true;
    };
    this.input.onEscape = () => done();
  }

  render(width: number): string[] {
    return [
      this.theme.title(this.options.title),
      ...this.input.render(width),
      "",
      this.invalid ? this.theme.error("  " + this.options.error) : this.theme.hint("  " + this.options.hint),
    ];
  }

  handleInput(data: string): void {
    this.invalid = false;
    this.input.handleInput(data);
  }

  invalidate(): void { this.input.invalidate(); }
}
