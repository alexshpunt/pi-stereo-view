import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, rgbColor, stripTerminalSequences, styleText, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { CompactMessage } from "../src/timestamps.js";

test.each([85, 170])("keeps only the copy icon faint with foreground %s", intensity => {
  const fg = rgbColor(intensity, intensity, intensity);
  const theme = {
    fg: (_name: string, value: string) => styleText(value, { fg }, "truecolor"),
    style: (value: string, options: { dim?: boolean }) => styleText(value, { fg, dim: options.dim }, "truecolor"),
  } as Theme;
  const block = new CompactMessage(new Text("body", 0, 0), () => "12:34:56", () => theme,
    () => 1, () => true, () => {});
  try {
    const line = block.render(40)[0];
    expect(stripTerminalSequences(line)).toMatch(/body\s+\[⧉\] 12:34:56$/);
    expect(line).toContain(theme.style("[⧉]", { fg: "dim", dim: true }));
    expect(line).toContain(theme.fg("dim", "12:34:56"));
    expect(visibleWidth(line)).toBe(39);
  } finally { block.dispose(); }
});
