# -*- coding: utf-8 -*-
"""生成插件图标（蓝底 + 白色麦克风），输出到 extension/icons/"""

import os
from PIL import Image, ImageDraw

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "extension", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

BG = (24, 95, 165, 255)
FG = (255, 255, 255, 255)


def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=BG)

    cx = size / 2
    w = max(2.0, size * 0.17)
    top = size * 0.20
    bot = size * 0.55
    lw = max(1, int(round(size * 0.055)))

    d.rounded_rectangle([cx - w / 2, top, cx + w / 2, bot], radius=w / 2, fill=FG)
    d.arc(
        [cx - size * 0.21, bot - size * 0.20, cx + size * 0.21, bot + size * 0.17],
        start=25, end=155, fill=FG, width=lw,
    )
    d.line([cx, bot + size * 0.15, cx, size * 0.76], fill=FG, width=lw)
    d.line([cx - size * 0.11, size * 0.76, cx + size * 0.11, size * 0.76], fill=FG, width=lw)
    return img


for s in (16, 32, 48, 128):
    make(s).save(os.path.join(OUT_DIR, f"icon{s}.png"))

print("icons written to", OUT_DIR)
