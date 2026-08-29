"""Camera persistence."""

from __future__ import annotations

import sqlite3
from typing import Any

from ..schemas import CameraCreate, CameraUpdate, redact_stream_url, utc_now
from . import iso, parse_iso

_COLUMNS = (
    "id, name, stream_url, location, enabled, detection_enabled, "
    "created_at, updated_at"
)


def row_to_camera(row: sqlite3.Row) -> dict[str, Any]:
    """Shape a DB row into the CameraOut contract, redacting credentials."""
    return {
        "id": row["id"],
        "name": row["name"],
        "stream_url": redact_stream_url(row["stream_url"]),
        "location": row["location"],
        "enabled": bool(row["enabled"]),
        "detection_enabled": bool(row["detection_enabled"]),
        "created_at": parse_iso(row["created_at"]),
        "updated_at": parse_iso(row["updated_at"]),
    }


def get(conn: sqlite3.Connection, camera_id: str) -> sqlite3.Row | None:
    return conn.execute(
        f"SELECT {_COLUMNS} FROM cameras WHERE id = ?", (camera_id,)
    ).fetchone()


def exists(conn: sqlite3.Connection, camera_id: str) -> bool:
    return (
        conn.execute("SELECT 1 FROM cameras WHERE id = ?", (camera_id,)).fetchone()
        is not None
    )


def list_page(
    conn: sqlite3.Connection,
    *,
    enabled: bool | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[sqlite3.Row], int]:
    where, params = "", []
    if enabled is not None:
        where = "WHERE enabled = ?"
        params.append(int(enabled))

    total = conn.execute(f"SELECT COUNT(*) FROM cameras {where}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT {_COLUMNS} FROM cameras {where} ORDER BY id LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return rows, total


def create(conn: sqlite3.Connection, payload: CameraCreate) -> sqlite3.Row:
    now = iso(utc_now())
    conn.execute(
        """
        INSERT INTO cameras (
            id, name, stream_url, location, enabled, detection_enabled,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload.id,
            payload.name,
            payload.stream_url,
            payload.location,
            int(payload.enabled),
            int(payload.detection_enabled),
            now,
            now,
        ),
    )
    row = get(conn, payload.id)
    assert row is not None  # just inserted inside the same transaction
    return row


def update(
    conn: sqlite3.Connection, camera_id: str, payload: CameraUpdate
) -> sqlite3.Row | None:
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return get(conn, camera_id)

    assignments, params = [], []
    for column, value in changes.items():
        assignments.append(f"{column} = ?")
        params.append(int(value) if isinstance(value, bool) else value)

    assignments.append("updated_at = ?")
    params.append(iso(utc_now()))
    params.append(camera_id)

    cursor = conn.execute(
        f"UPDATE cameras SET {', '.join(assignments)} WHERE id = ?", params
    )
    if cursor.rowcount == 0:
        return None
    return get(conn, camera_id)


def delete(conn: sqlite3.Connection, camera_id: str) -> bool:
    return conn.execute("DELETE FROM cameras WHERE id = ?", (camera_id,)).rowcount > 0
