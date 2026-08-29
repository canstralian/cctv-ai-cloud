"""Liveness and readiness probes. Deliberately unauthenticated."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Response, status

from .. import __version__
from ..deps import Config
from ..db import closing_connection
from ..schemas import Health, Readiness

router = APIRouter(tags=["health"])
log = logging.getLogger("api.health")


@router.get("/health", response_model=Health, summary="Liveness probe")
def health() -> Health:
    """Answers as long as the process is up. Never touches the database."""
    return Health(status="ok", version=__version__)


@router.get("/ready", response_model=Readiness, summary="Readiness probe")
def ready(settings: Config, response: Response) -> Readiness:
    """Reports whether dependencies this process needs are actually usable."""
    checks: dict[str, str] = {}

    try:
        with closing_connection(settings.database_path) as conn:
            conn.execute("SELECT 1 FROM cameras LIMIT 1").fetchone()
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001 - probe reports, never raises
        log.warning("readiness check failed", extra={"error": str(exc)})
        checks["database"] = "unavailable"

    ok = all(value == "ok" for value in checks.values())
    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return Readiness(
        status="ready" if ok else "degraded",
        version=__version__,
        checks=checks,
    )
