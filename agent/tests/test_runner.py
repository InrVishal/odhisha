from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from nightshift_agent.api import ApiError, Response
from nightshift_agent.config import AgentConfig
from nightshift_agent.runner import Agent, is_paused, set_paused
from nightshift_agent.sandbox import SandboxError
from nightshift_agent.telemetry import GpuInfo, PowerReading
from nightshift_agent.trust import WorkloadPin

from .conftest import NODE, Coordinator

RESULT = b'{"items": [[0.1, 0.2]]}'


class FakeClient:
    def __init__(self, coord: Coordinator, *, can_work: bool = True, lease: dict[str, Any] | None = None) -> None:
        self.coord = coord
        self.can_work = can_work
        self.lease = lease
        self.calls: list[tuple[str, str, Any, dict[str, str]]] = []
        self.complete_reply: dict[str, Any] | Exception = {"accepted": True, "paidPaise": 26}

    def post_json(
        self, path: str, payload: dict[str, Any] | None = None, headers: dict[str, str] | None = None
    ) -> Response:
        self.calls.append(("POST", path, payload, headers or {}))
        if path == "/api/agent/heartbeat":
            return Response(200, {"nodeId": NODE, "status": "online", "canWork": self.can_work, "reason": None})
        if path == "/api/agent/lease":
            return Response(200, self.lease or {"task": None, "reason": "no_work"})
        if path.endswith("/fail"):
            return Response(200, {"requeued": True})
        raise AssertionError(path)

    def request(
        self, method: str, path: str, *, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> Response:
        self.calls.append((method, path, body, headers or {}))
        if isinstance(self.complete_reply, Exception):
            raise self.complete_reply
        return Response(200, self.complete_reply)

    def paths(self) -> list[str]:
        return [c[1] for c in self.calls]


def make_agent(
    coord: Coordinator,
    whitelist: dict[str, WorkloadPin],
    state: Path,
    client: FakeClient,
    *,
    run: Any = None,
    window: str | None = None,
    now_local: datetime | None = None,
    gpu: bool = True,
) -> Agent:
    reading = (
        PowerReading(watts=410, source="nvidia-smi", gpu=GpuInfo("NVIDIA GeForce RTX 4070", 12282, 320.0))
        if gpu
        else PowerReading(65, "estimated", None)
    )
    return Agent(
        client=client,  # type: ignore[arg-type]
        config=AgentConfig(window=window),
        node_id=NODE,
        directory=state,
        run=run or (lambda **_: RESULT),
        power=lambda: reading,
        sleep=lambda _s: None,
        now_local=(lambda: now_local) if now_local else datetime.now,
        whitelist=whitelist,
        keys=coord.keys,
    )


def lease_for(coord: Coordinator, **over: Any) -> dict[str, Any]:
    signed, inp = coord.task(**over)
    return {"task": signed, "input": inp, "leaseExpiresAt": "x"}


def test_happy_path_uploads_the_result_with_its_hash_and_power(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    seen: dict[str, Any] = {}

    def run(**kw: Any) -> bytes:
        seen.update(kw)
        return RESULT

    client = FakeClient(coord, lease=lease_for(coord))
    agent = make_agent(coord, whitelist, state, client, run=run)
    assert agent.step() == "completed"
    beat = client.calls[0]
    assert beat[1] == "/api/agent/heartbeat"
    assert (
        beat[2]["watts"] == 410 and beat[2]["wattsSource"] == "nvidia-smi" and beat[2]["gpuModel"].startswith("NVIDIA")
    )
    _method, path, body, headers = client.calls[-1]
    assert path.endswith("/complete") and body == RESULT
    assert headers["X-Output-Sha256"] == hashlib.sha256(RESULT).hexdigest()
    assert headers["X-Lease-Attempt"] == "1"
    assert headers["X-Power-Watts"] == "410" and headers["X-Power-Source"] == "nvidia-smi"
    assert seen["gpu"] is True and seen["input_bytes"] == b'{"texts":["hi"]}'
    assert json.loads((state / "status.json").read_text())["state"] == "working"


def test_cpu_mode_reports_estimated_watts_and_no_gpu(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    seen: dict[str, Any] = {}
    client = FakeClient(coord, lease=lease_for(coord))
    agent = make_agent(coord, whitelist, state, client, run=lambda **kw: seen.update(kw) or RESULT, gpu=False)
    agent.step()
    assert client.calls[0][2]["wattsSource"] == "estimated" and client.calls[0][2]["watts"] == 65
    assert seen["gpu"] is False
    assert client.calls[-1][3]["X-Power-Source"] == "estimated"


def test_pause_stops_new_work_but_not_the_heartbeat(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    client = FakeClient(coord, lease=lease_for(coord))
    agent = make_agent(coord, whitelist, state, client)
    set_paused(True, state)
    assert is_paused(state)
    assert agent.step() == "paused"
    assert client.paths() == ["/api/agent/heartbeat"]
    set_paused(False, state)
    assert agent.step() == "completed"


def test_respects_the_local_night_window(coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path) -> None:
    client = FakeClient(coord, lease=lease_for(coord))
    noon = datetime(2026, 11, 22, 12, 0)
    assert make_agent(coord, whitelist, state, client, window="23:00-07:00", now_local=noon).step() == "outside_window"
    night = datetime(2026, 11, 22, 23, 30)
    assert make_agent(coord, whitelist, state, client, window="23:00-07:00", now_local=night).step() == "completed"


def test_finishes_the_current_fragment_when_paused_mid_run(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    client = FakeClient(coord, lease=lease_for(coord))

    def run(**_: Any) -> bytes:
        set_paused(True, state)  # owner pauses while the fragment runs
        return RESULT

    agent = make_agent(coord, whitelist, state, client, run=run)
    assert agent.step() == "completed"  # the running piece still finishes and uploads
    assert agent.step() == "paused"  # and nothing new starts


def test_waits_when_the_coordinator_says_so(coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path) -> None:
    client = FakeClient(coord, can_work=False)
    assert make_agent(coord, whitelist, state, client).step() == "server_says_wait"
    assert "/api/agent/lease" not in client.paths()


def test_no_task_available(coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path) -> None:
    assert make_agent(coord, whitelist, state, FakeClient(coord)).step() == "no_task:no_work"


def test_a_signed_but_unacceptable_task_is_reported_back(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    ran: list[int] = []
    client = FakeClient(coord, lease=lease_for(coord, image="evil/image:latest"))
    agent = make_agent(coord, whitelist, state, client, run=lambda **_: ran.append(1) or RESULT)
    assert agent.step() == "rejected:image_mismatch"
    assert ran == []
    fail = client.calls[-1]
    assert fail[1].endswith("/fail") and fail[2] == {"attempt": 1, "reason": "bad_input"}


def test_a_forged_task_is_dropped_without_trusting_its_ids(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    forger = Coordinator()
    client = FakeClient(coord, lease=lease_for(forger))
    ran: list[int] = []
    agent = make_agent(coord, whitelist, state, client, run=lambda **_: ran.append(1) or RESULT)
    assert agent.step() == "rejected:unknown_key"
    assert ran == []
    assert not any(p.endswith("/fail") for p in client.paths())


def test_a_replayed_task_never_runs_twice(coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path) -> None:
    lease = lease_for(coord)
    ran: list[int] = []
    client = FakeClient(coord, lease=lease)
    agent = make_agent(coord, whitelist, state, client, run=lambda **_: ran.append(1) or RESULT)
    assert agent.step() == "completed"
    assert agent.step() == "rejected:replayed_nonce"
    assert ran == [1]


@pytest.mark.parametrize(
    ("err", "reported"),
    [
        (SandboxError("timeout"), "timeout"),
        (SandboxError("bad_output"), "other"),
        (SandboxError("out_of_memory"), "out_of_memory"),
    ],
)
def test_sandbox_failures_are_reported(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path, err: SandboxError, reported: str
) -> None:
    def run(**_: Any) -> bytes:
        raise err

    client = FakeClient(coord, lease=lease_for(coord))
    assert make_agent(coord, whitelist, state, client, run=run).step() == f"failed:{err.reason}"
    assert client.calls[-1][2] == {"attempt": 1, "reason": reported}


def test_the_task_never_runs_past_its_lease(coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path) -> None:
    seen: dict[str, Any] = {}
    client = FakeClient(coord, lease=lease_for(coord))
    agent = make_agent(coord, whitelist, state, client, run=lambda **kw: seen.update(kw) or RESULT)
    agent.step()
    assert seen["timeout_s"] <= 600 - 30 + 1


def test_upload_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path) -> None:
    client = FakeClient(coord, lease=lease_for(coord))
    client.complete_reply = ApiError(409, "lease_lost")
    assert make_agent(coord, whitelist, state, client).step() == "upload_refused:lease_lost"


def test_superseded_result(coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path) -> None:
    client = FakeClient(coord, lease=lease_for(coord))
    client.complete_reply = {"accepted": False, "paidPaise": 25}
    assert make_agent(coord, whitelist, state, client).step() == "completed_superseded"


def test_heartbeat_every_30_seconds_not_every_step(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    client = FakeClient(coord)
    t = [1000.0]
    agent = make_agent(coord, whitelist, state, client)
    agent.clock = lambda: t[0]
    agent.step()
    agent.step()
    t[0] += 31
    agent.step()
    assert client.paths().count("/api/agent/heartbeat") == 2


def test_run_forever_backs_off_on_errors_and_stops_on_a_revoked_token(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    sleeps: list[float] = []
    client = FakeClient(coord)
    agent = make_agent(coord, whitelist, state, client)
    agent.sleep = sleeps.append
    errors = [OSError("offline"), OSError("offline"), ApiError(401, "bad_token")]

    def failing_step() -> str:
        raise errors.pop(0)

    agent.step = failing_step  # type: ignore[method-assign]
    with pytest.raises(ApiError):
        agent.run_forever()
    assert len(sleeps) == 2 and all(0 <= s <= 300 for s in sleeps)


def test_run_forever_once_returns_after_one_task(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], state: Path
) -> None:
    client = FakeClient(coord, lease=lease_for(coord))
    agent = make_agent(coord, whitelist, state, client)
    agent.run_forever(once=True, max_steps=5)
    assert sum(p.endswith("/complete") for p in client.paths()) == 1
    idle = make_agent(coord, whitelist, state, FakeClient(coord))
    idle.run_forever(max_steps=3)
