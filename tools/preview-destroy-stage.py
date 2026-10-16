"""把 10 张原版挖掘裂纹贴图拼成一张放大对比图，人眼确认破坏纹路走向。

运行：python tools/preview-destroy-stage.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "research" / "tex" / "destroy-stage"
CELL = 96  # 每张 16x16 放大到多少
PAD = 6
SCALE = CELL // 16


def main() -> None:
    files = sorted(SRC.glob("destroy_stage_*.png"))
    if not files:
        raise SystemExit(f"no destroy_stage_*.png under {SRC}")
    cols = len(files)
    sheet = Image.new("RGBA", (cols * CELL + (cols + 1) * PAD, CELL + 2 * PAD), (40, 42, 52, 255))
    for i, f in enumerate(files):
        big = Image.open(f).convert("RGBA").resize((CELL, CELL), Image.NEAREST)
        sheet.alpha_composite(big, (PAD + i * (CELL + PAD), PAD))
    out = ROOT / "research" / "tex" / "destroy-stage-strip.png"
    sheet.save(out)
    print(f"{cols} stages -> {out} ({sheet.size[0]}x{sheet.size[1]}, NEAREST x{SCALE})")


if __name__ == "__main__":
    main()
