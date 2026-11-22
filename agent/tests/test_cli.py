from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from nightshift_agent import cli, secrets_store
from nightshift_agent.api import ApiError, Response
from nightshift_agent.config import AgentConfig

TOKEN = "nsn_" + "B" * 43
NODE = "11111111-1111-4111-8111-111111111111"


class LoginClient:
    reply: dict[str, Any] | ApiError = {"nodeId": NODE, "status": "online"}

    def __init__(self, api: str, token: str) -> None:
        self.api, self.token = api, token

    def post_json(self, path: str, payload: dict[str, Any] | None = None) -> Response:
        assert path == "/api/agent/heartbeat"
        if isinstance(self.reply, ApiError):
            raise self.reply
        return Response(200, self.reply)


def run(*argv: str) -> int:
    return cli.main(list(argv))


def test_login_stores_the_token_and_node(
    state: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "Client", LoginClient)
    assert run("login", TOKEN, "--api", "https://nightshift.in") == 0
    out = capsys.readouterr().out
    assert TOKEN not in out and "Logged in as node 11111111" in out
    assert secrets_store.load_token(state) == TOKEN
    cfg = AgentConfig.load(state)
    assert cfg.node_id == NODE and cfg.api == "https://nightshift.in"


def test_login_refuses_bad_tokens_and_urls(
    state: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "Client", LoginClient)
    assert run("login", "not-a-token") == 2
    assert run("login", TOKEN, "--api", "http://nightshift.in") == 2
    LoginClient.reply = ApiError(401, "bad_token")
    try:
        assert run("login", TOKEN) == 1
        assert "refused this token" in capsys.readouterr().out
        LoginClient.reply = ApiError(500, "internal")
        assert run("login", TOKEN) == 1
        LoginClient.reply = {"status": "online"}
        assert run("login", TOKEN) == 1
    finally:
        LoginClient.reply = {"nodeId": NODE, "status": "online"}
    assert secrets_store.load_token(state) is None


def test_status_never_prints_the_token(
    state: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "Client", LoginClient)
    run("login", TOKEN, "--api", "https://nightshift.in")
    capsys.readouterr()
    assert run("status") == 0
    out = capsys.readouterr().out
    assert TOKEN not in out and "token:       stored" in out and "paused:      no" in out


def test_pause_resume_logs_logout(
    state: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "Client", LoginClient)
    run("login", TOKEN)
    assert run("pause") == 0
    run("status")
    assert "paused:      yes" in capsys.readouterr().out
    assert run("resume") == 0
    (state / "agent.log").write_text(f"x Bearer {TOKEN}\n", encoding="utf-8")
    assert run("logs", "-n", "5") == 0
    assert TOKEN not in capsys.readouterr().out
    assert run("logout") == 0
    assert secrets_store.load_token(state) is None


def test_start_refuses_without_login_or_docker(
    state: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run("start", "--once") == 2
    assert "not logged in" in capsys.readouterr().out
    monkeypatch.setattr(cli, "Client", LoginClient)
    run("login", TOKEN)
    monkeypatch.setattr(cli, "docker_available", lambda: False)
    assert run("start", "--once", "--window", "23:00-07:00", "--cpu-watts", "70", "--no-gpu") == 2
    assert "Docker isn't running" in capsys.readouterr().out
    cfg = AgentConfig.load(state)
    assert cfg.window == "23:00-07:00" and cfg.cpu_watts == 70 and cfg.use_gpu is False


def test_start_runs_the_agent(state: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli, "Client", LoginClient)
    run("login", TOKEN)
    monkeypatch.setattr(cli, "docker_available", lambda: True)
    ran: list[bool] = []

    def fake_run(self: Any, *, once: bool = False) -> None:
        ran.append(once)

    monkeypatch.setattr(cli.Agent, "run_forever", fake_run)
    assert run("start", "--once") == 0
    assert ran == [True]

    def revoked(self: Any, *, once: bool = False) -> None:
        raise ApiError(401, "bad_token")

    monkeypatch.setattr(cli.Agent, "run_forever", revoked)
    assert run("start") == 1


def test_first_start_benchmarks_once_and_reports_the_score(state: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from nightshift_agent.trust import WorkloadPin

    monkeypatch.setattr(cli, "Client", LoginClient)
    run("login", TOKEN)
    monkeypatch.setattr(cli, "docker_available", lambda: True)
    monkeypatch.setattr(cli, "ensure_image", lambda _img: True)
    monkeypatch.setitem(cli.WHITELIST, "text_embeddings", WorkloadPin(image="x@sha256:" + "a" * 64, wants_gpu=True))
    calls: list[int] = []
    monkeypatch.setattr(cli.benchmark, "run_benchmark", lambda pin, gpu: calls.append(1) or 1450)
    scores: list[int | None] = []
    monkeypatch.setattr(cli.Agent, "run_forever", lambda self, once=False: scores.append(self.benchmark_score))
    assert run("start", "--once") == 0
    assert run("start", "--once") == 0
    assert calls == [1]  # only on the first start
    assert scores == [1450, 1450]
    assert AgentConfig.load(state).benchmark_score == 1450


def test_update_refuses_unverifiable_releases(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    wheel = tmp_path / "w.whl"
    wheel.write_bytes(b"x")
    (tmp_path / "m.json").write_text("{}", encoding="utf-8")
    (tmp_path / "m.sig").write_text("AAAA", encoding="utf-8")
    assert (
        run("update", str(wheel), "--manifest", str(tmp_path / "m.json"), "--signature", str(tmp_path / "m.sig")) == 2
    )
    assert "refusing to update" in capsys.readouterr().out
