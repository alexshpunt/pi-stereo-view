import { SettingInput, type SettingInputTheme } from "./setting-input.ts";

/** A settings submenu that takes one `#rrggbb` color. */
export class HexInput extends SettingInput {
  constructor(current: string, theme: SettingInputTheme, done: (value?: string) => void) {
    super(/^#[0-9a-f]{6}$/i.test(current) ? current : "#", theme, {
      title: "Hover color",
      hint: "#rrggbb · Enter to keep · Esc to cancel",
      error: "Enter a color as #rrggbb, such as #3b82f6.",
      normalize: HexInput.normalize,
    }, done);
  }

  /** `#rrggbb` in lowercase, accepting the color with or without `#`; undefined for anything else. */
  static normalize(value: string): string | undefined {
    const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    return match ? "#" + match[1].toLowerCase() : undefined;
  }
}
