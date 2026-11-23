from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from typing import Any

from nightshift_agent.device import SALT, device_id, machine_id
from nightshift_agent.runner import Agent

from .test_runner import FakeClient, make_agent


def _no_mac() -> int:
    return 1 << 40  # uuid's "made up" bit: no real MAC


def test_linux_reads_machine_id() -> None:
    files = {"/etc/machine-id": "abc123\n"}
    assert machine_id("linux", read=files.get, getnode=_no_mac) == "abc123"
    # Falls back to the dbus copy.
    assert machine_id("linux", read={"/var/lib/dbus/machine-id": "def"}.get, getnode=_no_mac) == "def"


def test_windows_uses_machine_guid() -> None:
    assert machine_id("win32", windows_guid=lambda: "GUID-1", getnode=_no_mac) == "GUID-1"


def test_macos_parses_ioreg_without_a_shell() -> None:
    seen: dict[str, Any] = {}

    def runner(args: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        seen.update(args=args, **kw)
        return subprocess.CompletedProcess(args, 0, '  "IOPlatformUUID" = "12345678-1234-1234-1234-123456789ABC"\n', "")

    assert machine_id("darwin", runner=runner, getnode=_no_mac) == "12345678-1234-1234-1234-123456789ABC"
    assert seen["shell"] is False and seen["args"][0] == "/usr/sbin/ioreg"


def test_falls_back_to_a_real_mac_address_and_never_a_made_up_one() -> None:
    assert machine_id("linux", read=lambda _p: None, getnode=lambda: 0x0242AC110002) == "0242ac110002"
    assert machine_id("linux", read=lambda _p: None, getnode=_no_mac) is None


def test_device_id_is_a_salted_hash_never_the_raw_id() -> None:
    d = device_id("abc123")
    assert d == hashlib.sha256(f"{SALT}abc123".encode()).hexdigest()
    assert d is not None and len(d) == 64 and "abc123" not in d
    assert device_id("ABC123 ") == d
    assert device_id("") is None


def test_heartbeat_sends_the_device_id_once_worked_out(coord: Any, whitelist: Any, state: Path) -> None:
    client = FakeClient(coord)
    agent: Agent = make_agent(coord, whitelist, state, client)
    calls = {"n": 0}

    def fake_device() -> str:
        calls["n"] += 1
        return "f" * 64

    agent.device = fake_device
    agent.heartbeat(force=True)
    agent.heartbeat(force=True)
    beats = [c for c in client.calls if c[1] == "/api/agent/heartbeat"]
    assert all(b[2]["deviceId"] == "f" * 64 for b in beats)
    assert calls["n"] == 1


def test_no_device_id_means_none_is_sent(coord: Any, whitelist: Any, state: Path) -> None:
    client = FakeClient(coord)
    agent = make_agent(coord, whitelist, state, client)
    agent.device = lambda: None
    agent.heartbeat(force=True)
    assert "deviceId" not in client.calls[0][2]
