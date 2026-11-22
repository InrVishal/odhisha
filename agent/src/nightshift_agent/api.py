"""HTTPS client for the coordinator. Outbound only; TLS is always verified.

There is no option to turn certificate checks off.
"""

from __future__ import annotations

import json
import os
import random
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from nightshift_agent import __version__
from nightshift_agent.config import validate_api_url

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
TIMEOUT_S = 30


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str = "") -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code


@dataclass
class Response:
    status: int
    body: dict[str, Any]


def backoff_delay(attempt: int, *, base: float = 2.0, cap: float = 300.0, rng: random.Random | None = None) -> float:
    """Exponential backoff with full jitter: uniform(0, min(cap, base * 2**attempt))."""
    r = rng or random.SystemRandom()
    return r.uniform(0, min(cap, base * (2 ** max(0, attempt))))


class Client:
    def __init__(self, api: str, token: str, *, opener: urllib.request.OpenerDirector | None = None) -> None:
        self.api = validate_api_url(api)
        self._token = token
        ctx = ssl.create_default_context()
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        self._opener = opener or urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))

    def __repr__(self) -> str:  # never show the token
        return f"Client(api={self.api!r})"

    def request(
        self, method: str, path: str, *, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> Response:
        if not path.startswith("/api/"):
            raise ValueError("path must start with /api/")
        req = urllib.request.Request(self.api + path, data=body, method=method)  # noqa: S310 - scheme validated above
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("User-Agent", f"nightshift-agent/{__version__}")
        req.add_header("Content-Type", "application/json")
        # Protected Vercel previews only (CI and demos against a preview). The
        # value is a Vercel automation secret, not the node token.
        bypass = os.environ.get("NIGHTSHIFT_VERCEL_BYPASS")
        if bypass and ".vercel.app" in self.api:
            req.add_header("x-vercel-protection-bypass", bypass)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with self._opener.open(req, timeout=TIMEOUT_S) as res:
                raw = res.read(MAX_RESPONSE_BYTES + 1)
                status = res.status
        except urllib.error.HTTPError as err:
            raw = err.read(64 * 1024)
            status = err.code
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ApiError(status, "response_too_large")
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise ApiError(status, "bad_response") from err
        if not isinstance(data, dict):
            raise ApiError(status, "bad_response")
        if status >= 400:
            raise ApiError(status, str(data.get("error", "error")), str(data.get("message", "")))
        return Response(status, data)

    def post_json(
        self, path: str, payload: dict[str, Any] | None = None, headers: dict[str, str] | None = None
    ) -> Response:
        return self.request("POST", path, body=json.dumps(payload or {}).encode(), headers=headers)

    def signing_key(self) -> dict[str, Any]:
        return self.request("GET", "/api/agent/signing-key").body
