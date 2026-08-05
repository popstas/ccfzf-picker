#!/usr/bin/env python3
"""Иконки приложения, собранные из иконки трея.

    python3 scripts/make-icons.py

Единственный нарисованный руками файл — `src-tauri/icons/favicon.png`: 16×16,
два цвета, белый глиф на прозрачном. Он нарисован сразу под размер трея и в
генерации не участвует — скрипт его только читает. Всё остальное в
`src-tauri/icons/` этот скрипт перезаписывает.

Раньше у приложения был свой рисунок (зелёный круг на тёмном квадрате), никак
не связанный с треем: в доке одно, в строке меню другое. Теперь глиф один.

Два решения, за которые стоит держаться:

* **Увеличение — nearest, а не сглаженное.** В исходнике ровно два цвета и ни
  одного полупрозрачного пикселя: рисунок целиком из прямоугольников по сетке.
  Любая интерполяция на увеличении добавила бы кайму серых пикселей там, где её
  не рисовали. Кратность целая по той же причине.

* **Тёмная подложка остаётся.** Глиф белый, и на прозрачном фоне он исчез бы на
  светлой теме дока. Цвет и скругление взяты у прежней `icon.png`
  (`#1e1f22`, радиус 103 из 512), чтобы силуэт в доке не поменялся.
  В трее подложки нет и не надо: там иконка идёт как template, система красит
  её сама.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
SOURCE = ICONS / "favicon.png"

MASTER = 1024
BACKDROP = (30, 31, 34, 255)
RADIUS_RATIO = 103 / 512
# Доля стороны, которую занимает глиф. Меньше — и в доке он теряется, больше —
# и упирается в скругление подложки.
GLYPH_RATIO = 0.62

# Что кладётся рядом с мастером. `128x128@2x.png` — это 256: имя из соглашения
# Tauri, а не размер. Набор и порядок повторяют bundle.icon в tauri.conf.json.
PNG_SIZES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}
# Размеры внутри .ico. 16 и 32 — трей и проводник Windows, 256 — крупная плитка.
ICO_SIZES = [16, 32, 48, 64, 128, 256]


def backdrop(size):
    """Тёмный квадрат со скруглением, во всю сторону — как было у icon.png."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=round(size * RADIUS_RATIO), fill=BACKDROP
    )
    return img


def master():
    glyph = Image.open(SOURCE).convert("RGBA")
    # Обрезка по чернилам: в исходнике глиф прижат к левому краю, и без обрезки
    # он оказался бы в подложке не по центру.
    box = glyph.getbbox()
    if box is None:
        sys.exit(f"{SOURCE} пустой — генерировать не из чего")
    glyph = glyph.crop(box)

    scale = int(MASTER * GLYPH_RATIO) // max(glyph.size)
    glyph = glyph.resize((glyph.width * scale, glyph.height * scale), Image.NEAREST)

    img = backdrop(MASTER)
    img.alpha_composite(
        glyph, ((MASTER - glyph.width) // 2, (MASTER - glyph.height) // 2)
    )
    return img


def main():
    img = master()
    written = []

    for name, size in PNG_SIZES.items():
        img.resize((size, size), Image.LANCZOS).save(ICONS / name)
        written.append(name)

    img.resize((256, 256), Image.LANCZOS).save(
        ICONS / "icon.ico", sizes=[(s, s) for s in ICO_SIZES]
    )
    written.append("icon.ico")

    img.save(ICONS / "icon.icns")
    written.append("icon.icns")

    print(f"из {SOURCE.name}: " + ", ".join(written))


if __name__ == "__main__":
    main()
