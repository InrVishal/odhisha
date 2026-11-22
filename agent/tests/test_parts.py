"""Config, token storage, logs, HTTP client, telemetry, window, updates, benchmark."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import random
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from nightshift_agent import benchmark, logs, secrets_store, telemetry, updates
from nightshift_agent.api import ApiError, Client, backoff_delay
from nightshift_agent.config import AgentConfig, ConfigError, state_dir, validate_api_url, write_private
from nightshift_agent.window import Window

TOKEN = "nsn_" + "A" * 43

# ─── config ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("url", "dev", "ok"),
    [
        ("https://nightshift-ten-iota.vercel.app", False, True),
        ("https://nightshift.in/", False, True),
        ("http://nightshift.in", False, False),
        ("http://nightshift.in", True, False),
        ("http://localhost:3000", False, False),
        ("http://localhost:3000", True, True),
        ("http://127.0.0.1:3400", True, True),
        ("ftp://nightshift.in", True, False),
        ("https://user:pw@nightshift.in", False, False),
        ("https://nightshift.in/?x=1", False, False),
        ("https://", False, False),
        ("file:///etc/passwd", True, False),
    ],
)
def test_api_url_must_be_https_except_localhost_in_dev(url: str, dev: bool, ok: bool) -> None:
    if ok:
        assert validate_api_url(url, dev=dev).rstrip("/") == url.rstrip("/")
    else:
        with pytest.raises(ConfigError):
            validate_api_url(url, dev=dev)


def test_dev_mode_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ConfigError):
        validate_api_url("http://localhost:3000")
    monkeypatch.setenv("NIGHTSHIFT_DEV", "1")
    assert validate_api_url("http://localhost:3000") == "http://localhost:3000"


def test_config_round_trip_and_state_dir(state: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert state_dir() == state
    cfg = AgentConfig(node_id="n", window="23:00-07:00")
    cfg.save(state)
    assert AgentConfig.load(state).window == "23:00-07:00"
    (state / "config.json").write_text(json.dumps({"api": "http://evil.example"}), encoding="utf-8")
    with pytest.raises(ConfigError):
        AgentConfig.load(state)
    monkeypatch.delenv("NIGHTSHIFT_STATE_DIR")
    assert "ightshift" in str(state_dir()).lower() or "NightShift" in str(state_dir())


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_private_files_are_0600(tmp_path: Path) -> None:
    write_private(tmp_path / "x", b"secret")
    assert (tmp_path / "x").stat().st_mode & 0o777 == 0o600


# ─── token storage ─────────────────────────────────────────────────────────


def test_token_falls_back_to_a_private_file(state: Path) -> None:
    assert secrets_store.save_token(TOKEN, state) == "file"
    assert secrets_store.load_token(state) == TOKEN
    secrets_store.delete_token(state)
    assert secrets_store.load_token(state) is None


@pytest.mark.parametrize("bad", ["", "nsn_short", "abc_" + "A" * 43, TOKEN + "x", "nsn_" + "A" * 42 + "!"])
def test_token_format_is_checked(bad: str, state: Path) -> None:
    with pytest.raises(secrets_store.TokenError):
        secrets_store.save_token(bad, state)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_refuses_a_token_file_others_can_read(state: Path) -> None:
    secrets_store.save_token(TOKEN, state)
    os.chmod(state / "token", 0o640)  # group-readable is enough to be refused
    with pytest.raises(secrets_store.TokenError, match="readable by other users"):
        secrets_store.load_token(state)


def test_uses_the_os_keyring_when_there_is_one(state: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeKeyring:
        store: dict[tuple[str, str], str] = {}

        def set_password(self, s: str, u: str, p: str) -> None:
            self.store[(s, u)] = p

        def get_password(self, s: str, u: str) -> str | None:
            return self.store.get((s, u))

        def delete_password(self, s: str, u: str) -> None:
            raise RuntimeError("backend error")  # must not block logout

    fake = FakeKeyring()
    monkeypatch.setattr(secrets_store, "_keyring", lambda: fake)
    assert secrets_store.save_token(TOKEN, state) == "keyring"
    assert not (state / "token").exists()
    assert secrets_store.load_token(state) == TOKEN
    secrets_store.delete_token(state)


# ─── logs ──────────────────────────────────────────────────────────────────


def test_tokens_never_reach_the_logs(state: Path) -> None:
    logger = logs.setup(state)
    logger.info("lease with Authorization: Bearer %s for %s", TOKEN, "node")
    logger.warning("raw token %s", TOKEN)
    for h in logger.handlers:
        h.flush()
    text = (state / "agent.log").read_text(encoding="utf-8")
    assert TOKEN not in text and "redacted" in text
    assert all(TOKEN not in line for line in logs.tail(10, state))
    assert logs.redact('{"authorization": "Bearer abc.def"}').count("abc.def") == 0


def test_tail_of_a_missing_log(state: Path) -> None:
    assert logs.tail(5, state) == []


# ─── HTTP client ───────────────────────────────────────────────────────────


class FakeOpener:
    def __init__(self, status: int = 200, body: bytes = b"{}") -> None:
        self.status = status
        self.body = body
        self.requests: list[urllib.request.Request] = []

    def open(self, req: urllib.request.Request, timeout: float) -> Any:
        self.requests.append(req)
        if self.status >= 400:
            raise urllib.error.HTTPError(req.full_url, self.status, "x", {}, io.BytesIO(self.body))  # type: ignore[arg-type]

        class R(io.BytesIO):
            status = self.status

            def __enter__(self) -> R:
                return self

            def __exit__(self, *a: object) -> None:
                pass

        return R(self.body)


def test_client_sends_the_token_only_in_the_header() -> None:
    opener = FakeOpener(body=b'{"ok": true}')
    c = Client("https://nightshift.in", TOKEN, opener=opener)  # type: ignore[arg-type]
    assert c.post_json("/api/agent/lease").body == {"ok": True}
    req = opener.requests[0]
    assert req.get_header("Authorization") == f"Bearer {TOKEN}"
    assert TOKEN not in req.full_url and TOKEN not in repr(c)


def test_client_maps_errors_and_caps_responses() -> None:
    c = Client("https://nightshift.in", TOKEN, opener=FakeOpener(401, b'{"error":"bad_token"}'))  # type: ignore[arg-type]
    with pytest.raises(ApiError) as info:
        c.post_json("/api/agent/heartbeat")
    assert info.value.status == 401 and info.value.code == "bad_token"
    for body in (b"not json", b"[1,2]"):
        with pytest.raises(ApiError, match="bad_response"):
            Client("https://nightshift.in", TOKEN, opener=FakeOpener(200, body)).post_json("/api/agent/lease")  # type: ignore[arg-type]
    big = FakeOpener(200, b" " * (8 * 1024 * 1024 + 2))
    with pytest.raises(ApiError, match="too_large"):
        Client("https://nightshift.in", TOKEN, opener=big).request("GET", "/api/x")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="/api/"):
        c.request("GET", "https://evil.example/")
    with pytest.raises(ConfigError):
        Client("http://nightshift.in", TOKEN)


def test_tls_verification_is_on() -> None:
    c = Client("https://nightshift.in", TOKEN)
    handlers = [h for h in c._opener.handlers if isinstance(h, urllib.request.HTTPSHandler)]
    ctx = handlers[0]._context  # type: ignore[attr-defined]
    import ssl

    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname is True


def test_backoff_is_exponential_with_full_jitter() -> None:
    rng = random.Random(1)
    samples = [backoff_delay(a, rng=rng) for a in range(12) for _ in range(20)]
    assert all(0 <= s <= 300 for s in samples)
    assert max(backoff_delay(0, rng=rng) for _ in range(200)) <= 2.0
    assert max(backoff_delay(10, rng=rng) for _ in range(200)) > 100  # capped at 300, grows past 2**6


# ─── telemetry ─────────────────────────────────────────────────────────────


def test_parses_nvidia_smi() -> None:
    gpu = telemetry.parse_nvidia_smi("NVIDIA GeForce RTX 4070, 12282, 187.43\n")
    assert gpu == telemetry.GpuInfo("NVIDIA GeForce RTX 4070", 12282, 187.43)
    assert telemetry.parse_nvidia_smi("NVIDIA GeForce RTX 3050 Laptop GPU, 4096, [N/A]\n") is None
    assert telemetry.parse_nvidia_smi("garbage") is None
    assert telemetry.parse_nvidia_smi("X, 1, 99999") is None
    two = telemetry.parse_nvidia_smi("A, 1, [N/A]\nB, 2, 100.0")
    assert two is not None and two.name == "B"


def test_whole_pc_watts_or_an_estimate() -> None:
    measured = telemetry.read_power(cpu_watts=65, gpu_reader=lambda: telemetry.GpuInfo("x", 1, 250.4))
    assert measured.watts == 340 and measured.source == "nvidia-smi"
    estimated = telemetry.read_power(cpu_watts=70, gpu_reader=lambda: None)
    assert estimated.watts == 70 and estimated.source == "estimated"


def test_read_gpu_handles_a_missing_or_failing_nvidia_smi(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(telemetry.shutil, "which", lambda _n: None)
    assert telemetry.read_gpu() is None
    monkeypatch.setattr(telemetry.shutil, "which", lambda _n: "nvidia-smi")

    def ok(args: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        assert kw["shell"] is False
        return subprocess.CompletedProcess(args, 0, "NVIDIA GeForce RTX 3060, 12288, 150.0\n", "")

    assert telemetry.read_gpu(ok) == telemetry.GpuInfo("NVIDIA GeForce RTX 3060", 12288, 150.0)
    assert telemetry.read_gpu(lambda a, **k: subprocess.CompletedProcess(a, 9, "", "")) is None

    def boom(*_a: Any, **_k: Any) -> Any:
        raise OSError

    assert telemetry.read_gpu(boom) is None


# ─── night window ──────────────────────────────────────────────────────────


def test_night_window() -> None:
    w = Window.parse("23:00-07:00")
    assert str(w) == "23:00-07:00"
    assert w.contains(datetime(2026, 1, 1, 23, 0)) and w.contains(datetime(2026, 1, 1, 6, 59))
    assert not w.contains(datetime(2026, 1, 1, 7, 0)) and not w.contains(datetime(2026, 1, 1, 12, 0))
    day = Window.parse("09:00-17:00")
    assert day.contains(datetime(2026, 1, 1, 9, 0)) and not day.contains(datetime(2026, 1, 1, 17, 0))
    assert Window.parse("00:00-00:00").contains(datetime(2026, 1, 1, 15, 0))
    for bad in ("23-07", "24:00-07:00", "23:00 to 07:00", ""):
        with pytest.raises(ValueError):
            Window.parse(bad)


# ─── signed updates ────────────────────────────────────────────────────────


@pytest.fixture
def release(tmp_path: Path) -> tuple[str, Ed25519PrivateKey, Path, bytes]:
    key = Ed25519PrivateKey.generate()
    pem = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    wheel = tmp_path / "nightshift_agent-0.5.0-py3-none-any.whl"
    wheel.write_bytes(b"wheel bytes")
    manifest = json.dumps(
        {"version": "0.5.0", "wheel": wheel.name, "sha256": hashlib.sha256(b"wheel bytes").hexdigest()}
    ).encode()
    return pem, key, wheel, manifest


def test_installs_only_a_correctly_signed_release(release: tuple[str, Ed25519PrivateKey, Path, bytes]) -> None:
    pem, key, wheel, manifest = release
    sig = base64.b64encode(key.sign(manifest))
    assert updates.verify_release(manifest, sig, wheel, pem=pem).version == "0.5.0"


def test_refuses_unsigned_or_tampered_releases(
    release: tuple[str, Ed25519PrivateKey, Path, bytes], tmp_path: Path
) -> None:
    pem, key, wheel, manifest = release
    sig = base64.b64encode(key.sign(manifest))
    other = base64.b64encode(Ed25519PrivateKey.generate().sign(manifest))
    with pytest.raises(updates.ReleaseError, match="doesn't verify"):
        updates.verify_release(manifest, other, wheel, pem=pem)
    with pytest.raises(updates.ReleaseError, match="doesn't verify"):
        updates.verify_release(manifest.replace(b"0.5.0", b"9.9.9"), sig, wheel, pem=pem)
    with pytest.raises(updates.ReleaseError, match="base64"):
        updates.verify_release(manifest, b"%%%", wheel, pem=pem)
    wheel.write_bytes(b"swapped wheel")
    with pytest.raises(updates.ReleaseError, match="sha256"):
        updates.verify_release(manifest, sig, wheel, pem=pem)
    renamed = tmp_path / "other.whl"
    renamed.write_bytes(b"wheel bytes")
    with pytest.raises(updates.ReleaseError, match="name"):
        updates.verify_release(manifest, sig, renamed, pem=pem)
    bad_manifest = b'{"version": "1"}'
    with pytest.raises(updates.ReleaseError, match="bad manifest"):
        updates.verify_release(bad_manifest, base64.b64encode(key.sign(bad_manifest)), wheel, pem=pem)


def test_without_a_pinned_release_key_every_update_is_refused(
    release: tuple[str, Ed25519PrivateKey, Path, bytes],
) -> None:
    # Until the release key is created (see agent/README.md "Updates"), this
    # build has no key pinned, so it must refuse every wheel.
    _pem, key, wheel, manifest = release
    if "BEGIN PUBLIC KEY" in updates.RELEASE_KEY_PEM:
        pytest.skip("a release key is pinned in this build")
    with pytest.raises(updates.ReleaseError, match="no release key pinned"):
        updates.verify_release(manifest, base64.b64encode(key.sign(manifest)), wheel)


def test_install_needs_pipx(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(updates.shutil, "which", lambda _n: None)
    with pytest.raises(updates.ReleaseError, match="pipx"):
        updates.install(tmp_path / "x.whl")


# ─── benchmark ─────────────────────────────────────────────────────────────


def test_benchmark_score_is_normalised_to_an_rtx_3060() -> None:
    assert benchmark.score_from_seconds(benchmark.REFERENCE_SECONDS) == 1000
    assert benchmark.score_from_seconds(benchmark.REFERENCE_SECONDS / 2) == 2000
    assert benchmark.score_from_seconds(0) == benchmark.MAX_SCORE
    assert benchmark.score_from_seconds(1e-9) == benchmark.MAX_SCORE
    assert benchmark.score_from_seconds(1e9) == 1


def test_benchmark_times_the_batch_without_start_up() -> None:
    ticks = iter([0.0, 3.0, 3.0, 6.5])  # warm-up 3 s (start-up), batch 3.5 s → 0.5 s of work
    calls: list[int] = []
    score = benchmark.run_benchmark(
        updates_pin(),
        gpu=False,
        run=lambda **kw: calls.append(len(json.loads(kw["input_bytes"])["texts"])) or b"",
        clock=lambda: next(ticks),
    )
    assert calls == [1, 256]
    assert score == 2000


def updates_pin() -> Any:
    from nightshift_agent.trust import WorkloadPin

    return WorkloadPin(image="x@sha256:" + "a" * 64, wants_gpu=True)
