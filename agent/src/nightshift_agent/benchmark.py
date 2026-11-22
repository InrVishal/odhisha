"""Benchmark on join, normalised so an RTX 3060 scores 1000.

Runs the pinned text-embeddings image twice: once on a single sentence (to
measure container start-up and model load) and once on a large fixed batch.
The difference is the time spent on the batch itself, which gives a
throughput in sentences per second. The score compares that throughput with
the reference RTX 3060 throughput:

    score = 1000 * (our sentences/s) / (RTX 3060 sentences/s)

capped at 10 000 (the coordinator caps it too). The reference throughput is
an estimate until it's measured on a real RTX 3060; verification (phase 6)
keeps self-reported scores honest.

The batch is large on purpose: with a small batch the start-up time swamps
the work, the difference becomes noise, and a slow CPU can look 10x faster
than a GPU (which made the coordinator plan impossible deadlines).
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable

from nightshift_agent.sandbox import run_fragment
from nightshift_agent.trust import WorkloadPin

#: Estimated all-MiniLM-L6-v2 throughput on an RTX 3060, sentences per second.
REFERENCE_SENTENCES_PER_SECOND = 4000.0
MAX_SCORE = 10_000
BATCH = 1000
SENTENCES = [f"NightShift benchmark sentence {i}: the quick brown fox jumps over the lazy dog." for i in range(BATCH)]
PARAMS = {"model": "all-MiniLM-L6-v2", "normalize": True}
#: Below this many seconds of measured work the result is too noisy to trust.
MIN_WORK_SECONDS = 0.5


def score_from_throughput(sentences_per_second: float, reference: float = REFERENCE_SENTENCES_PER_SECOND) -> int:
    if sentences_per_second <= 0:
        return 1
    return max(1, min(MAX_SCORE, round(1000 * sentences_per_second / reference)))


def run_benchmark(
    pin: WorkloadPin,
    *,
    gpu: bool,
    run: Callable[..., bytes] = run_fragment,
    clock: Callable[[], float] = time.perf_counter,
) -> int:
    t0 = clock()
    run(pin=pin, input_bytes=json.dumps({"texts": SENTENCES[:1]}).encode(), params=PARAMS, timeout_s=600, gpu=gpu)
    startup = clock() - t0
    t1 = clock()
    run(pin=pin, input_bytes=json.dumps({"texts": SENTENCES}).encode(), params=PARAMS, timeout_s=900, gpu=gpu)
    total = clock() - t1
    # Time spent on the batch itself. If start-up noise eats it, fall back to
    # counting the whole run: that can only make the score LOWER, never inflate it.
    work = total - startup
    if work < MIN_WORK_SECONDS:
        work = max(total, MIN_WORK_SECONDS)
    return score_from_throughput((BATCH - 1) / work)
