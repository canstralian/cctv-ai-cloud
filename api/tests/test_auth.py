import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.factory import create_app
from app.security import issue_token
from tests.conftest import TEST_SECRET, make_event

STRONG_SECRET = TEST_SECRET


def test_missing_credentials_are_rejected(client: TestClient) -> None:
    response = client.get("/api/v1/cameras")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_unknown_api_key_is_rejected(client: TestClient) -> None:
    response = client.get("/api/v1/cameras", headers={"X-API-Key": "sk_not_real"})

    assert response.status_code == 401


def test_read_key_cannot_write(client: TestClient, read_headers: dict) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=read_headers,
        json={"id": "cam", "name": "Cam", "stream_url": "rtsp://host/s"},
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_write_key_can_read_and_write(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    assert client.get("/api/v1/cameras", headers=write_headers).status_code == 200


def test_bearer_token_is_accepted(client: TestClient, bearer_headers: dict) -> None:
    response = client.get("/api/v1/cameras", headers=bearer_headers)

    assert response.status_code == 200


def test_bearer_token_scope_is_enforced(
    client: TestClient, bearer_headers: dict
) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=bearer_headers,
        json={"id": "cam", "name": "Cam", "stream_url": "rtsp://host/s"},
    )

    assert response.status_code == 403


def test_expired_token_is_rejected(client: TestClient, settings: Settings) -> None:
    token = issue_token(settings, "stale", ["read"], expires_in_seconds=-60)

    response = client.get(
        "/api/v1/cameras", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 401
    assert "expired" in response.json()["error"]["message"].lower()


def test_token_signed_with_another_secret_is_rejected(
    client: TestClient, settings: Settings
) -> None:
    forged = issue_token(
        settings.model_copy(update={"jwt_secret": "attacker-secret"}),
        "mallory",
        ["read", "write"],
    )

    response = client.get(
        "/api/v1/cameras", headers={"Authorization": f"Bearer {forged}"}
    )

    assert response.status_code == 401


def test_malformed_authorization_header_is_rejected(client: TestClient) -> None:
    response = client.get("/api/v1/cameras", headers={"Authorization": "Basic abc"})

    assert response.status_code == 401


def test_ingest_endpoint_requires_write_scope(
    client: TestClient, read_headers: dict, camera: dict
) -> None:
    response = client.post("/api/v1/events", headers=read_headers, json=make_event())

    assert response.status_code == 403


def test_auth_can_be_disabled_only_in_dev(tmp_path) -> None:
    dev = Settings(env="dev", auth_disabled=True, database_path=tmp_path / "dev.db")
    assert dev.auth_is_disabled is True

    staging = Settings(
        env="staging", auth_disabled=True, database_path=tmp_path / "s.db"
    )
    assert staging.auth_is_disabled is False


def test_prod_refuses_to_start_with_auth_disabled(tmp_path) -> None:
    settings = Settings(
        env="prod",
        auth_disabled=True,
        jwt_secret=STRONG_SECRET,
        database_path=tmp_path / "prod.db",
    )

    with pytest.raises(RuntimeError, match="AUTH_DISABLED"):
        create_app(settings)


def test_prod_refuses_the_placeholder_secret(tmp_path) -> None:
    settings = Settings(env="prod", database_path=tmp_path / "prod.db")

    with pytest.raises(RuntimeError, match="placeholder"):
        create_app(settings)


def test_prod_refuses_a_short_secret_even_with_api_keys(tmp_path) -> None:
    """API keys do not make a weak JWT secret safe — the bearer path stays open."""
    settings = Settings(
        env="prod",
        jwt_secret="too-short",
        api_keys="ingest:sk_live:read|write",
        database_path=tmp_path / "prod.db",
    )

    with pytest.raises(RuntimeError, match="at least 32 characters"):
        create_app(settings)


def test_prod_refuses_wildcard_cors(tmp_path) -> None:
    settings = Settings(
        env="prod",
        jwt_secret=STRONG_SECRET,
        cors_origins="*",
        database_path=tmp_path / "prod.db",
    )

    with pytest.raises(RuntimeError, match="CORS_ORIGINS"):
        create_app(settings)


def test_prod_starts_with_real_credentials(tmp_path) -> None:
    settings = Settings(
        env="prod",
        jwt_secret=STRONG_SECRET,
        cors_origins="https://cctv.example.com",
        database_path=tmp_path / "prod.db",
    )

    assert create_app(settings) is not None


def test_malformed_api_key_entries_are_ignored(tmp_path) -> None:
    settings = Settings(
        env="dev",
        api_keys="good:sk_ok:read, broken-entry, missing-scopes:sk_x:",
        database_path=tmp_path / "dev.db",
    )

    assert list(settings.parsed_api_keys) == ["sk_ok"]
