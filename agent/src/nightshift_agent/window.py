"""The owner's local night window, e.g. "23:00-07:00" (may wrap past midnight)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$")


@dataclass(frozen=True)
class Window:
    start_min: int
    end_min: int

    @classmethod
    def parse(cls, text: str) -> Window:
        m = _RE.fullmatch(text.strip())
        if not m:
            raise ValueError('night window must look like "23:00-07:00"')
        h1, m1, h2, m2 = (int(g) for g in m.groups())
        return cls(h1 * 60 + m1, h2 * 60 + m2)

    def contains(self, now: datetime) -> bool:
        """Is local time `now` inside [start, end)? start == end means all day."""
        if self.start_min == self.end_min:
            return True
        m = now.hour * 60 + now.minute
        if self.start_min < self.end_min:
            return self.start_min <= m < self.end_min
        return m >= self.start_min or m < self.end_min

    def __str__(self) -> str:
        return f"{self.start_min // 60:02d}:{self.start_min % 60:02d}-{self.end_min // 60:02d}:{self.end_min % 60:02d}"
