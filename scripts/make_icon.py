#!/usr/bin/env python3
"""Convert a 1024x1024 PNG to a multi-size Windows .ico file.

Usage: python make_icon.py <source.png> <output.ico>
"""
import sys
from PIL import Image

SIZES = [16, 32, 48, 64, 128, 256]


def main(src: str, dst: str) -> None:
    img = Image.open(src).convert("RGBA")
    print(f"source: {src} size={img.size} mode={img.mode}")

    # Pillow's ICO writer downsamples the source image to each requested size.
    # Single save() call with sizes=[] produces a proper multi-resolution .ico.
    sizes = [(s, s) for s in SIZES]
    img.save(dst, format="ICO", sizes=sizes)
    for s in SIZES:
        print(f"  embedded {s}x{s}")
    print(f"wrote {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: make_icon.py <src.png> <dst.ico>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])