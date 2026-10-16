"""把原版方块面贴图转成 base64 data URI，供 lib/client.js 内联使用。

原图：research/tex/src-05.png
      （alexsocha/luckyblock 仓库 common/src/main/resources/game/assets/lucky/textures/block/lucky_block.png，
        16x16，是 Minecraft 幸运方块 mod 的方块面贴图本身，不是 mod 图标）

为什么用 data URI 而不是矢量重画：
  1. 16x16 像素材质（硬边、四角白色小方块、无渐变）是它的识别特征，
     任何"圆角方块 + 问号"的近似都会丢掉这种质感；
  2. PNG 原文件只有 326 字节，base64 后约 440 字符，比逐像素 SVG（213 个 rect、12KB）小一个数量级；
  3. 缩放用 image-rendering: pixelated，保持像素硬边，不糊。

运行：python tools/build-block-face.py
"""
import base64
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "research" / "tex" / "src-05.png"
OUT_JS = ROOT / "lib" / "block-face.js"


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    assert im.size == (16, 16), f"期望 16x16，实际 {im.size}"

    png = ROOT / "research" / "tex" / "src-05.orig.png"
    im.save(png, format="PNG", optimize=True)
    raw = png.read_bytes()
    data_uri = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")

    js = (
        "// 自动生成，请勿手改 —— 由 tools/build-block-face.py 从 src-05.png 生成。\n"
        "//\n"
        "// 来源：Minecraft 幸运方块 mod 的方块面贴图（16x16），\n"
        "//       github.com/alexsocha/luckyblock 的 assets/.../block/lucky_block.png。\n"
        "//       这是贴图本身，不是 mod 图标；显示时用 pixelated 保持像素硬边。\n"
        "export const LUCKY_BLOCK_FACE_PX = 16\n"
        f"export const LUCKY_BLOCK_FACE_URI = '{data_uri}'\n"
    )
    OUT_JS.write_text(js, encoding="utf-8")
    print(f"{SRC.name} -> {OUT_JS.name}: {len(raw)}B png, {len(data_uri)} chars data URI")


if __name__ == "__main__":
    main()