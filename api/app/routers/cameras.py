"""Camera registry endpoints."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Query, status

from ..db import transaction
from ..deps import Db
from ..errors import Conflict, NotFound
from ..repositories import cameras as repo
from ..schemas import CameraCreate, CameraOut, CameraUpdate, Page
from ..security import RequireRead, RequireWrite

router = APIRouter(prefix="/api/v1/cameras", tags=["cameras"])


@router.get("", response_model=Page[CameraOut], summary="List cameras")
def list_cameras(
    db: Db,
    _: RequireRead,
    enabled: bool | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> Page[CameraOut]:
    rows, total = repo.list_page(db, enabled=enabled, limit=limit, offset=offset)
    return Page[CameraOut](
        items=[CameraOut(**repo.row_to_camera(row)) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post(
    "",
    response_model=CameraOut,
    status_code=status.HTTP_201_CREATED,
    summary="Register a camera",
)
def create_camera(payload: CameraCreate, db: Db, _: RequireWrite) -> CameraOut:
    try:
        with transaction(db):
            row = repo.create(db, payload)
    except sqlite3.IntegrityError as exc:
        raise Conflict(f"Camera {payload.id!r} already exists.") from exc
    return CameraOut(**repo.row_to_camera(row))


@router.get("/{camera_id}", response_model=CameraOut, summary="Fetch one camera")
def get_camera(camera_id: str, db: Db, _: RequireRead) -> CameraOut:
    row = repo.get(db, camera_id)
    if row is None:
        raise NotFound("Camera", camera_id)
    return CameraOut(**repo.row_to_camera(row))


@router.patch("/{camera_id}", response_model=CameraOut, summary="Update a camera")
def update_camera(
    camera_id: str, payload: CameraUpdate, db: Db, _: RequireWrite
) -> CameraOut:
    with transaction(db):
        row = repo.update(db, camera_id, payload)
    if row is None:
        raise NotFound("Camera", camera_id)
    return CameraOut(**repo.row_to_camera(row))


@router.delete(
    "/{camera_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a camera and its events",
)
def delete_camera(camera_id: str, db: Db, _: RequireWrite) -> None:
    with transaction(db):
        deleted = repo.delete(db, camera_id)
    if not deleted:
        raise NotFound("Camera", camera_id)
