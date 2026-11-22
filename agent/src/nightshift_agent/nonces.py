"""Persistent store of task nonces seen, kept until each task expires.

A replayed task (same nonce) is refused even after an agent restart.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from nightshift_agent.config import write_private

#: Keep nonces a little past expiry to cover clock skew.
GRACE_S = 600
MAX_ENTRIES = 50_000


class NonceStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self._seen: dict[str, int] = {}
        if path and path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self._seen = {str(k): int(v) for k, v in raw.items()}
            except (ValueError, OSError):
                # A corrupt store fails closed: start empty but keep the file
                # aside, and expiry checks still stop old tasks.
                path.replace(path.with_suffix(".corrupt"))

    def __contains__(self, nonce: str) -> bool:
        return nonce in self._seen

    def __len__(self) -> int:
        return len(self._seen)

    def add(self, nonce: str, expires_at: int, *, now: float | None = None) -> bool:
        """Records the nonce. Returns False if it was already seen."""
        now = time.time() if now is None else now
        self._prune(now)
        if nonce in self._seen:
            return False
        if len(self._seen) >= MAX_ENTRIES:
            oldest = min(self._seen, key=self._seen.__getitem__)
            del self._seen[oldest]
        self._seen[nonce] = int(expires_at) + GRACE_S
        self._save()
        return True

    def _prune(self, now: float) -> None:
        self._seen = {n: t for n, t in self._seen.items() if t > now}

    def _save(self) -> None:
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            write_private(self.path, json.dumps(self._seen).encode())
