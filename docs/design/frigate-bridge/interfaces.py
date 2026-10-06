"""Frigate bridge: interface contract (design artifact, not runnable code).

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
    api_key: str  # BRIDGE_API_KEY, write scope (never logged)
    camera_map: dict[str, str]  # CAMERA_MAP="Front_Door:front-door,…"
    sink_max_elapsed_s: float  # SINK_MAX_ELAPSED, default 120


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
    type: FrigateMessageType
    before: FrigateObject | None  # absent on some ``new`` messages
    after: FrigateObject


class FrigatePayloadError(ValueError):
    """Payload is not JSON, or is missing a field the mapping requires."""


def parse(payload: bytes) -> FrigateEvent:
    """Parse one ``frigate/events`` message. Unknown fields are ignored.

    Raises:
        FrigatePayloadError: malformed JSON or a missing required field.
    """
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
    thumbnail_path: str | None
    clip_path: str | None
    attributes: dict[str, Any]


class SkipReason(StrEnum):
    FALSE_POSITIVE = "false_positive"
    UNCHANGED_UPDATE = "unchanged_update"
    UNMAPPED_CAMERA = "unmapped_camera"
    INVALID_LABEL = "invalid_label"


@dataclass(frozen=True, slots=True)
class Skip:
    reason: SkipReason
    external_id: str
    detail: str = ""


def to_upsert(event: FrigateEvent, camera_map: dict[str, str]) -> EventUpsert | Skip:
    """Map a Frigate event to an API upsert, or say why it is skipped.

    Pure: no IO, no clock. Same input always gives the same output.
    """
    ...


def is_material_update(before: FrigateObject, after: FrigateObject) -> bool:
    """True if top_score, sub_label, has_snapshot or has_clip changed."""
    ...


# --------------------------------------------------------------------------- sink


class SinkOutcome(StrEnum):
    CREATED = "created"  # 201
    UPDATED = "updated"  # 200
    UNKNOWN_CAMERA = "unknown_camera"  # 404, permanent, do not retry
    REJECTED = "rejected"  # 409 / 422, permanent, do not retry
    UNAUTHORIZED = "unauthorized"  # 401 / 403, fatal: bridge exits non-zero
    API_UNAVAILABLE = "api_unavailable"  # retry budget exhausted


class EventSink(Protocol):
    def send(self, upsert: EventUpsert) -> SinkOutcome:
        """Deliver one upsert, retrying transient failures (connection
        errors, 5xx, 429) with jittered exponential backoff up to the
        configured deadline. Never raises for HTTP outcomes; returns one.
        """
        ...


class Clock(Protocol):
    """Injected so the retry schedule is testable without real sleeps."""

    def monotonic(self) -> float: ...
    def sleep(self, seconds: float) -> None: ...
