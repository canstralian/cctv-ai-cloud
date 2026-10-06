"""Request and response models.

Two things worth calling out:

* ``stream_url`` is accepted in full but never returned in full — RTSP URLs
  routinely carry camera credentials, and this API is reachable from a browser.
* media paths are validated as relative, traversal-free paths, because they are
  resolved against the NVR's media root downstream.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CAMERA_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"
LABEL_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,31}$"
ALLOWED_STREAM_SCHEMES = frozenset({"rtsp", "rtsps", "http", "https"})

# Camera columns declared NOT NULL. A PATCH may omit these but not null them.
NON_NULLABLE_CAMERA_FIELDS = frozenset(
    {"name", "stream_url", "enabled", "detection_enabled"}
)

CameraId = Annotated[str, Field(pattern=CAMERA_ID_PATTERN, examples=["front-door"])]
Label = Annotated[str, Field(pattern=LABEL_PATTERN, examples=["person"])]
Score = Annotated[float, Field(ge=0.0, le=1.0)]


def to_utc(value: datetime) -> datetime:
    """Normalise to timezone-aware UTC; naive input is assumed to be UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def utc_now() -> datetime:
    return datetime.now(UTC)


def redact_stream_url(url: str) -> str:
    """Strip userinfo from a stream URL so credentials never reach a client."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<invalid>"

    if not parts.netloc or "@" not in parts.netloc:
        return url

    host = parts.netloc.rsplit("@", 1)[1]
    return urlunsplit((parts.scheme, f"***:***@{host}", parts.path, parts.query, ""))


def validate_stream_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme.lower() not in ALLOWED_STREAM_SCHEMES:
        raise ValueError("stream_url must use rtsp, rtsps, http or https")
    # A scheme alone is not a reachable stream: `rtsp:///path` and `https:path`
    # both parse happily but have nowhere to connect to.
    if not parts.hostname:
        raise ValueError("stream_url must include a host")
    return value


def validate_media_path(value: str | None) -> str | None:
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    if candidate.startswith(("/", "\\")) or ".." in candidate.replace("\\", "/").split(
        "/"
    ):
        raise ValueError("must be a relative path without '..' segments")
    return candidate


class CameraBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    stream_url: str = Field(min_length=1, max_length=2048)
    location: str | None = Field(default=None, max_length=120)
    enabled: bool = True
    detection_enabled: bool = True

    @field_validator("stream_url")
    @classmethod
    def _check_stream_url(cls, value: str) -> str:
        return validate_stream_url(value)


class CameraCreate(CameraBase):
    id: CameraId


class CameraUpdate(BaseModel):
    """A PATCH body. Omitted fields are left alone; see `_reject_null_columns`."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    stream_url: str | None = Field(default=None, min_length=1, max_length=2048)
    location: str | None = Field(default=None, max_length=120)
    enabled: bool | None = None
    detection_enabled: bool | None = None

    @field_validator("stream_url")
    @classmethod
    def _check_stream_url(cls, value: str | None) -> str | None:
        return None if value is None else validate_stream_url(value)

    @model_validator(mode="after")
    def _reject_null_columns(self) -> CameraUpdate:
        """Reject an explicit JSON null on a column that is NOT NULL.

        These fields are nullable only so they can be *omitted*. Sending
        `null` would otherwise reach the UPDATE and fail the constraint as a
        500 rather than a validation error. `location` is genuinely nullable,
        so passing null there clears it.
        """
        supplied_nulls = [
            name
            for name in NON_NULLABLE_CAMERA_FIELDS & self.model_fields_set
            if getattr(self, name) is None
        ]
        if supplied_nulls:
            raise ValueError(f"may not be null: {', '.join(sorted(supplied_nulls))}")
        return self


class CameraOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    stream_url: str = Field(description="Credentials are redacted.")
    location: str | None
    enabled: bool
    detection_enabled: bool
    created_at: datetime
    updated_at: datetime


class EventCreate(BaseModel):
    camera_id: CameraId
    label: Label
    score: Score
    started_at: datetime
    ended_at: datetime | None = None
    thumbnail_path: str | None = Field(default=None, max_length=1024)
    clip_path: str | None = Field(default=None, max_length=1024)
    attributes: dict[str, Any] = Field(default_factory=dict)

    @field_validator("thumbnail_path", "clip_path")
    @classmethod
    def _check_media_path(cls, value: str | None) -> str | None:
        return validate_media_path(value)

    @field_validator("started_at", "ended_at")
    @classmethod
    def _normalise_timestamps(cls, value: datetime | None) -> datetime | None:
        return None if value is None else to_utc(value)


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    camera_id: str
    label: str
    score: float
    started_at: datetime
    ended_at: datetime | None
    thumbnail_path: str | None
    clip_path: str | None
    attributes: dict[str, Any]
    created_at: datetime


class Page[T](BaseModel):
    items: list[T]
    total: int
    limit: int
    offset: int


class LabelCount(BaseModel):
    label: str
    count: int


class CameraCount(BaseModel):
    camera_id: str
    count: int


class Stats(BaseModel):
    cameras_total: int
    cameras_enabled: int
    events_total: int
    events_last_24h: int
    last_event_at: datetime | None
    events_by_label: list[LabelCount]
    events_by_camera: list[CameraCount]


class Health(BaseModel):
    status: str
    version: str


class Readiness(BaseModel):
    status: str
    version: str
    checks: dict[str, str]
