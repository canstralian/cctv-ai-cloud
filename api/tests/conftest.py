"""Shared fixtures. Every test gets a throwaway SQLite file and real auth."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.factory import create_app
from app.security import issue_token

WRITE_KEY = "sk_test_write"
READ_KEY = "sk_test_read"

# Long enough to satisfy the HS256 minimum the app enforces outside dev.
TEST_SECRET = "test-secret-that-is-long-enough-for-hs256"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        env="dev",
        database_path=tmp_path / "test.db",
        jwt_secret=TEST_SECRET,
        api_keys=f"ingest:{WRITE_KEY}:read|write,dashboard:{READ_KEY}:read",
        cors_origins="http://localhost:5173",
        auth_disabled=False,
        log_level="WARNING",
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    application = create_app(settings)
    application.dependency_overrides[get_settings] = lambda: settings
    return application


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def write_headers() -> dict[str, str]:
    return {"X-API-Key": WRITE_KEY}


@pytest.fixture
def read_headers() -> dict[str, str]:
    return {"X-API-Key": READ_KEY}


@pytest.fixture
def bearer_headers(settings: Settings) -> dict[str, str]:
    token = issue_token(settings, "dashboard-user", ["read"])
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def camera(client: TestClient, write_headers: dict[str, str]) -> dict:
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={
            "id": "front-door",
            "name": "Front Door",
            "stream_url": "rtsp://admin:hunter2@192.168.1.50:554/stream1",
            "location": "Porch",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def make_event(
    camera_id: str = "front-door",
    label: str = "person",
    score: float = 0.9,
    minutes_ago: int = 0,
) -> dict:
    started = datetime.now(UTC) - timedelta(minutes=minutes_ago)
    return {
        "camera_id": camera_id,
        "label": label,
        "score": score,
        "started_at": started.isoformat(),
    }
