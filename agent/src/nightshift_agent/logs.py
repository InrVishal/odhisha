"""Logging with secrets removed. Tokens never reach a log line."""

from __future__ import annotations

import logging
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path

from nightshift_agent.config import state_dir

_SECRETS = [
    (re.compile(r"nsn_[A-Za-z0-9_-]{8,}"), "nsn_[redacted]"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"), r"\1[redacted]"),
    (re.compile(r"(?i)(authorization['\"]?\s*[:=]\s*['\"]?)[^'\",}\s]+"), r"\1[redacted]"),
]


def redact(text: str) -> str:
    for pattern, replacement in _SECRETS:
        text = pattern.sub(replacement, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = None
        return True


def log_path(directory: Path | None = None) -> Path:
    return (directory or state_dir()) / "agent.log"


def setup(directory: Path | None = None, *, verbose: bool = False) -> logging.Logger:
    logger = logging.getLogger("nightshift")
    logger.handlers.clear()
    logger.setLevel(logging.DEBUG if verbose else logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    path = log_path(directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    for handler in (
        RotatingFileHandler(path, maxBytes=1_000_000, backupCount=3, encoding="utf-8"),
        logging.StreamHandler(),
    ):
        handler.setFormatter(fmt)
        handler.addFilter(RedactingFilter())
        logger.addHandler(handler)
    return logger


def tail(n: int = 50, directory: Path | None = None) -> list[str]:
    path = log_path(directory)
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return [redact(line) for line in lines[-n:]]
