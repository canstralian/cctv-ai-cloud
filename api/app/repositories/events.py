"""Detection-event persistence and aggregate stats."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta
from typing import Any

from ..schemas import EventCreate, utc_now
from . import iso, parse_iso, require_written_row

# Each supported filter maps to a literal SQL fragment with a bound parameter.
# The composed WHERE clause is therefore always a join of these constants --
# no caller-supplied text can reach the statement. Order is fixed so the
# generated SQL is stable and the parameter list lines up with it.
_FILTER_CLAUSES: dict[str, str] = {
    "camera_id": "camera_id = ?",
    "label": "label = ?",
    "min_score": "score >= ?",
    "since": "started_at >= ?",
    "until": "started_at < ?",
}


def row_to_event(row: sqlite3.Row) -> dict[str, Any]:
    try:
        attributes = json.loads(row["attributes"])
    except (TypeError, ValueError):
        attributes = {}

    return {
        "id": row["id"],
        "camera_id": row["camera_id"],
        "label": row["label"],
        "score": row["score"],
        "started_at": parse_iso(row["started_at"]),
        "ended_at": parse_iso(row["ended_at"]),
        "thumbnail_path": row["thumbnail_path"],
        "clip_path": row["clip_path"],
        "attributes": attributes if isinstance(attributes, dict) else {},
        "created_at": parse_iso(row["created_at"]),
    }


def get(conn: sqlite3.Connection, event_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()


def _build_where(values: dict[str, Any]) -> tuple[str, list[Any]]:
    """Compose the WHERE clause from literal fragments, in declaration order."""
    clauses: list[str] = []
    params: list[Any] = []
    for name, clause in _FILTER_CLAUSES.items():
        value = values.get(name)
        if value is None:
            continue
        clauses.append(clause)
        params.append(iso(value) if isinstance(value, datetime) else value)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


def list_page(
    conn: sqlite3.Connection,
    *,
    camera_id: str | None = None,
    label: str | None = None,
    min_score: float | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[sqlite3.Row], int]:
    where, params = _build_where(
        {
            "camera_id": camera_id,
            "label": label,
            "min_score": min_score,
            "since": since,
            "until": until,
        }
    )

    # `where` is a join of _FILTER_CLAUSES literals; every value below is a
    # bound parameter, so nothing caller-supplied reaches the statement text.
    tail = "ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?"
    count_sql = f"SELECT COUNT(*) FROM events {where}"  # nosec B608
    page_sql = f"SELECT * FROM events {where} {tail}"  # nosec B608

    total = conn.execute(count_sql, params).fetchone()[0]
    rows = conn.execute(page_sql, [*params, limit, offset]).fetchall()
    return rows, total


def create(conn: sqlite3.Connection, payload: EventCreate) -> sqlite3.Row:
    event_id = uuid.uuid4().hex
    conn.execute(
        """
        INSERT INTO events (
            id, camera_id, label, score, started_at, ended_at,
            thumbnail_path, clip_path, attributes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            payload.camera_id,
            payload.label,
            payload.score,
            iso(payload.started_at),
            iso(payload.ended_at) if payload.ended_at else None,
            payload.thumbnail_path,
            payload.clip_path,
            json.dumps(payload.attributes),
            iso(utc_now()),
        ),
    )
    return require_written_row(get(conn, event_id), f"Event {event_id!r}")


def delete(conn: sqlite3.Connection, event_id: str) -> bool:
    return conn.execute("DELETE FROM events WHERE id = ?", (event_id,)).rowcount > 0


def prune_older_than(conn: sqlite3.Connection, cutoff: datetime) -> int:
    """Delete events that started before `cutoff`. Returns rows removed."""
    return conn.execute(
        "DELETE FROM events WHERE started_at < ?", (iso(cutoff),)
    ).rowcount


def stats(conn: sqlite3.Connection, *, top_n: int = 10) -> dict[str, Any]:
    cameras_total, cameras_enabled = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(enabled), 0) FROM cameras"
    ).fetchone()

    events_total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    # Bound the window at both ends off one captured instant. Ingest accepts
    # whatever timestamp a caller sends, so an unbounded lower-bound query
    # would let a future-dated event inflate a "last 24 hours" figure.
    now = utc_now()
    events_last_24h = conn.execute(
        "SELECT COUNT(*) FROM events WHERE started_at >= ? AND started_at <= ?",
        (iso(now - timedelta(days=1)), iso(now)),
    ).fetchone()[0]

    last_event_at = conn.execute("SELECT MAX(started_at) FROM events").fetchone()[0]

    by_label = conn.execute(
        """
        SELECT label, COUNT(*) AS count FROM events
        GROUP BY label ORDER BY count DESC, label ASC LIMIT ?
        """,
        (top_n,),
    ).fetchall()

    by_camera = conn.execute(
        """
        SELECT camera_id, COUNT(*) AS count FROM events
        GROUP BY camera_id ORDER BY count DESC, camera_id ASC LIMIT ?
        """,
        (top_n,),
    ).fetchall()

    return {
        "cameras_total": cameras_total,
        "cameras_enabled": int(cameras_enabled),
        "events_total": events_total,
        "events_last_24h": events_last_24h,
        "last_event_at": parse_iso(last_event_at),
        "events_by_label": [
            {"label": r["label"], "count": r["count"]} for r in by_label
        ],
        "events_by_camera": [
            {"camera_id": r["camera_id"], "count": r["count"]} for r in by_camera
        ],
    }
