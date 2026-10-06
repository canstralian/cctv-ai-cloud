"""Regression tests for the review findings on PR #3.

Each test here failed against the code as originally written; they exist so
those seven defects cannot return silently.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import REPO_ROOT, Settings
from app.db import is_foreign_key_violation
from tests.conftest import TEST_SECRET, make_event

CREDENTIALLED_URL = "file://admin:SuperSecret123@10.0.0.9/stream"


# 1 (high) -- validation errors must not echo the submitted value back.


def test_validation_error_does_not_echo_stream_url_credentials(
    client: TestClient, write_headers: dict
) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={"id": "bad", "name": "Bad", "stream_url": CREDENTIALLED_URL},
    )

    assert response.status_code == 422
    assert "SuperSecret123" not in response.text
    assert "10.0.0.9" not in response.text


def test_validation_error_still_identifies_the_bad_field(
    client: TestClient, write_headers: dict
) -> None:
    """Redaction must not make the error useless."""
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={"id": "bad", "name": "Bad", "stream_url": CREDENTIALLED_URL},
    )

    details = response.json()["error"]["details"]
    assert any("stream_url" in str(entry.get("loc", "")) for entry in details)
    assert all("input" not in entry for entry in details)


def test_oversized_value_is_not_echoed(client: TestClient, write_headers: dict) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={
            "id": "big",
            "name": "Big",
            "stream_url": "rtsp://u:hunter2@h/" + "a" * 4000,
        },
    )

    assert response.status_code == 422
    assert "hunter2" not in response.text


# 2 (medium) -- a relative DATABASE_PATH belongs to the repo root, not the CWD.


def test_relative_database_path_is_anchored_to_the_repo_root() -> None:
    settings = Settings(
        env="dev", database_path=Path("data/cctv.db"), jwt_secret=TEST_SECRET
    )

    assert settings.database_path.is_absolute()
    assert settings.database_path == REPO_ROOT / "data" / "cctv.db"


def test_absolute_database_path_is_left_alone() -> None:
    settings = Settings(
        env="dev", database_path=Path("/data/cctv.db"), jwt_secret=TEST_SECRET
    )

    assert settings.database_path == Path("/data/cctv.db")


def test_in_memory_database_path_is_left_alone() -> None:
    settings = Settings(
        env="dev", database_path=Path(":memory:"), jwt_secret=TEST_SECRET
    )

    assert str(settings.database_path) == ":memory:"


# 3 (medium) -- an unexpected failure still owes the caller the envelope.


def test_unhandled_exception_returns_the_error_envelope(app: FastAPI) -> None:
    from app.routers import stats as stats_router

    @app.get("/api/v1/_boom")
    def _boom() -> None:
        raise RuntimeError("storage exploded")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/v1/_boom", headers={"X-Request-ID": "trace-me"})

    assert response.status_code == 500
    body = response.json()
    assert body["error"]["code"] == "internal_error"
    assert body["error"]["request_id"] == "trace-me"
    assert response.headers["X-Request-ID"] == "trace-me"
    assert stats_router is not None  # keep the import meaningful for linters


def test_unhandled_exception_does_not_leak_the_cause(app: FastAPI) -> None:
    @app.get("/api/v1/_boom2")
    def _boom() -> None:
        raise RuntimeError("connection string postgres://user:pw@host/db")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/v1/_boom2")

    assert "postgres://" not in response.text
    assert "storage exploded" not in response.text


# 4 (medium) -- "last 24 hours" is a window, not a lower bound.


def test_future_dated_events_are_excluded_from_the_24h_count(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    future = (datetime.now(UTC) + timedelta(days=400)).isoformat()
    client.post(
        "/api/v1/events",
        headers=write_headers,
        json={**make_event(), "started_at": future},
    )
    client.post("/api/v1/events", headers=write_headers, json=make_event(minutes_ago=5))

    body = client.get("/api/v1/stats", headers=read_headers).json()

    assert body["events_total"] == 2
    assert body["events_last_24h"] == 1


# 5 (medium) -- a camera deleted mid-flight is a 404, not a 500.


def test_ingest_against_a_camera_deleted_mid_flight_is_404(
    client: TestClient, write_headers: dict, camera: dict, settings
) -> None:
    """Delete the camera behind the API's back, then ingest against it."""
    with sqlite3.connect(settings.database_path) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("DELETE FROM events WHERE camera_id = 'front-door'")
        conn.execute("DELETE FROM cameras WHERE id = 'front-door'")

    response = client.post("/api/v1/events", headers=write_headers, json=make_event())

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_foreign_key_violations_are_recognised() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("CREATE TABLE parent (id TEXT PRIMARY KEY)")
    conn.execute(
        "CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))"
    )

    with pytest.raises(sqlite3.IntegrityError) as fk:
        conn.execute("INSERT INTO child VALUES ('c', 'missing')")
    assert is_foreign_key_violation(fk.value)

    conn.execute("INSERT INTO parent VALUES ('p')")
    conn.execute("INSERT INTO child VALUES ('c', 'p')")
    with pytest.raises(sqlite3.IntegrityError) as pk:
        conn.execute("INSERT INTO child VALUES ('c', 'p')")
    assert not is_foreign_key_violation(pk.value)

    conn.close()


# 6 (medium) -- a scheme without a host is not a stream.


@pytest.mark.parametrize(
    "stream_url",
    ["rtsp:///stream", "https:path", "rtsp://", "http:///x"],
)
def test_host_less_stream_urls_are_rejected(
    client: TestClient, write_headers: dict, stream_url: str
) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={"id": "hostless", "name": "No host", "stream_url": stream_url},
    )

    assert response.status_code == 422, stream_url


def test_patch_also_rejects_a_host_less_stream_url(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    response = client.patch(
        "/api/v1/cameras/front-door",
        headers=write_headers,
        json={"stream_url": "rtsp:///stream"},
    )

    assert response.status_code == 422


# 7 (medium) -- an explicit null on a NOT NULL column is a 422, not a 500.


@pytest.mark.parametrize(
    "field", ["name", "stream_url", "enabled", "detection_enabled"]
)
def test_patching_a_not_null_column_to_null_is_rejected(
    client: TestClient, write_headers: dict, camera: dict, field: str
) -> None:
    response = client.patch(
        "/api/v1/cameras/front-door", headers=write_headers, json={field: None}
    )

    assert response.status_code == 422, field
    assert response.json()["error"]["code"] == "validation_error"


def test_location_may_still_be_nulled(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    """`location` is the one genuinely nullable column."""
    assert camera["location"] == "Porch"

    response = client.patch(
        "/api/v1/cameras/front-door", headers=write_headers, json={"location": None}
    )

    assert response.status_code == 200
    assert response.json()["location"] is None


def test_omitting_a_field_still_leaves_it_untouched(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    response = client.patch(
        "/api/v1/cameras/front-door", headers=write_headers, json={"enabled": False}
    )

    body = response.json()
    assert body["enabled"] is False
    assert body["name"] == "Front Door"
    assert body["detection_enabled"] is True
