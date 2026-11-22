# NightShift workload image: text_embeddings. Built and pushed by .github/workflows/images.yml;
# agents run it only by digest (agent/src/nightshift_agent/trust.py WHITELIST).
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp HF_HOME=/tmp/hf     HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 OMP_NUM_THREADS=2
COPY requirements.txt /build/requirements.txt
# torch +cpu wheels come from the PyTorch CPU index; every file is still hash-checked.
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: --no-deps --extra-index-url https://download.pytorch.org/whl/cpu -r /build/requirements.txt  && rm -rf /build
ARG MODEL_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41
RUN HF_HUB_OFFLINE=0 python -c "from huggingface_hub import snapshot_download as d; d(\"sentence-transformers/all-MiniLM-L6-v2\", revision=\"${MODEL_REVISION}\", local_dir=\"/opt/models/all-MiniLM-L6-v2\", allow_patterns=[\"*.json\", \"*.txt\", \"model.safetensors\", \"1_Pooling/*\"])" \
 && chmod -R a+rX /opt/models
COPY app.py /app/app.py
LABEL org.opencontainers.image.source="https://github.com/InrVishal/odhisha"
LABEL org.opencontainers.image.description="NightShift text_embeddings workload"
USER 65534:65534
ENTRYPOINT ["python", "/app/app.py"]
