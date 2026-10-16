"""从 research/tex 的 16x16 幸运方块面贴图生成插件市场用的 icon.png（64x64，NEAREST 放大）。"""
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "research" / "tex" / "src-05.orig.png"
OUT = ROOT / "icon.png"
SIZE = 64

if not SRC.exists():
    sys.exit(f"missing source: {SRC}")

face = Image.open(SRC).convert("RGBA").resize((SIZE, SIZE), Image.NEAREST)

# 圆角 + 轻微外描边，让它在小尺寸下也能和别的图标区分开。
radius = 8
mask = Image.new("L", (SIZE, SIZE), 0)
for y in range(SIZE):
    for x in range(SIZE):
        dx = min(x, SIZE - 1 - x)
        dy = min(y, SIZE - 1 - y)
        inside = True
        if dx < radius and dy < radius:
            inside = (radius - dx) ** 2 + (radius - dy) ** 2 <= radius * radius
        mask.putpixel((x, y), 255 if inside else 0)

canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
canvas.paste(face, (0, 0), mask)
canvas.save(OUT)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
