"""Print bracketed icons for a pixel test in the affected native terminal.

Current and alternative labels have identical spacing. Alternatives were checked
against the configured FiraCode NFM Retina font. Presence is not a centering proof.
Do not use a headless HTML capture as a native terminal screenshot.
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
]

print("Native icon rendering test — current vs font-covered candidates")
print("Action           Current       Candidate")
for name, current, candidate in icons:
    print(f"{name:12}     \033[38;2;131;165;152m[ {current} ]\033[0m"
          f"         \033[38;2;131;165;152m[ {candidate} ]\033[0m")
print("ASCII control    \033[38;2;131;165;152m[ + ]\033[0m")
