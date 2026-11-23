"""The agent's main loop.

    heartbeat (every 30 s, with real or estimated watts)
    → paused / outside the night window / server says no? wait
    → lease a task → verify it (signature, expiry, nonce, node, whitelist,
      image digest, input hash) → run it in the sandbox → upload the result
      with its sha256 and the power reading (or report a failure)

Pause and the night window are checked only BETWEEN fragments: a fragment
that has started is finished, then the agent stops taking work.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from nightshift_agent import __version__
from nightshift_agent.api import ApiError, Client, backoff_delay
from nightshift_agent.config import AgentConfig, state_dir, write_private
from nightshift_agent.device import device_id
from nightshift_agent.nonces import NonceStore
from nightshift_agent.sandbox import SandboxError, run_fragment
from nightshift_agent.telemetry import PowerReading, read_power
from nightshift_agent.trust import TaskRejected, VerifiedTask, WorkloadPin, verify_task
from nightshift_agent.window import Window

HEARTBEAT_EVERY_S = 30
#: Never run a task for longer than its lease, minus a margin for the upload.
UPLOAD_MARGIN_S = 30

log = logging.getLogger("nightshift")


def pause_flag(directory: Path | None = None) -> Path:
    return (directory or state_dir()) / "paused"


def set_paused(paused: bool, directory: Path | None = None) -> None:
    flag = pause_flag(directory)
    if paused:
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text("paused by owner\n", encoding="utf-8")
    else:
        flag.unlink(missing_ok=True)


def is_paused(directory: Path | None = None) -> bool:
    return pause_flag(directory).exists()


@dataclass
class Agent:
    client: Client
    config: AgentConfig
    node_id: str
    directory: Path
    #: Injectable for tests.
    run: Callable[..., bytes] = run_fragment
    power: Callable[[], PowerReading] | None = None
    clock: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep
    now_local: Callable[[], datetime] = datetime.now
    whitelist: dict[str, WorkloadPin] | None = None
    keys: Any = None
    benchmark_score: int | None = None
    #: Salted hash of the machine ID (see device.py). Injectable for tests.
    device: Callable[[], str | None] = device_id
    _last_beat: float = field(default=-1e9, init=False)
    _can_work: bool = field(default=False, init=False)
    _errors: int = field(default=0, init=False)
    _device: str | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        self.nonces = NonceStore(self.directory / "nonces.json")
        self.window = Window.parse(self.config.window) if self.config.window else None

    # ── status ────────────────────────────────────────────────────────────
    def _status(self, **fields: Any) -> None:
        data = {"at": int(self.clock()), "version": __version__, **fields}
        write_private(self.directory / "status.json", json.dumps(data).encode())

    def _reading(self) -> PowerReading:
        if self.power is not None:
            return self.power()
        return read_power(cpu_watts=self.config.cpu_watts)

    # ── loop pieces ───────────────────────────────────────────────────────
    def heartbeat(self, force: bool = False) -> None:
        if not force and self.clock() - self._last_beat < HEARTBEAT_EVERY_S:
            return
        r = self._reading()
        payload: dict[str, Any] = {"watts": r.watts, "wattsSource": r.source, "agentVersion": __version__}
        if r.gpu:
            payload.update(gpuModel=r.gpu.name, vramMb=r.gpu.vram_mb)
        if self.benchmark_score:
            payload["benchmarkScore"] = self.benchmark_score
        if self._device is None:
            self._device = self.device() or ""
        if self._device:
            payload["deviceId"] = self._device
        res = self.client.post_json("/api/agent/heartbeat", payload).body
        self._last_beat = self.clock()
        self._can_work = bool(res.get("canWork"))
        log.info(
            "heartbeat: %s W (%s), status=%s, canWork=%s, reason=%s",
            r.watts,
            r.source,
            res.get("status"),
            res.get("canWork"),
            res.get("reason"),
        )

    def local_reason(self) -> str | None:
        """Why the agent itself won't take work now, or None."""
        if is_paused(self.directory):
            return "paused"
        if self.window and not self.window.contains(self.now_local()):
            return "outside_window"
        return None

    def step(self) -> str:
        """One pass of the loop. Returns what happened (for logs and tests)."""
        self.heartbeat()
        reason = self.local_reason()
        if reason:
            self._status(state="idle", reason=reason)
            return reason
        if not self._can_work:
            self._status(state="idle", reason="server_says_wait")
            return "server_says_wait"
        lease = self.client.post_json("/api/agent/lease").body
        if not lease.get("task"):
            self._status(state="idle", reason=str(lease.get("reason")))
            return f"no_task:{lease.get('reason')}"
        return self._handle(lease)

    def _handle(self, lease: dict[str, Any]) -> str:
        try:
            task = verify_task(
                lease["task"],
                lease.get("input"),
                node_id=self.node_id,
                nonces=self.nonces,
                keys=self.keys,
                whitelist=self.whitelist,
                now=self.clock(),
            )
        except TaskRejected as rej:
            log.warning("refused a task: %s", rej.reason)
            # Only a task whose signature checked out has ids we can trust to
            # report back; a forged one is simply dropped.
            if rej.task and rej.reason not in ("replayed_nonce",):
                self._fail(str(rej.task.get("taskId")), int(rej.task.get("attempt", 0)), "bad_input")
            return f"rejected:{rej.reason}"
        log.info("task %s: %s, %s items, attempt %s", task.task_id[:8], task.workload, task.item_count, task.attempt)
        self._status(state="working", task=task.task_id, workload=task.workload)
        timeout = max(5.0, task.expires_at - self.clock() - UPLOAD_MARGIN_S)
        reading = self._reading()
        try:
            output = self.run(
                pin=task.pin,
                input_bytes=task.input,
                params=task.params,
                timeout_s=timeout,
                gpu=self.config.use_gpu and reading.gpu is not None,
            )
        except SandboxError as err:
            log.warning("task %s failed: %s", task.task_id[:8], err)
            self._fail(task.task_id, task.attempt, err.reason if err.reason in FAIL_REASONS else "other")
            return f"failed:{err.reason}"
        return self._complete(task, output, reading)

    def _complete(self, task: VerifiedTask, output: bytes, reading: PowerReading) -> str:
        digest = hashlib.sha256(output).hexdigest()
        try:
            res = self.client.request(
                "POST",
                f"/api/agent/fragments/{task.task_id}/complete",
                body=output,
                headers={
                    "X-Lease-Attempt": str(task.attempt),
                    "X-Output-Sha256": digest,
                    "X-Power-Watts": str(reading.watts),
                    "X-Power-Source": reading.source,
                },
            ).body
        except ApiError as err:
            log.warning("upload for %s refused: %s", task.task_id[:8], err.code)
            return f"upload_refused:{err.code}"
        log.info(
            "task %s done: accepted=%s, paid %s paise", task.task_id[:8], res.get("accepted"), res.get("paidPaise")
        )
        return "completed" if res.get("accepted") else "completed_superseded"

    def _fail(self, task_id: str, attempt: int, reason: str) -> None:
        if attempt < 1:
            return
        try:
            self.client.post_json(f"/api/agent/fragments/{task_id}/fail", {"attempt": attempt, "reason": reason})
        except ApiError as err:
            log.warning("couldn't report failure: %s", err.code)

    def run_forever(self, *, once: bool = False, max_steps: int | None = None) -> None:
        steps = 0
        while max_steps is None or steps < max_steps:
            steps += 1
            try:
                outcome = self.step()
                self._errors = 0
            except (ApiError, OSError) as err:
                self._errors += 1
                delay = backoff_delay(self._errors)
                if isinstance(err, ApiError) and err.status == 401:
                    log.error(
                        "the coordinator refused this node's token (revoked?). Run `nightshift-agent login <token>`."
                    )
                    raise
                log.warning("coordinator unreachable (%s); retrying in %.0fs", err, delay)
                self.sleep(delay)
                continue
            if once and outcome.startswith(("completed", "failed", "rejected", "upload_refused")):
                return
            busy = outcome.startswith(("completed", "failed", "upload_refused"))
            # Small jitter so many agents don't poll in lockstep.
            self.sleep(0 if busy else 5 + backoff_delay(0, base=2.5))


FAIL_REASONS = frozenset({"timeout", "crashed", "out_of_memory", "bad_input", "stopped", "other"})
