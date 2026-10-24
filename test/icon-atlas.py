"""Print the full control set for pixel checks in each native terminal/font pair.

The copy row includes its complete two-cell control: CGJ joins the selected glyph,
and the trailing blank reserves its overhang. Keep both when capturing that row.
Historical approved fixtures cover eight toolbar icons, not every row below.
A headless replay is not native font evidence.
"""

icons = [
    ("combined", "▣", "▣"),
    ("split", "◫", "◫"),
    ("rows", "▤", "▤"),
    ("columns", "▥", "▥"),
    ("swap rows", "⇅", "↕"),
    ("swap columns", "⇄", "↔"),
    ("expand", "⛶", "↗"),
    ("restore", "↙", "↙"),
    ("search", "⌕", "⌕"),
    ("settings", "≡", "≡"),
    ("copy", "⧉ ", "⧉\u034f "),
]


def bracket(glyph, dim=False):
    return "\033[38;2;131;165;152m" + ("\033[2m" if dim else "") + f"[ {glyph} ]\033[0m"


print("Native icon rendering test — baseline vs selected controls")
print("Action           Baseline      Approved      Approved dim")
for name, baseline, approved in icons:
    cells = 2 if name == "copy" else 1
    gap = " " * (10 - cells)
    print(f"{name:12}     " + bracket(baseline) + gap + bracket(approved) + gap + bracket(approved, dim=True))
print("ASCII control    " + bracket("+"))
