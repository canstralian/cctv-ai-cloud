from fastapi.testclient import TestClient

from tests.conftest import make_event


def test_stats_on_an_empty_deployment(client: TestClient, read_headers: dict) -> None:
    body = client.get("/api/v1/stats", headers=read_headers).json()

    assert body["cameras_total"] == 0
    assert body["events_total"] == 0
    assert body["last_event_at"] is None
    assert body["events_by_label"] == []


def test_stats_aggregate_cameras_and_events(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={
            "id": "garage",
            "name": "Garage",
            "stream_url": "rtsp://host/s",
            "enabled": False,
        },
    )
    client.post("/api/v1/events", headers=write_headers, json=make_event(label="person"))
    client.post("/api/v1/events", headers=write_headers, json=make_event(label="person"))
    client.post("/api/v1/events", headers=write_headers, json=make_event(label="car"))

    body = client.get("/api/v1/stats", headers=read_headers).json()

    assert body["cameras_total"] == 2
    assert body["cameras_enabled"] == 1
    assert body["events_total"] == 3
    assert body["events_last_24h"] == 3
    assert body["last_event_at"] is not None
    assert body["events_by_label"][0] == {"label": "person", "count": 2}
    assert body["events_by_camera"] == [{"camera_id": "front-door", "count": 3}]


def test_events_older_than_a_day_are_excluded_from_the_24h_count(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    client.post(
        "/api/v1/events", headers=write_headers, json=make_event(minutes_ago=2 * 24 * 60)
    )
    client.post("/api/v1/events", headers=write_headers, json=make_event(minutes_ago=10))

    body = client.get("/api/v1/stats", headers=read_headers).json()

    assert body["events_total"] == 2
    assert body["events_last_24h"] == 1


def test_stats_requires_authentication(client: TestClient) -> None:
    assert client.get("/api/v1/stats").status_code == 401
