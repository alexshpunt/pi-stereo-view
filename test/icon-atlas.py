"""Print baseline and approved icons for a pixel test in the native terminal.

Both sets have identical spacing. The approved icons passed the native screenshot
check on FiraCode NFM Retina. Other terminals still need their own pixel check.
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

print("Native icon rendering test — baseline vs approved icons")
print("Action           Baseline      Approved")
for name, baseline, approved in icons:
    print(f"{name:12}     \033[38;2;131;165;152m[ {baseline} ]\033[0m"
          f"         \033[38;2;131;165;152m[ {approved} ]\033[0m")
print("ASCII control    \033[38;2;131;165;152m[ + ]\033[0m")
