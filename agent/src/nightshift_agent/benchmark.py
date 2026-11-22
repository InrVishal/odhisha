"""Benchmark on join, normalised so an RTX 3060 scores 1000.

Runs the pinned text-embeddings image on a fixed batch of 256 sentences and
times it. score = 1000 * (reference time on an RTX 3060 / our time), capped
at 10 000 (the coordinator caps it too). The reference time is an estimate
until it's measured on a real reference card; verification (phase 6) keeps
self-reported scores honest.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable

from nightshift_agent.sandbox import run_fragment
from nightshift_agent.trust import WorkloadPin

#: Seconds for the benchmark batch on the reference RTX 3060 (excluding start-up).
REFERENCE_SECONDS = 1.0
#: Measured container start-up and model load, subtracted from both timings.
MAX_SCORE = 10_000
SENTENCES = [f"NightShift benchmark sentence {i}: the quick brown fox jumps over the lazy dog." for i in range(256)]


def score_from_seconds(seconds: float, reference: float = REFERENCE_SECONDS) -> int:
    if seconds <= 0:
        return MAX_SCORE
    return max(1, min(MAX_SCORE, round(1000 * reference / seconds)))


def run_benchmark(
    pin: WorkloadPin,
    *,
    gpu: bool,
    run: Callable[..., bytes] = run_fragment,
    clock: Callable[[], float] = time.perf_counter,
) -> int:
    payload = json.dumps({"texts": SENTENCES}).encode()
    # Warm-up run with one sentence measures start-up, so only the batch counts.
    t0 = clock()
    run(
        pin=pin,
        input_bytes=json.dumps({"texts": SENTENCES[:1]}).encode(),
        params={"model": "all-MiniLM-L6-v2", "normalize": True},
        timeout_s=600,
        gpu=gpu,
    )
    startup = clock() - t0
    t1 = clock()
    run(pin=pin, input_bytes=payload, params={"model": "all-MiniLM-L6-v2", "normalize": True}, timeout_s=600, gpu=gpu)
    batch = max(1e-3, clock() - t1 - startup)
    return score_from_seconds(batch)
