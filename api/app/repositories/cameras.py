"""Camera persistence.

Rows are read with ``SELECT *`` and accessed by column name via
``sqlite3.Row``, so the queries stay literal strings and adding a column
cannot break the mapping functions below.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from ..schemas import CameraCreate, CameraUpdate, redact_stream_url, utc_now
from . import StorageError, iso, parse_iso, require_written_row

# Columns a PATCH is allowed to touch. `update()` checks every incoming column
# against this set before it reaches the statement, so the only identifiers
# that can ever be interpolated are the literals listed here.
UPDATABLE_COLUMNS = frozenset(
    {"name", "stream_url", "location", "enabled", "detection_enabled"}
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
    return conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()


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
    """One optional filter, so each variant is spelled out in full."""
    if enabled is None:
        count_sql = "SELECT COUNT(*) FROM cameras"
        page_sql = "SELECT * FROM cameras ORDER BY id LIMIT ? OFFSET ?"
        filters: list[Any] = []
    else:
        count_sql = "SELECT COUNT(*) FROM cameras WHERE enabled = ?"
        page_sql = (
            "SELECT * FROM cameras WHERE enabled = ? ORDER BY id LIMIT ? OFFSET ?"
        )
        filters = [int(enabled)]

    total = conn.execute(count_sql, filters).fetchone()[0]
    rows = conn.execute(page_sql, [*filters, limit, offset]).fetchall()
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
    return require_written_row(get(conn, payload.id), f"Camera {payload.id!r}")


def update(
    conn: sqlite3.Connection, camera_id: str, payload: CameraUpdate
) -> sqlite3.Row | None:
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return get(conn, camera_id)

    assignments: list[str] = []
    params: list[Any] = []
    for column, value in changes.items():
        if column not in UPDATABLE_COLUMNS:
            raise StorageError(f"column {column!r} is not updatable")
        assignments.append(f"{column} = ?")
        params.append(int(value) if isinstance(value, bool) else value)

    assignments.append("updated_at = ?")
    params.append(iso(utc_now()))
    params.append(camera_id)

    # `assignments` holds only literals drawn from UPDATABLE_COLUMNS, checked
    # in the loop above; every value is a bound parameter.
    statement = f"UPDATE cameras SET {', '.join(assignments)} WHERE id = ?"  # nosec B608

    if conn.execute(statement, params).rowcount == 0:
        return None
    return get(conn, camera_id)


def delete(conn: sqlite3.Connection, camera_id: str) -> bool:
    return conn.execute("DELETE FROM cameras WHERE id = ?", (camera_id,)).rowcount > 0
