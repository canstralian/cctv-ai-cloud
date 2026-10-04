"""SQLite storage.

The API is a sidecar to a self-hosted NVR, so the store stays deliberately
small: stdlib sqlite3, one connection per request, WAL for concurrent readers.
No ORM to install, no server to run.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS cameras (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    stream_url        TEXT NOT NULL,
    location          TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    detection_enabled INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id             TEXT PRIMARY KEY,
    camera_id      TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    score          REAL NOT NULL,
    started_at     TEXT NOT NULL,
    ended_at       TEXT,
    thumbnail_path TEXT,
    clip_path      TEXT,
    attributes     TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_started_at
    ON events (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_camera_started
    ON events (camera_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_label_started
    ON events (label, started_at DESC);
"""


def connect(database_path: Path) -> sqlite3.Connection:
    """Open a connection with the pragmas this app depends on."""
    if str(database_path) != ":memory:":
        database_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(database_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    if str(database_path) != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(database_path: Path) -> None:
    """Create tables and indexes if they are not already there."""
    with closing_connection(database_path) as conn:
        conn.executescript(SCHEMA)


@contextmanager
def closing_connection(database_path: Path) -> Iterator[sqlite3.Connection]:
    conn = connect(database_path)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Wrap a unit of work; rolls back on any exception."""
    conn.execute("BEGIN")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
