from __future__ import annotations

import base64
import hashlib
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from nightshift_agent.trust import WorkloadPin, key_id

DIGEST = "a" * 64
IMAGE = f"ghcr.io/inrvishal/nightshift-text-embeddings@sha256:{DIGEST}"
NODE = "11111111-1111-4111-8111-111111111111"
ALPINE = "alpine@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab"


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test gets its own state dir and no OS keyring."""
    monkeypatch.setenv("NIGHTSHIFT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NIGHTSHIFT_NO_KEYRING", "1")
    monkeypatch.delenv("NIGHTSHIFT_DEV", raising=False)
    monkeypatch.delenv("NIGHTSHIFT_DEV_PINNED_KEY", raising=False)


class Coordinator:
    """Signs tasks exactly like lib/security/signing.ts."""

    def __init__(self) -> None:
        self.private = Ed25519PrivateKey.generate()
        self.public: Ed25519PublicKey = self.private.public_key()
        self.pem = self.public.public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()
        self.kid = key_id(self.pem)

    @property
    def keys(self) -> dict[str, Ed25519PublicKey]:
        return {self.kid: self.public}

    def task(self, input_bytes: bytes = b'{"texts":["hi"]}', **over: Any) -> tuple[dict[str, Any], str]:
        now = int(time.time())
        task: dict[str, Any] = {
            "v": 1,
            "taskId": "22222222-2222-4222-8222-222222222222",
            "jobId": "33333333-3333-4333-8333-333333333333",
            "nodeId": NODE,
            "attempt": 1,
            "workload": "text_embeddings",
            "image": IMAGE,
            "params": {"model": "all-MiniLM-L6-v2", "normalize": True},
            "itemCount": 1,
            "inputSha256": hashlib.sha256(input_bytes).hexdigest(),
            "iat": now,
            "exp": now + 600,
            "nonce": base64.urlsafe_b64encode(hashlib.sha256(str(time.time_ns()).encode()).digest()[:16])
            .decode()
            .rstrip("="),
        }
        task.update(over)
        text = json.dumps(task)
        return self.sign_text(text), base64.b64encode(input_bytes).decode()

    def sign_text(self, text: str) -> dict[str, Any]:
        return {"task": text, "signature": base64.b64encode(self.private.sign(text.encode())).decode(), "kid": self.kid}


@pytest.fixture
def coord() -> Coordinator:
    return Coordinator()


@pytest.fixture
def whitelist() -> dict[str, WorkloadPin]:
    return {"text_embeddings": WorkloadPin(image=IMAGE, wants_gpu=True)}


@pytest.fixture
def state(tmp_path: Path) -> Path:
    d = tmp_path / "state"
    d.mkdir(parents=True, exist_ok=True)
    return d


Writer = Callable[[Path], None]
