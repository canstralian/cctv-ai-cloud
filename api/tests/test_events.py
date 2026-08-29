from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from tests.conftest import make_event


def test_ingest_returns_the_stored_event(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    response = client.post(
        "/api/v1/events",
        headers=write_headers,
        json={
            **make_event(),
            "thumbnail_path": "front-door/2026/thumb.jpg",
            "attributes": {"zone": "porch"},
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["id"]
    assert body["camera_id"] == "front-door"
    assert body["label"] == "person"
    assert body["attributes"] == {"zone": "porch"}
    assert body["thumbnail_path"] == "front-door/2026/thumb.jpg"


def test_ingest_for_unknown_camera_is_404(
    client: TestClient, write_headers: dict
) -> None:
    response = client.post(
        "/api/v1/events", headers=write_headers, json=make_event(camera_id="ghost")
    )

    assert response.status_code == 404
    assert "ghost" in response.json()["error"]["message"]


def test_score_outside_the_unit_interval_is_rejected(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    response = client.post(
        "/api/v1/events", headers=write_headers, json=make_event(score=1.4)
    )

    assert response.status_code == 422


def test_path_traversal_in_media_path_is_rejected(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    response = client.post(
        "/api/v1/events",
        headers=write_headers,
        json={**make_event(), "clip_path": "../../etc/shadow"},
    )

    assert response.status_code == 422


def test_absolute_media_path_is_rejected(
    client: TestClient, write_headers: dict, camera: dict
) -> None:
    response = client.post(
        "/api/v1/events",
        headers=write_headers,
        json={**make_event(), "clip_path": "/etc/shadow"},
    )

    assert response.status_code == 422


def test_naive_timestamps_are_treated_as_utc(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    response = client.post(
        "/api/v1/events",
        headers=write_headers,
        json={**make_event(), "started_at": "2026-05-01T12:00:00"},
    )

    assert response.status_code == 201
    assert response.json()["started_at"].startswith("2026-05-01T12:00:00")


def test_events_are_returned_newest_first(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    for minutes in (30, 5, 60):
        client.post(
            "/api/v1/events",
            headers=write_headers,
            json=make_event(minutes_ago=minutes),
        )

    items = client.get("/api/v1/events", headers=read_headers).json()["items"]

    timestamps = [item["started_at"] for item in items]
    assert timestamps == sorted(timestamps, reverse=True)


def test_filter_by_camera_and_label(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    client.post(
        "/api/v1/cameras",
        headers=write_headers,
        json={"id": "garage", "name": "Garage", "stream_url": "rtsp://host/s"},
    )
    client.post("/api/v1/events", headers=write_headers, json=make_event(label="person"))
    client.post("/api/v1/events", headers=write_headers, json=make_event(label="car"))
    client.post(
        "/api/v1/events",
        headers=write_headers,
        json=make_event(camera_id="garage", label="car"),
    )

    by_camera = client.get(
        "/api/v1/events?camera_id=garage", headers=read_headers
    ).json()
    by_label = client.get("/api/v1/events?label=car", headers=read_headers).json()

    assert by_camera["total"] == 1
    assert by_label["total"] == 2


def test_filter_by_min_score(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    client.post("/api/v1/events", headers=write_headers, json=make_event(score=0.4))
    client.post("/api/v1/events", headers=write_headers, json=make_event(score=0.95))

    filtered = client.get("/api/v1/events?min_score=0.8", headers=read_headers).json()

    assert filtered["total"] == 1
    assert filtered["items"][0]["score"] == 0.95


def test_filter_by_time_window(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    client.post("/api/v1/events", headers=write_headers, json=make_event(minutes_ago=5))
    client.post(
        "/api/v1/events", headers=write_headers, json=make_event(minutes_ago=600)
    )

    since = (datetime.now(UTC) - timedelta(minutes=60)).isoformat()
    response = client.get(
        "/api/v1/events", headers=read_headers, params={"since": since}
    )

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 1


def test_pagination_reports_the_full_total(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    for minutes in range(4):
        client.post(
            "/api/v1/events", headers=write_headers, json=make_event(minutes_ago=minutes)
        )

    page = client.get("/api/v1/events?limit=2", headers=read_headers).json()

    assert page["total"] == 4
    assert len(page["items"]) == 2


def test_limit_above_the_cap_is_rejected(
    client: TestClient, read_headers: dict
) -> None:
    response = client.get("/api/v1/events?limit=5000", headers=read_headers)

    assert response.status_code == 422


def test_get_and_delete_single_event(
    client: TestClient, write_headers: dict, read_headers: dict, camera: dict
) -> None:
    created = client.post(
        "/api/v1/events", headers=write_headers, json=make_event()
    ).json()

    fetched = client.get(f"/api/v1/events/{created['id']}", headers=read_headers)
    assert fetched.status_code == 200

    deleted = client.delete(f"/api/v1/events/{created['id']}", headers=write_headers)
    assert deleted.status_code == 204

    assert (
        client.get(f"/api/v1/events/{created['id']}", headers=read_headers).status_code
        == 404
    )
