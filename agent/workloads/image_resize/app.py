"""NightShift workload: batch image resizing (Pillow).

Reads /in/input.json {"images": [{"name", "mime", "data"}]} and
/in/params.json {width, height, fit, format, quality}, writes
/out/result.json {"items": [{"mime", "data"}, ...]} (base64).
"""

import base64
import io
import json
import sys

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse decompression bombs
FORMATS = {"png": ("PNG", "image/png"), "jpeg": ("JPEG", "image/jpeg"), "webp": ("WEBP", "image/webp")}


def resize(img: Image.Image, w: int, h: int, fit: str) -> Image.Image:
    if fit == "cover":
        return ImageOps.fit(img, (w, h))
    if fit == "contain":
        return ImageOps.pad(img, (w, h))
    copy = img.copy()
    copy.thumbnail((w, h))
    return copy


def main() -> int:
    with open("/in/input.json", encoding="utf-8") as fh:
        images = json.load(fh)["images"]
    with open("/in/params.json", encoding="utf-8") as fh:
        p = json.load(fh)
    w, h = int(p["width"]), int(p["height"])
    if not (1 <= w <= 4096 and 1 <= h <= 4096):
        return 2
    fmt, mime = FORMATS[p.get("format", "webp")]
    items = []
    for item in images:
        with Image.open(io.BytesIO(base64.b64decode(item["data"]))) as src:
            src.load()
            img = ImageOps.exif_transpose(src)
            if fmt == "JPEG" and img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            out = io.BytesIO()
            resize(img, w, h, p.get("fit", "inside")).save(out, fmt, quality=int(p.get("quality", 85)))
        items.append({"mime": mime, "data": base64.b64encode(out.getvalue()).decode()})
    with open("/out/result.json", "w", encoding="utf-8") as fh:
        json.dump({"items": items}, fh, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
