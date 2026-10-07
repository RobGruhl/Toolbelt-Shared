#!/usr/bin/env python3
"""Cut-and-stack imposition for half-letter booklet on letter paper.

Page-size specific: the input must be 5.5in x 8.5in pages; other sizes are refused
rather than silently mis-tiled.

Arranges pages 2-up on landscape letter (11"x8.5") for duplex printing
with short-edge flip. After printing, cut the stack in half and place
the left pile on top of the right pile.

Usage:
    python3 impose.py [input.pdf] [output.pdf]
"""

import sys
from pathlib import Path

try:
    from pypdf import PdfReader, PdfWriter, PageObject, Transformation
except ImportError:
    print("ERROR: pypdf not found.")
    print("Install: in the project, `poetry add pypdf` — or run it through the belt: toolbelt run spiral-book -- impose <project>")
    sys.exit(1)

HALF_W = 396.0   # 5.5"
PAGE_H = 612.0   # 8.5"
LETTER_W = 792.0 # 11"
LETTER_H = 612.0 # 8.5"


def make_blank():
    return PageObject.create_blank_page(width=HALF_W, height=PAGE_H)


def impose(input_path: str, output_path: str):
    reader = PdfReader(input_path)
    num_pages = len(reader.pages)
    if num_pages:
        box = reader.pages[0].mediabox
        w, h = float(box.width), float(box.height)
        if abs(w - HALF_W) > 1.0 or abs(h - PAGE_H) > 1.0:
            print(f"ERROR: {input_path} pages are {w:.0f}x{h:.0f}pt; this imposition is for 5.5x8.5in ({HALF_W:.0f}x{PAGE_H:.0f}pt) only.")
            sys.exit(2)
    padded = num_pages + (-num_pages % 4)
    pages = list(reader.pages) + [make_blank() for _ in range(padded - num_pages)]
    half = padded // 2
    sheets = padded // 4

    print(f"Source: {num_pages} pages, padded to {padded}")
    print(f"Sheets: {sheets} (duplex) = {sheets * 2} output pages")

    writer = PdfWriter()

    for k in range(sheets):
        front_left  = 2 * k
        front_right = 2 * k + half
        back_left   = 2 * k + half + 1
        back_right  = 2 * k + 1

        front = PageObject.create_blank_page(width=LETTER_W, height=LETTER_H)
        front.merge_transformed_page(pages[front_left], Transformation().translate(tx=0, ty=0))
        front.merge_transformed_page(pages[front_right], Transformation().translate(tx=HALF_W, ty=0))
        writer.add_page(front)

        back = PageObject.create_blank_page(width=LETTER_W, height=LETTER_H)
        back.merge_transformed_page(pages[back_left], Transformation().translate(tx=0, ty=0))
        back.merge_transformed_page(pages[back_right], Transformation().translate(tx=HALF_W, ty=0))
        writer.add_page(back)

    writer.write(output_path)
    print(f"Output: {output_path}")


if __name__ == "__main__":
    input_pdf = sys.argv[1] if len(sys.argv) > 1 else "book.pdf"
    output_pdf = sys.argv[2] if len(sys.argv) > 2 else "book-print-ready.pdf"
    if not Path(input_pdf).exists():
        print(f"ERROR: {input_pdf} not found. Build the book first.")
        sys.exit(1)
    impose(input_pdf, output_pdf)
