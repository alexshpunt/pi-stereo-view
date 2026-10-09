"""Check optical icon centering in actual terminal pixels, not string widths.

Requires Pillow. Pass a tight crop containing one bracketed icon and no other text.
A headless replay or inspect_tui HTML image is not a native terminal screenshot.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


def components(image, foreground, tolerance):
    """Find connected foreground ink while ignoring background and faint fringes."""
    points = {
        (x, y)
        for y in range(image.height)
        for x in range(image.width)
        if max(abs(a - b) for a, b in zip(image.getpixel((x, y)), foreground)) <= tolerance
    }
    result = []
    while points:
        start = points.pop()
        pending, part = [start], [start]
        while pending:
            x, y = pending.pop()
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    neighbor = (x + dx, y + dy)
                    if neighbor in points:
                        points.remove(neighbor)
                        pending.append(neighbor)
                        part.append(neighbor)
        if len(part) >= 3:
            result.append((min(x for x, _ in part), min(y for _, y in part),
                           max(x for x, _ in part), max(y for _, y in part)))
    return result


def measure(image, foreground, tolerance):
    """Compare glyph ink center with bracket ink center; refuse ambiguous crops."""
    parts = components(image, foreground, tolerance)
    if len(parts) < 3:
        raise ValueError("Need two separate brackets and visible icon ink")
    tallest = max(bottom - top + 1 for _, top, _, bottom in parts)
    # Tall arrows can be as high as brackets; brackets are the two outer pieces.
    ordered = sorted(parts)
    left, right = ordered[0], ordered[-1]
    brackets = [left, right]
    if any(part[3] - part[1] + 1 < tallest * .85 for part in brackets) or \
            abs((left[3] - left[1]) - (right[3] - right[1])) > 1 or \
            abs((left[2] - left[0]) - (right[2] - right[0])) > 1:
        raise ValueError("Cannot identify two matching outer brackets; use a tighter crop or color")
    glyph = [part for part in parts if part not in brackets]
    if any(part[0] <= left[2] or part[2] >= right[0] for part in glyph):
        raise ValueError("Icon ink touches a bracket or crop contains unrelated content")
    expected = ((left[0] + left[2]) / 2 + (right[0] + right[2]) / 2) / 2
    actual = (min(part[0] for part in glyph) + max(part[2] for part in glyph)) / 2
    return expected, actual


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--foreground", default="131,165,152", help="Icon RGB color")
    parser.add_argument("--tolerance", type=int, default=55, help="Maximum RGB channel difference")
    parser.add_argument("--max-offset", type=float, default=.5, help="Allowed horizontal error in pixels")
    parser.add_argument("--annotated", type=Path, help="Save a marked copy for visual inspection")
    args = parser.parse_args()
    foreground = tuple(map(int, args.foreground.split(",")))
    if len(foreground) != 3 or any(not 0 <= value <= 255 for value in foreground):
        parser.error("Foreground must be three RGB values from 0 to 255")
    if not 0 <= args.tolerance <= 255 or args.max_offset < 0:
        parser.error("Tolerance must be 0..255 and max-offset cannot be negative")
    image = Image.open(args.image).convert("RGB")
    try:
        expected, actual = measure(image, foreground, args.tolerance)
    except ValueError as error:
        parser.error(str(error))
    offset = actual - expected
    passed = abs(offset) <= args.max_offset
    print(f"{'PASS' if passed else 'FAIL'} {args.image}: ink offset {offset:+.2f}px "
          f"(allowed ±{args.max_offset:.2f}px); bracket center {expected:.2f}, icon center {actual:.2f}")
    if args.annotated:
        args.annotated.parent.mkdir(parents=True, exist_ok=True)
        draw = ImageDraw.Draw(image)
        draw.line((expected, 0, expected, image.height - 1), fill="magenta")
        draw.line((actual, 0, actual, image.height - 1), fill="cyan")
        image.resize((image.width * 10, image.height * 10), Image.Resampling.NEAREST).save(args.annotated)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
