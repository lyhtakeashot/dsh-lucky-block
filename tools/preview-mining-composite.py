"""把方块面贴图 + 10 帧原版破坏裂纹叠在一起，拼成「挖掘中」的完整观感预览。

运行：python tools/preview-mining-composite.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TEX = ROOT / "research" / "tex"
FACE = TEX / "block-face-source.png"
STAGES = sorted(
    (TEX / "destroy-stage").glob("destroy_stage_*.png"),
    key=lambda p: int(p.stem.rsplit("_", 1)[1]),
)
CELL = 96
PAD = 6
BG = (40, 42, 52, 255)


def main() -> None:
    if not FACE.exists():
        raise SystemExit(f"missing {FACE} (run tools/build-block-face.py first)")
    face = Image.open(FACE).convert("RGBA")
    cols = len(STAGES)
    sheet = Image.new("RGBA", (cols * CELL + (cols + 1) * PAD, CELL + 2 * PAD), BG)
    for i, st in enumerate(STAGES):
        cell = face.resize((CELL, CELL), Image.NEAREST)
        crack = Image.open(st).convert("RGBA").resize((CELL, CELL), Image.NEAREST)
        cell.alpha_composite(crack)
        sheet.alpha_composite(cell, (PAD + i * (CELL + PAD), PAD))
    out = TEX / "mining-composite.png"
    sheet.save(out)
    print(f"{cols} stages over face -> {out} ({sheet.size[0]}x{sheet.size[1]})")


if __name__ == "__main__":
    main()
