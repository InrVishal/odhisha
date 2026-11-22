"""The node token: kept in the OS keyring, or a 0600 file if there is none.

The token is never printed, logged, or written anywhere else.
"""

from __future__ import annotations

import contextlib
import os
import re
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from nightshift_agent.config import state_dir, write_private

_keyring_module: ModuleType | None
_fail_backend: ModuleType | None
try:
    import keyring as _keyring_module
    from keyring.backends import fail as _fail_backend
except ImportError:  # pragma: no cover - keyring is a dependency
    _keyring_module = None
    _fail_backend = None

SERVICE = "nightshift-agent"
USERNAME = "node-token"
TOKEN_RE = re.compile(r"^nsn_[A-Za-z0-9_-]{43}$")


class TokenError(Exception):
    pass


def check_token(token: str) -> str:
    token = token.strip()
    if not TOKEN_RE.fullmatch(token):
        raise TokenError("that doesn't look like a NightShift node token (nsn_ followed by 43 characters)")
    return token


def _keyring() -> Any:
    """The keyring module if a real backend is available, else None."""
    if os.environ.get("NIGHTSHIFT_NO_KEYRING") == "1":
        return None
    if _keyring_module is None or _fail_backend is None:  # pragma: no cover
        return None
    keyring = _keyring_module
    backend = keyring.get_keyring()
    if isinstance(backend, _fail_backend.Keyring) or "null" in type(backend).__name__.lower():
        return None
    return keyring


def _token_file(directory: Path | None) -> Path:
    return (directory or state_dir()) / "token"


def save_token(token: str, directory: Path | None = None) -> str:
    """Stores the token. Returns where it went: "keyring" or "file"."""
    token = check_token(token)
    kr = _keyring()
    if kr is not None:
        kr.set_password(SERVICE, USERNAME, token)
        _token_file(directory).unlink(missing_ok=True)
        return "keyring"
    d = directory or state_dir()
    d.mkdir(parents=True, exist_ok=True)
    write_private(_token_file(directory), token.encode())
    return "file"


def load_token(directory: Path | None = None) -> str | None:
    kr = _keyring()
    if kr is not None:
        value = kr.get_password(SERVICE, USERNAME)
        if value:
            return check_token(str(value))
    path = _token_file(directory)
    if not path.exists():
        return None
    if sys.platform != "win32" and path.stat().st_mode & 0o077:
        raise TokenError(f"{path} is readable by other users; run `chmod 600 {path}`")
    return check_token(path.read_text(encoding="utf-8"))


def delete_token(directory: Path | None = None) -> None:
    kr = _keyring()
    if kr is not None:
        # Nothing stored is fine; any keyring error here must not block logout.
        with contextlib.suppress(Exception):
            kr.delete_password(SERVICE, USERNAME)
    _token_file(directory).unlink(missing_ok=True)
