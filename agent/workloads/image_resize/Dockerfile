# NightShift workload image: image_resize. Built and pushed by .github/workflows/images.yml;
# agents run it only by digest (agent/src/nightshift_agent/trust.py WHITELIST).
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535
# Debian security updates on top of the pinned base, until it is rebuilt upstream
# (CI scans every image with Trivy and fails on a fixable high or critical CVE).
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp HF_HOME=/tmp/hf     HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 OMP_NUM_THREADS=2
COPY requirements.txt /build/requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: --no-deps -r /build/requirements.txt  && rm -rf /build

COPY app.py /app/app.py
LABEL org.opencontainers.image.source="https://github.com/InrVishal/odhisha"
LABEL org.opencontainers.image.description="NightShift image_resize workload"
USER 65534:65534
ENTRYPOINT ["python", "/app/app.py"]
