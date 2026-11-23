"""An anonymous, stable ID for this machine.

The coordinator uses it to spot one PC registered as several (fake PCs) and
to keep two PCs on the same machine from checking each other. Only a salted
SHA-256 of the machine's own ID is sent; the raw ID never leaves the PC, and
the coordinator stores a keyed hash of what it receives.

Sources, in order: the OS machine ID (Linux /etc/machine-id, Windows
MachineGuid, macOS IOPlatformUUID), then the network card's MAC address. A
determined cheater can change any of these; it's an anchor, not proof.
"""

from __future__ import annotations

import hashlib
import re
import subprocess  # nosec B404 - fixed argument list, never a shell
import sys
import uuid
from collections.abc import Callable
from pathlib import Path

SALT = "nightshift-device-v1:"
LINUX_PATHS = ("/etc/machine-id", "/var/lib/dbus/machine-id")

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


def _read(path: str) -> str | None:
    try:
        return Path(path).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _windows_guid() -> str | None:
    if sys.platform != "win32":
        return None
    import winreg  # noqa: PLC0415 - Windows-only module

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography") as key:
            value, _kind = winreg.QueryValueEx(key, "MachineGuid")
            return str(value).strip() or None
    except OSError:
        return None


def _mac_uuid(runner: Runner) -> str | None:
    try:
        out = runner(
            ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r'"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"', out.stdout or "")
    return m.group(1) if m else None


def _mac_address(getnode: Callable[[], int]) -> str | None:
    node = getnode()
    # Bit 40 set means uuid made the number up (no real MAC found).
    if node >> 40 & 1:
        return None
    return f"{node:012x}"


def machine_id(
    platform: str = sys.platform,
    read: Callable[[str], str | None] = _read,
    windows_guid: Callable[[], str | None] = _windows_guid,
    runner: Runner = subprocess.run,
    getnode: Callable[[], int] = uuid.getnode,
) -> str | None:
    """The machine's own ID, or None if there is none we can read."""
    found: str | None = None
    if platform.startswith("linux"):
        found = next((v.strip() for v in (read(p) for p in LINUX_PATHS) if v and v.strip()), None)
    elif platform == "win32":
        found = windows_guid()
    elif platform == "darwin":
        found = _mac_uuid(runner)
    return found or _mac_address(getnode)


def device_id(raw: str | None = None) -> str | None:
    """sha256 of the salted machine ID, as 64 hex characters (or None)."""
    value = raw if raw is not None else machine_id()
    if not value:
        return None
    return hashlib.sha256(f"{SALT}{value.strip().lower()}".encode()).hexdigest()
