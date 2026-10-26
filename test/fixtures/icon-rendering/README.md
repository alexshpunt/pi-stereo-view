# Native icon pixel test

`native-expand.png` is a crop of the user's Windows Terminal screenshot. It contains only the reported bracketed expand icon. It is a failing baseline, not a reference for correct rendering. The screenshot does not encode its source commit.

Run the separate pixel check (requires Python and Pillow):

```sh
python3 test/icon-rendering.py test/fixtures/icon-rendering/native-expand.png \
  --annotated tmp/icon-rendering/marked.png
```

It should fail: the icon's ink center is 2 pixels right of the brackets' center. The allowed error is half a pixel to account for odd/even raster bounds. Magenta marks the bracket center; cyan marks the glyph center in the optional annotated copy.

For a fresh check:

1. Run `python3 test/icon-atlas.py` in the affected native terminal.
2. Take a native screenshot. Crop one complete bracketed icon, with no other text.
3. Run `test/icon-rendering.py` on that crop. Set `--foreground` if the theme uses a different color.

The test compares visible ink, not character count or `visibleWidth`. It refuses ambiguous crops rather than passing them. Check every selected icon, including restore and both swap directions.

Do not use `inspect_tui` as native font proof: its installed implementation recreates the pane's ANSI text with headless Chromium and a different font stack. Likewise, an isolated font-file raster does not prove Windows Terminal's actual fallback behavior.

## Cell geometry and glyph ink

Header and toolbar buttons use the shared five-cell `[ glyph ]` renderer. Cell width and mouse targets stay consistent even when a fallback font draws the glyph off-center. Equal spaces on both sides cannot correct a fractional-pixel bearing inside a cell.

Measure the complete current set, including search, settings and both compact/full tool controls, in enabled and disabled colors. The atlas includes them all. Preserve the encoded control when testing variation selectors or combining characters; they can change shaping without changing cell width. Check the actual application after any candidate change.

[Unicode UAX #11](https://www.unicode.org/reports/tr11/) separates character width properties from font-dependent glyph dimensions. [Windows Terminal's overhang handling](https://github.com/microsoft/terminal/pull/13549) can also reposition or scale glyphs. A passing native sample establishes that terminal, font configuration and scale; it does not guarantee optical centering in every font.

## Approved native samples

`native-atlas.png` preserves the complete unchanged screenshot. The eight crops use x=355..419 and y=97+22×row..119+22×row (exclusive end), in the table's action order. Linear removes embedded data-URL images from exported Markdown, so this tracked source preserves the native pixel evidence.

`approved/*.png` contains eight unchanged crops from the user's native atlas screenshot (925×291 pixels). The source was captured from the `7c7d450` diagnostic table before changing production icons. The user approved its candidate column. Each crop is 64×22 pixels; no resizing or font substitution was applied. The Bash output uses RGB `235,219,178`, so pass that foreground color.

```sh
for image in test/fixtures/icon-rendering/approved/*.png; do
  python3 test/icon-rendering.py "$image" --foreground 235,219,178 || exit
done
```

All eight samples have zero horizontal ink offset. The negative `native-expand.png` baseline still fails at +2 pixels; the tolerance has not changed. These samples prove the selected glyphs in this native atlas, not every font or the post-reload application. Check the loaded application separately.

Font settings were inspected read-only. No terminal font or global setting was changed. Font coverage alone is only a screening step, not a centering check.
