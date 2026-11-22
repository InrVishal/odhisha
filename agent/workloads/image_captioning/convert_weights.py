"""Build-time only: turn pytorch_model.bin into model.safetensors, then delete it.

torch.load(weights_only=True) refuses anything but tensors and plain
containers, so a malicious pickle can't run code here; the safetensors file
the container loads at run time can't carry code at all.
"""

import pathlib
import sys

import torch
from safetensors.torch import save_file


def main(model_dir: str) -> None:
    d = pathlib.Path(model_dir)
    src = d / "pytorch_model.bin"
    # Build time only, official pinned revision, tensors-only loader; the pickle is deleted below.
    # nosemgrep: trailofbits.python.pickles-in-pytorch.pickles-in-pytorch
    state = torch.load(src, map_location="cpu", weights_only=True)
    tensors = {k: v.contiguous() for k, v in state.items()}
    # Tied weights share storage; safetensors needs each saved once.
    seen: dict[int, str] = {}
    for k in list(tensors):
        ptr = tensors[k].data_ptr()
        if ptr in seen:
            tensors[k] = tensors[k].clone()
        seen[ptr] = k
    save_file(tensors, str(d / "model.safetensors"), metadata={"format": "pt"})
    src.unlink()
    print(f"converted {len(tensors)} tensors to safetensors")


if __name__ == "__main__":
    main(sys.argv[1])
