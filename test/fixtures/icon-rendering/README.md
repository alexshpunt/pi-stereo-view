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

Font settings were inspected read-only. No terminal font or global setting was changed. Candidate presence in the configured font is only a screening step; candidates still need native screenshot checks.
