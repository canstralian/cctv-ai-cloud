"""Dashboard aggregates."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import Db
from ..repositories import events as repo
from ..schemas import Stats
from ..security import RequireRead

router = APIRouter(prefix="/api/v1", tags=["stats"])


@router.get("/stats", response_model=Stats, summary="Fleet and detection summary")
def get_stats(db: Db, _: RequireRead) -> Stats:
    return Stats(**repo.stats(db))
