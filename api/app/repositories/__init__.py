"""Data access helpers. Routers talk to these, never to SQL directly."""

from __future__ import annotations

from datetime import UTC, datetime

ISO_FORMAT_NOTE = (
    "Timestamps are stored as fixed-width UTC ISO-8601 strings so that "
    "lexicographic ordering in SQLite matches chronological ordering."
)


def iso(value: datetime) -> str:
    """Serialise a datetime to a fixed-width UTC ISO-8601 string."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return (
        value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    )


def parse_iso(value: str | None) -> datetime | None:
    """Inverse of :func:`iso`."""
    if value is None:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
