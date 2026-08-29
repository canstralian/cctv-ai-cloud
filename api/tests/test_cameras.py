from fastapi.testclient import TestClient

from tests.conftest import make_event


def test_create_returns_the_camera(client: TestClient, camera: dict) -> None:
    assert camera["id"] == "front-door"
    assert camera["name"] == "Front Door"
    assert camera["enabled"] is True
    assert camera["detection_enabled"] is True


def test_stream_url_credentials_are_never_returned(
    client: TestClient, camera: dict, read_headers: dict
) -> None:
    assert "hunter2" not in camera["stream_url"]
    assert camera["stream_url"] == "rtsp://***:***@192.168.1.50:554/stream1"

    listed = client.get("/api/v1/cameras", headers=read_headers).json()
    assert "hunter2" not in str(listed)

    fetched = client.get("/api/v1/cameras/front-door", headers=read_headers).json()
    assert "hunter2" not in fetched["stream_url"]


def test_stream_url_without_credentials_is_left_alone(
    client: TestClient, write_headers: dict
) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={"id": "garage", "name": "Garage", "stream_url": "rtsp://10.0.0.9/live"},
    )

    assert response.json()["stream_url"] == "rtsp://10.0.0.9/live"


def test_duplicate_id_conflicts(client: TestClient, write_headers: dict, camera: dict) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={"id": "front-door", "name": "Dup", "stream_url": "rtsp://host/s"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"


def test_invalid_id_is_rejected(client: TestClient, write_headers: dict) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={"id": "Front Door!", "name": "Bad", "stream_url": "rtsp://host/s"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_unsupported_stream_scheme_is_rejected(
    client: TestClient, write_headers: dict
) -> None:
    response = client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={"id": "odd", "name": "Odd", "stream_url": "file:///etc/passwd"},
    )

    assert response.status_code == 422


def test_get_unknown_camera_is_404(client: TestClient, read_headers: dict) -> None:
    response = client.get("/api/v1/cameras/nope", headers=read_headers)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_patch_updates_only_supplied_fields(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    response = client.patch(
        "/api/v1/cameras/front-door",
        headers=write_headers,
        json={"enabled": False},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is False
    assert body["name"] == "Front Door"
    assert body["updated_at"] >= body["created_at"]


def test_patch_unknown_camera_is_404(client: TestClient, write_headers: dict) -> None:
    response = client.patch(
        "/api/v1/cameras/ghost", headers=write_headers, json={"enabled": False}
    )

    assert response.status_code == 404


def test_list_filters_by_enabled(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={
            "id": "side-gate",
            "name": "Side Gate",
            "stream_url": "rtsp://host/s2",
            "enabled": False,
        },
    )

    enabled = client.get("/api/v1/cameras?enabled=true", headers=read_headers).json()
    disabled = client.get("/api/v1/cameras?enabled=false", headers=read_headers).json()

    assert [c["id"] for c in enabled["items"]] == ["front-door"]
    assert [c["id"] for c in disabled["items"]] == ["side-gate"]
    assert enabled["total"] == 1


def test_list_paginates(client: TestClient, write_headers: dict, read_headers: dict) -> None:
    for index in range(5):
        client.post(
            "/api/v1/cameras",
            headers=write_headers,
            json={
                "id": f"cam-{index}",
                "name": f"Cam {index}",
                "stream_url": "rtsp://host/s",
            },
        )

    page = client.get("/api/v1/cameras?limit=2&offset=2", headers=read_headers).json()

    assert page["total"] == 5
    assert page["limit"] == 2
    assert page["offset"] == 2
    assert [c["id"] for c in page["items"]] == ["cam-2", "cam-3"]


def test_delete_removes_camera_and_cascades_to_events(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    client.post("/api/v1/events", headers=write_headers, json=make_event())

    deleted = client.delete("/api/v1/cameras/front-door", headers=write_headers)
    assert deleted.status_code == 204

    assert client.get("/api/v1/cameras/front-door", headers=read_headers).status_code == 404
    events = client.get("/api/v1/events", headers=read_headers).json()
    assert events["total"] == 0


def test_delete_unknown_camera_is_404(client: TestClient, write_headers: dict) -> None:
    response = client.delete("/api/v1/cameras/ghost", headers=write_headers)

    assert response.status_code == 404
