"""Detection-event ingest and query endpoints."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query, status

from ..db import transaction
from ..deps import Db
from ..errors import NotFound
from ..repositories import cameras as camera_repo
from ..repositories import events as repo
from ..schemas import EventCreate, EventOut, Page
from ..security import RequireRead, RequireWrite

router = APIRouter(prefix="/api/v1/events", tags=["events"])


@router.get("", response_model=Page[EventOut], summary="Query detection events")
def list_events(
    db: Db,
    _: RequireRead,
    camera_id: str | None = None,
    label: str | None = None,
    min_score: float | None = Query(default=None, ge=0.0, le=1.0),
    since: datetime | None = Query(default=None, description="started_at >= since"),
    until: datetime | None = Query(default=None, description="started_at < until"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> Page[EventOut]:
    rows, total = repo.list_page(
        db,
        camera_id=camera_id,
        label=label,
        min_score=min_score,
        since=since,
        until=until,
        limit=limit,
        offset=offset,
    )
    return Page[EventOut](
        items=[EventOut(**repo.row_to_event(row)) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post(
    "",
    response_model=EventOut,
    status_code=status.HTTP_201_CREATED,
    summary="Ingest a detection event",
)
def create_event(payload: EventCreate, db: Db, _: RequireWrite) -> EventOut:
    """Called by the NVR / ML worker when a detection fires."""
    if not camera_repo.exists(db, payload.camera_id):
        raise NotFound("Camera", payload.camera_id)

    with transaction(db):
        row = repo.create(db, payload)
    return EventOut(**repo.row_to_event(row))


@router.get("/{event_id}", response_model=EventOut, summary="Fetch one event")
def get_event(event_id: str, db: Db, _: RequireRead) -> EventOut:
    row = repo.get(db, event_id)
    if row is None:
        raise NotFound("Event", event_id)
    return EventOut(**repo.row_to_event(row))


@router.delete(
    "/{event_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an event",
)
def delete_event(event_id: str, db: Db, _: RequireWrite) -> None:
    with transaction(db):
        deleted = repo.delete(db, event_id)
    if not deleted:
        raise NotFound("Event", event_id)
