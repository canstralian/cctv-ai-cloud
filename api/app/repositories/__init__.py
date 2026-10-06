"""Data access helpers. Routers talk to these, never to SQL directly."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

ISO_FORMAT_NOTE = (
    "Timestamps are stored as fixed-width UTC ISO-8601 strings so that "
    "lexicographic ordering in SQLite matches chronological ordering."
)


class StorageError(RuntimeError):
    """A storage invariant this layer guarantees was violated."""


def iso(value: datetime) -> str:
    """Serialise a datetime to a fixed-width UTC ISO-8601 string."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return (
        value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    )


def parse_iso(value: str | None) -> datetime | None:
    """Inverse of :func:`iso`. ``fromisoformat`` handles the ``Z`` suffix."""
    if value is None:
        return None
    return datetime.fromisoformat(value)


def require_written_row(row: sqlite3.Row | None, resource: str) -> sqlite3.Row:
    """Return a row just written in this transaction, or fail loudly.

    An ``assert`` here would be compiled away under ``python -O``, turning a
    broken invariant into a ``None`` masquerading as a row. Raise instead.
    """
    if row is None:
        raise StorageError(f"{resource} could not be read back after writing it")
    return row
