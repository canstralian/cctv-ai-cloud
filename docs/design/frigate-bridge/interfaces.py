"""Frigate bridge: interface contract, rev 2 (design artifact, not runnable code).

Signatures and types only. Bodies are intentionally ``...``: the Builder
stage implements them under ``bridge/``. See ``architecture.md`` for the
behaviour each signature commits to.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal, Protocol

# --------------------------------------------------------------------------- config


class BridgeSettings(Protocol):
    """Read from the environment (pydantic-settings in the implementation)."""

    mqtt_host: str  # MQTT_HOST, default "mosquitto"
    mqtt_port: int  # MQTT_PORT, default 1883
    mqtt_username: str  # MQTT_USERNAME
    mqtt_password: str  # MQTT_PASSWORD (never logged)
    mqtt_topic: str  # MQTT_TOPIC, default "frigate/events"
    mqtt_client_id: str  # MQTT_CLIENT_ID, fixed so the broker keeps the session
    api_base_url: str  # API_BASE_URL, default "http://api:8000"
    api_key: str  # BRIDGE_API_KEY: scope `ingest` bound to source "frigate"; not `write` (never logged)
    frigate_base_url: str  # FRIGATE_BASE_URL, default "https://nvr:8971" (authenticated port)
    frigate_username: str  # FRIGATE_USERNAME, a Frigate *viewer* user
    frigate_password: str  # FRIGATE_PASSWORD (never logged)
    camera_map: dict[str, str]  # CAMERA_MAP="Front_Door:front-door,…"
    sink_max_elapsed_s: float  # SINK_MAX_ELAPSED, default 60
    queue_maxsize: int  # QUEUE_MAXSIZE, default 1000
    reconcile_interval_s: float  # RECONCILE_INTERVAL, default 600
    reconcile_lookback_s: float  # RECONCILE_LOOKBACK, default 21600 (6 h)
    health_port: int  # HEALTH_PORT, default 8080


# --------------------------------------------------------------------------- frigate


FrigateMessageType = Literal["new", "update", "end"]


@dataclass(frozen=True, slots=True)
class FrigateObject:
    """The subset of Frigate's ``before``/``after`` object the bridge reads."""

    id: str
    camera: str
    label: str
    top_score: float
    start_time: float  # epoch seconds
    end_time: float | None
    false_positive: bool
    sub_label: str | None
    sub_label_score: float | None
    entered_zones: tuple[str, ...]
    has_snapshot: bool
    has_clip: bool
    attributes: dict[str, float]


@dataclass(frozen=True, slots=True)
class FrigateEvent:
    """One ``frigate/events`` MQTT message: its type and the object states."""

    type: FrigateMessageType
    before: FrigateObject | None  # absent on some ``new`` messages
    after: FrigateObject


class FrigatePayloadError(ValueError):
    """Payload is not JSON, or is missing a field the mapping requires."""


def parse_mqtt(payload: bytes) -> FrigateEvent:
    """Parse one ``frigate/events`` message. Unknown fields are ignored.

    Raises:
        FrigatePayloadError: malformed JSON or a missing required field.
    """
    ...


def parse_http(record: dict[str, Any]) -> FrigateObject:
    """Parse one ``GET /api/events`` record into the same internal type.

    HTTP shape differs from MQTT: ``zones`` (not ``entered_zones``),
    ``data.top_score``, ``sub_label`` as a plain string with
    ``data.sub_label_score``.

    Raises:
        FrigatePayloadError: a required field is missing.
    """
    ...


class FrigateUnavailable(Exception):
    """Frigate could not be reached or refused the viewer credential."""


class ReconcileError(Exception):
    """A catch-up run could not complete without skipping records."""


class FrigateClient(Protocol):
    """Read-only access to Frigate's authenticated API (port 8971, viewer role)."""

    def events(self, *, after: float, before: float, limit: int) -> list[dict[str, Any]]:
        """One page of ``GET /api/events``, newest first. Raises FrigateUnavailable."""
        ...

    def snapshot_jpeg(self, event_id: str) -> bytes | None:
        """``GET /api/events/{id}/snapshot.jpg``; None on 404. Raises FrigateUnavailable."""
        ...


# --------------------------------------------------------------------------- mapping


@dataclass(frozen=True, slots=True)
class EventUpsert:
    """Body plus key for ``PUT /api/v1/events/by-source/{source}/{external_id}``."""

    source: str
    external_id: str
    camera_id: str
    label: str
    score: float
    started_at: datetime  # tz-aware UTC
    ended_at: datetime | None
    clip_path: str | None
    attributes: dict[str, Any]


class SkipReason(StrEnum):
    """Why an event was not forwarded; each value is a counter in /healthz."""

    FALSE_POSITIVE = "false_positive"
    UNMAPPED_CAMERA = "unmapped_camera"
    INVALID_LABEL = "invalid_label"


@dataclass(frozen=True, slots=True)
class Skip:
    """A decision not to forward an event, with the reason recorded."""

    reason: SkipReason
    external_id: str
    detail: str = ""


def to_upsert(obj: FrigateObject, camera_map: dict[str, str]) -> EventUpsert | Skip:
    """Map a Frigate event to an API upsert, or say why it is skipped.

    Pure: no IO, no clock. Same input always gives the same output.
    """
    ...


Origin = Literal["mqtt", "catchup"]


@dataclass(frozen=True, slots=True)
class WorkItem:
    """What the MQTT thread and catch-up hand to the delivery worker."""

    origin: Origin
    obj: FrigateObject
    is_end: bool  # MQTT ``end``, or an HTTP record with end_time set
    mqtt_mid: int | None  # message id to acknowledge; None for catch-up


# --------------------------------------------------------------------------- sink


class SinkOutcome(StrEnum):
    """Classified result of one API delivery; decides retry versus give up."""

    CREATED = "created"  # 201
    UPDATED = "updated"  # 200
    UNKNOWN_CAMERA = "unknown_camera"  # 404, permanent, do not retry
    FORBIDDEN_SOURCE = "forbidden_source"  # 403, key not bound to this source; fatal
    REJECTED = "rejected"  # 409 / 422, permanent, do not retry
    UNAUTHORIZED = "unauthorized"  # 401 / 403, fatal: bridge exits non-zero
    API_UNAVAILABLE = "api_unavailable"  # retry budget exhausted; schedules catch-up


@dataclass(frozen=True, slots=True)
class SinkResult:
    """Outcome of an upsert plus the thumbnail state the API reported."""

    outcome: SinkOutcome
    has_thumbnail: bool  # from the upsert response; False unless 200/201
    thumbnail_final: bool  # stored thumbnail came from the terminal message


class EventSink(Protocol):
    """Delivers upserts and thumbnails to the CCTV API with bounded retry."""

    def send(self, upsert: EventUpsert) -> SinkResult:
        """Deliver one upsert, retrying transient failures (connection
        errors, 5xx, 429) with jittered exponential backoff up to the
        configured deadline. Never raises for HTTP outcomes; returns one.
        """
        ...

    def put_thumbnail(
        self, source: str, external_id: str, jpeg: bytes, *, final: bool
    ) -> SinkOutcome:
        """``PUT …/by-source/{source}/{external_id}/thumbnail[?final=true]``.

        Same retry policy. ``final`` is True when the image comes from an ended
        event; the API never replaces a final thumbnail with a non-final one.
        """
        ...


class Clock(Protocol):
    """Injected so the retry schedule is testable without real sleeps."""

    def monotonic(self) -> float:
        """Seconds from an arbitrary origin; never goes backwards."""
        ...

    def sleep(self, seconds: float) -> None:
        """Block for ``seconds``; a fake clock advances instantly in tests."""
        ...


# --------------------------------------------------------------------------- runtime


class Enqueue(Protocol):
    """Non-blocking hand-off from the MQTT thread to the delivery worker."""

    def __call__(self, item: WorkItem) -> bool:
        """Non-blocking put, for the MQTT network thread only. False if the
        queue is full: the caller counts ``queue_overflow`` and requests early
        catch-up. Never blocks.
        """
        ...


class EnqueueBlocking(Protocol):
    """Blocking hand-off used by catch-up, which must never drop a record."""

    def __call__(self, item: WorkItem, *, deadline: float) -> None:
        """Blocking put, for catch-up only: waits for capacity and never drops.

        Raises:
            TimeoutError: ``deadline`` (monotonic seconds) passed first; the
                run ends as ``failed`` and the next run restarts the window.
        """
        ...


class Reconciler(Protocol):
    """Catch-up: replays recent Frigate events through the same idempotent path."""

    def run_once(self, now: float) -> int:
        """Page Frigate events in [now - lookback, now] and enqueue each one
        (blocking, never dropping).

        Paging: next ``before`` = oldest ``start_time`` on the page + 1 ms, so
        boundary ties are re-fetched. IDs are de-duplicated within the run. A
        full page with no new IDs is retried with a doubled ``limit`` (cap
        1000), then the run fails. Returns the number enqueued.

        Raises:
            FrigateUnavailable: Frigate unreachable or the login was refused.
            ReconcileError: the tie cap was hit or the enqueue deadline passed.
        """
        ...

    def request_early(self) -> None:
        """Ask for a run soon (debounced to at most one a minute)."""
        ...


@dataclass(frozen=True, slots=True)
class HealthSnapshot:
    """Point-in-time readings served by ``/healthz``."""

    mqtt_connected: bool
    last_mqtt_received_at: datetime | None
    last_api_delivery_at: datetime | None
    last_reconciliation_at: datetime | None
    reconciliation_status: Literal["ok", "failed", "never"]
    queue_depth: int
    oldest_pending_age_s: float | None  # None when the queue is empty
    consecutive_give_ups: int  # reset to 0 by any successful delivery
    counters: dict[str, int]

    def is_healthy(self, now: datetime) -> bool:
        """False if any of these holds: MQTT disconnected for more than 60 s;
        the last two catch-up runs failed; ``consecutive_give_ups >= 3``;
        ``oldest_pending_age_s > 180``.

        The two delivery conditions need pending or attempted work, so a quiet
        site (empty queue, no attempts) is never unhealthy.
        """
        ...
