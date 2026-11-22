"""Where the agent talks to, and where it keeps its state.

The API must be HTTPS. Plain HTTP is allowed only to localhost, and only in
dev mode (``NIGHTSHIFT_DEV=1``), for running against a local server.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_API = "https://nightshift-ten-iota.vercel.app"
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


class ConfigError(Exception):
    """Configuration the agent refuses to run with."""


def dev_mode() -> bool:
    return os.environ.get("NIGHTSHIFT_DEV") == "1"


def validate_api_url(url: str, *, dev: bool | None = None) -> str:
    """Returns the normalised base URL, or raises ConfigError."""
    dev = dev_mode() if dev is None else dev
    parts = urlsplit(url.strip())
    if parts.username or parts.password:
        raise ConfigError("the API URL must not contain credentials")
    if parts.query or parts.fragment:
        raise ConfigError("the API URL must not have a query or fragment")
    host = (parts.hostname or "").lower()
    if not host:
        raise ConfigError("the API URL has no host")
    if parts.scheme == "https" or (parts.scheme == "http" and host in LOCAL_HOSTS and dev):
        pass
    elif parts.scheme == "http" and host in LOCAL_HOSTS:
        raise ConfigError("plain HTTP is only allowed to localhost in dev mode (NIGHTSHIFT_DEV=1)")
    else:
        raise ConfigError("the API URL must use https://")
    port = f":{parts.port}" if parts.port else ""
    netloc = f"[{host}]{port}" if ":" in host else f"{host}{port}"
    return f"{parts.scheme}://{netloc}{parts.path.rstrip('/')}"


def state_dir() -> Path:
    """Per-user state: config, nonce store, logs, pause flag."""
    override = os.environ.get("NIGHTSHIFT_STATE_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "NightShift"
    base = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return base / "nightshift"


@dataclass
class AgentConfig:
    api: str = DEFAULT_API
    node_id: str | None = None
    #: Optional local night window, "HH:MM-HH:MM". The server enforces the
    #: owner's dashboard window too; this one also applies locally.
    window: str | None = None
    #: Declared wattage for CPU mode (no NVIDIA GPU). Reported as an estimate.
    cpu_watts: int = 65
    #: Use the NVIDIA GPU in containers when one is present.
    use_gpu: bool = True
    extra: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, directory: Path | None = None) -> AgentConfig:
        path = (directory or state_dir()) / "config.json"
        if not path.exists():
            return cls()
        data = json.loads(path.read_text(encoding="utf-8"))
        known = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
        cfg = cls(**known)
        cfg.api = validate_api_url(cfg.api)
        return cfg

    def save(self, directory: Path | None = None) -> None:
        d = directory or state_dir()
        d.mkdir(parents=True, exist_ok=True)
        write_private(d / "config.json", json.dumps(asdict(self), indent=2).encode())


def write_private(path: Path, data: bytes) -> None:
    """Writes a file only the current user can read (0600 on POSIX), atomically."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    if sys.platform != "win32":
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)
