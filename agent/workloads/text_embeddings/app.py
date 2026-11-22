"""NightShift workload: batch text embeddings (all-MiniLM-L6-v2, 384 dims).

Reads /in/input.json {"texts": [...]} and /in/params.json, writes
/out/result.json {"items": [[...384 floats...], ...]}. No network: the model
is baked into the image at a pinned revision.
"""

import json
import sys

MODEL_DIR = "/opt/models/all-MiniLM-L6-v2"
MAX_TEXTS = 1000


def main() -> int:
    with open("/in/input.json", encoding="utf-8") as fh:
        texts = json.load(fh)["texts"]
    with open("/in/params.json", encoding="utf-8") as fh:
        params = json.load(fh)
    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts) or len(texts) > MAX_TEXTS:
        print("bad input", file=sys.stderr)
        return 2
    if params.get("model", "all-MiniLM-L6-v2") != "all-MiniLM-L6-v2":
        print("unknown model", file=sys.stderr)
        return 2

    import torch
    from sentence_transformers import SentenceTransformer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = SentenceTransformer(MODEL_DIR, device=device, local_files_only=True)
    vectors = model.encode(
        texts, batch_size=64, normalize_embeddings=bool(params.get("normalize", True)), show_progress_bar=False
    )
    with open("/out/result.json", "w", encoding="utf-8") as fh:
        json.dump({"items": [[round(float(x), 6) for x in v] for v in vectors]}, fh, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
