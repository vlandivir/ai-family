#!/usr/bin/env python3
import json
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def wrap(draw, text, font, width):
    lines = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            trial = f"{current} {word}"
            if draw.textlength(trial, font=font) <= width:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines or [""]


def main():
    table = json.load(sys.stdin)
    headers = [cell.replace("**", "") for cell in table["headers"]]
    rows = [[cell.replace("**", "") for cell in row] for row in table["rows"]]
    font = ImageFont.truetype(FONT, 22)
    header_font = ImageFont.truetype(FONT_BOLD, 22)
    pad = 16
    min_col = 140
    max_col = 360
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    widths = []
    for index, header in enumerate(headers):
        samples = [header, *[row[index] if index < len(row) else "" for row in rows]]
        longest = max(probe.textlength(sample, font=header_font) for sample in samples)
        widths.append(int(min(max(longest + pad * 2, min_col), max_col)))
    dummy = ImageDraw.Draw(Image.new("RGB", (1, 1)))

    def row_height(cells, used_font):
        height = 0
        for index, width in enumerate(widths):
            text = cells[index] if index < len(cells) else ""
            lines = wrap(dummy, text, used_font, width - pad * 2)
            height = max(height, len(lines) * 30 + pad * 2)
        return height

    header_height = row_height(headers, header_font)
    body_heights = [row_height(row, font) for row in rows]
    image = Image.new(
        "RGB",
        (sum(widths) + 1, header_height + sum(body_heights) + 1),
        "white",
    )
    draw = ImageDraw.Draw(image)

    def paint(cells, top, height, used_font, fill, color):
        x = 0
        for index, width in enumerate(widths):
            draw.rectangle([x, top, x + width, top + height], fill=fill, outline="#d5dbe3")
            text = cells[index] if index < len(cells) else ""
            y = top + pad
            for line in wrap(draw, text, used_font, width - pad * 2):
                draw.text((x + pad, y), line, font=used_font, fill=color)
                y += 30
            x += width

    paint(headers, 0, header_height, header_font, "#1f2933", "white")
    top = header_height
    for index, row in enumerate(rows):
        paint(row, top, body_heights[index], font, "#f7f8fa" if index % 2 else "white", "#1c2430")
        top += body_heights[index]
    image.save(sys.stdout.buffer, format="PNG")


if __name__ == "__main__":
    main()
