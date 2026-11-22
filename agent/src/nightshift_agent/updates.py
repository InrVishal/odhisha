"""Updates only from signed releases.

A release is a wheel plus `manifest.json` ({"version", "wheel", "sha256"})
and `manifest.sig` (Ed25519 over the manifest bytes, base64). The release
public key is pinned here; the private key exists only as a GitHub Actions
secret used by the release workflow. The agent installs a wheel only if the
signature verifies AND the wheel's sha256 matches the signed manifest.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import shutil
import subprocess  # nosec B404 - argument lists only, never a shell
from dataclasses import dataclass
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

RELEASE_KEY_PEM = """REPLACE_RELEASE_KEY"""


class ReleaseError(Exception):
    pass


@dataclass(frozen=True)
class Release:
    version: str
    wheel: str
    sha256: str


def _release_key(pem: str | None = None) -> Ed25519PublicKey:
    text = pem or RELEASE_KEY_PEM
    if "REPLACE" in text:
        raise ReleaseError("no release key pinned in this build")
    key = serialization.load_pem_public_key(text.encode())
    if not isinstance(key, Ed25519PublicKey):
        raise ReleaseError("release key must be Ed25519")
    return key


def verify_release(manifest: bytes, signature_b64: bytes, wheel: Path, *, pem: str | None = None) -> Release:
    try:
        sig = base64.b64decode(signature_b64.strip(), validate=True)
    except (binascii.Error, ValueError) as err:
        raise ReleaseError("signature isn't base64") from err
    try:
        _release_key(pem).verify(sig, manifest)
    except InvalidSignature as err:
        raise ReleaseError("release signature doesn't verify") from err
    try:
        data = json.loads(manifest)
        rel = Release(version=str(data["version"]), wheel=str(data["wheel"]), sha256=str(data["sha256"]).lower())
    except (KeyError, ValueError, TypeError) as err:
        raise ReleaseError("bad manifest") from err
    if wheel.name != rel.wheel:
        raise ReleaseError("wheel file name doesn't match the manifest")
    if hashlib.sha256(wheel.read_bytes()).hexdigest() != rel.sha256:
        raise ReleaseError("wheel doesn't match the signed sha256")
    return rel


def install(wheel: Path) -> int:
    """pipx install of a verified wheel (argument list, no shell)."""
    pipx = shutil.which("pipx")
    if not pipx:
        raise ReleaseError("pipx not found")
    return subprocess.run([pipx, "install", "--force", str(wheel)], check=False, shell=False).returncode  # noqa: S603  # nosec B603 - verified wheel, argument list
