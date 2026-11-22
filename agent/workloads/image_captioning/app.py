"""NightShift workload: batch image captioning (BLIP base).

Reads /in/input.json {"images": [...]} and /in/params.json {maxWords},
writes /out/result.json {"items": ["a caption", ...]}.
"""

import base64
import io
import json
import sys

MODEL_DIR = "/opt/models/blip-image-captioning-base"


def main() -> int:
    with open("/in/input.json", encoding="utf-8") as fh:
        images = json.load(fh)["images"]
    with open("/in/params.json", encoding="utf-8") as fh:
        params = json.load(fh)
    max_words = max(5, min(40, int(params.get("maxWords", 20))))

    import torch
    from PIL import Image
    from transformers import BlipForConditionalGeneration, BlipProcessor

    Image.MAX_IMAGE_PIXELS = 40_000_000
    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = BlipProcessor.from_pretrained(MODEL_DIR, local_files_only=True)
    model = BlipForConditionalGeneration.from_pretrained(MODEL_DIR, local_files_only=True).to(device)
    captions = []
    for item in images:
        with Image.open(io.BytesIO(base64.b64decode(item["data"]))) as img:
            inputs = processor(images=img.convert("RGB"), return_tensors="pt").to(device)
        with torch.no_grad():
            ids = model.generate(**inputs, max_new_tokens=max_words * 2)
        words = processor.decode(ids[0], skip_special_tokens=True).strip().split()
        captions.append(" ".join(words[:max_words]))
    with open("/out/result.json", "w", encoding="utf-8") as fh:
        json.dump({"items": captions}, fh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
