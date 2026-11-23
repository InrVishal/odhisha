# NightShift workload image: image_captioning. Built and pushed by .github/workflows/images.yml;
# agents run it only by digest (agent/src/nightshift_agent/trust.py WHITELIST).
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535
# Debian security updates on top of the pinned base, until it is rebuilt upstream
# (CI scans every image with Trivy and fails on a fixable high or critical CVE).
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp HF_HOME=/tmp/hf \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 OMP_NUM_THREADS=2
COPY requirements.txt /build/requirements.txt
# torch +cpu wheels come from the PyTorch CPU index; every file is still hash-checked.
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: --no-deps --extra-index-url https://download.pytorch.org/whl/cpu -r /build/requirements.txt \
 && rm -rf /build
ARG MODEL_REVISION=82a37760796d32b1411fe092ab5d4e227313294b
COPY convert_weights.py /build/convert_weights.py
# This model revision ships only pickle weights (pytorch_model.bin). They are
# converted once, here at build time, with torch's tensors-only loader, and the
# pickle is deleted: at run time the container only ever loads safetensors.
RUN HF_HUB_OFFLINE=0 python -c "from huggingface_hub import snapshot_download as d; d(\"Salesforce/blip-image-captioning-base\", revision=\"${MODEL_REVISION}\", local_dir=\"/opt/models/blip-image-captioning-base\", allow_patterns=[\"*.json\",\"*.txt\",\"pytorch_model.bin\"])" \
 && python /build/convert_weights.py /opt/models/blip-image-captioning-base \
 && rm -rf /build /opt/models/blip-image-captioning-base/.cache \
 && chmod -R a+rX /opt/models
COPY app.py /app/app.py
LABEL org.opencontainers.image.source="https://github.com/InrVishal/odhisha"
LABEL org.opencontainers.image.description="NightShift image_captioning workload"
# Nothing here builds packages at run time: drop the build tools (setuptools vendors old
# copies of wheel and jaraco.context with known CVEs; Trivy checks every image).
RUN pip uninstall -y setuptools wheel
USER 65534:65534
ENTRYPOINT ["python", "/app/app.py"]
