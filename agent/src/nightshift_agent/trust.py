"""What the agent trusts: pinned coordinator keys and the workload whitelist.

Every task is checked here before anything runs. A task is refused unless:
- its Ed25519 signature verifies against a key PINNED IN THIS FILE (the key
  id is recomputed from the pinned key, never taken from the task),
- it's version 1, not expired, issued for THIS node,
- its nonce hasn't been seen before (persistent nonce store),
- its workload is on the whitelist and its image is exactly the pinned digest,
- the input bytes hash to the signed `inputSha256`.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from nightshift_agent.nonces import NonceStore

# ─── Pinned coordinator public keys ────────────────────────────────────────

#: Vercel Preview environment (every preview deployment).
#: kid 052ed2bc229d420f
PREVIEW_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApXeRgVXwRdzUjCMQ9lmKQUXji8J5zuDZnvMW7DmLHis=
-----END PUBLIC KEY-----
"""

#: Vercel Production environment.
PRODUCTION_KEY_PEM: str | None = None

#: Clock skew we tolerate on `iat` (tasks issued "in the future").
MAX_SKEW_S = 300


def key_id(pem: str) -> str:
    """First 16 hex chars of sha256(SPKI DER), same as the coordinator's `kid`."""
    key = serialization.load_pem_public_key(pem.encode())
    der = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(der).hexdigest()[:16]


def pinned_keys() -> dict[str, Ed25519PublicKey]:
    pems = [p for p in (PREVIEW_KEY_PEM, PRODUCTION_KEY_PEM) if p and "REPLACE" not in p]
    dev = os.environ.get("NIGHTSHIFT_DEV_PINNED_KEY")
    if dev and os.environ.get("NIGHTSHIFT_DEV") == "1":
        pems.append(dev)
    out: dict[str, Ed25519PublicKey] = {}
    for pem in pems:
        key = serialization.load_pem_public_key(pem.encode())
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError("pinned keys must be Ed25519")
        out[key_id(pem)] = key
    return out


# ─── Workload whitelist ────────────────────────────────────────────────────


@dataclass(frozen=True)
class WorkloadPin:
    #: Exact image reference, `name@sha256:<64 hex>`. Never a tag.
    image: str
    #: Whether the workload benefits from the GPU (`--gpus` is added only then).
    wants_gpu: bool
    memory: str = "4g"
    cpus: str = "2"


def is_digest_pinned(image: str) -> bool:
    name, sep, digest = image.partition("@sha256:")
    return bool(name) and sep == "@sha256:" and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)


#: Filled with the digests the release pipeline builds (see agent/workloads/).
WHITELIST: dict[str, WorkloadPin] = {}


# ─── Task verification ─────────────────────────────────────────────────────


class TaskRejected(Exception):
    def __init__(self, reason: str, task: dict[str, Any] | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        #: Only set when the signature checked out, so the ids can be trusted.
        self.task = task


@dataclass(frozen=True)
class VerifiedTask:
    task_id: str
    job_id: str
    attempt: int
    workload: str
    pin: WorkloadPin
    params: dict[str, Any]
    item_count: int
    expires_at: int
    input: bytes


def verify_task(
    signed: Any,
    input_b64: Any,
    *,
    node_id: str,
    nonces: NonceStore,
    keys: dict[str, Ed25519PublicKey] | None = None,
    whitelist: dict[str, WorkloadPin] | None = None,
    now: float | None = None,
) -> VerifiedTask:
    keys = pinned_keys() if keys is None else keys
    whitelist = WHITELIST if whitelist is None else whitelist
    now = time.time() if now is None else now

    if (
        not isinstance(signed, dict)
        or not isinstance(signed.get("task"), str)
        or not isinstance(signed.get("signature"), str)
    ):
        raise TaskRejected("bad_format")
    text: str = signed["task"]
    try:
        signature = base64.b64decode(signed["signature"], validate=True)
    except (binascii.Error, ValueError) as err:
        raise TaskRejected("bad_signature") from err
    # Try only the key the task names, but look it up in OUR pinned set.
    kid = signed.get("kid")
    key = keys.get(kid) if isinstance(kid, str) else None
    if key is None:
        raise TaskRejected("unknown_key")
    try:
        key.verify(signature, text.encode("utf-8"))
    except InvalidSignature as err:
        raise TaskRejected("bad_signature") from err

    try:
        task = json.loads(text)
    except json.JSONDecodeError as err:
        raise TaskRejected("bad_format") from err
    if not isinstance(task, dict):
        raise TaskRejected("bad_format")
    if task.get("v") != 1:
        raise TaskRejected("unsupported_version", task)
    for field, kind in (
        ("taskId", str),
        ("jobId", str),
        ("nodeId", str),
        ("nonce", str),
        ("workload", str),
        ("inputSha256", str),
    ):
        if not isinstance(task.get(field), kind):
            raise TaskRejected("bad_format", task)
    for field in ("attempt", "itemCount", "iat", "exp"):
        if not isinstance(task.get(field), int) or isinstance(task.get(field), bool):
            raise TaskRejected("bad_format", task)
    if not isinstance(task.get("params"), dict):
        raise TaskRejected("bad_format", task)

    if task["exp"] <= now:
        raise TaskRejected("expired", task)
    if task["iat"] > now + MAX_SKEW_S:
        raise TaskRejected("issued_in_future", task)
    if task["nodeId"] != node_id:
        raise TaskRejected("wrong_node", task)

    pin = whitelist.get(task["workload"])
    if pin is None:
        raise TaskRejected("workload_not_allowed", task)
    image = task.get("image")
    if not isinstance(image, str) or not is_digest_pinned(pin.image) or image != pin.image:
        raise TaskRejected("image_mismatch", task)

    if not isinstance(input_b64, str):
        raise TaskRejected("bad_format", task)
    try:
        data = base64.b64decode(input_b64, validate=True)
    except (binascii.Error, ValueError) as err:
        raise TaskRejected("input_mismatch", task) from err
    if hashlib.sha256(data).hexdigest() != task["inputSha256"]:
        raise TaskRejected("input_mismatch", task)

    # Last, so a task rejected for any other reason doesn't burn its nonce.
    if not nonces.add(task["nonce"], task["exp"], now=now):
        raise TaskRejected("replayed_nonce", task)

    return VerifiedTask(
        task_id=task["taskId"],
        job_id=task["jobId"],
        attempt=task["attempt"],
        workload=task["workload"],
        pin=pin,
        params=task["params"],
        item_count=task["itemCount"],
        expires_at=task["exp"],
        input=data,
    )
