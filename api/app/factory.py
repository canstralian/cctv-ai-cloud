"""Application factory."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import Settings, get_settings
from .db import init_db
from .errors import register_exception_handlers
from .logging_setup import RequestContextMiddleware, configure_logging
from .routers import cameras, events, health, stats

DESCRIPTION = """
Control plane for a self-hosted CCTV deployment.

* **cameras** — the registry the NVR and UI both read from.
* **events** — detection events pushed in by the NVR / ML worker.
* **stats** — aggregates for the dashboard.

Every `/api` route requires either an `X-API-Key` header or an
`Authorization: Bearer <jwt>` token. `/health` and `/ready` are open.
"""


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    settings.validate_for_runtime()

    configure_logging(settings.log_level)
    init_db(settings.database_path)

    app = FastAPI(
        title="CCTV AI Cloud API",
        description=DESCRIPTION,
        version=__version__,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    # Added first => innermost. CORS ends up outermost so that error responses
    # still carry the headers a browser needs to read them.
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.parsed_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-API-Key", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
    )

    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(cameras.router)
    app.include_router(events.router)
    app.include_router(stats.router)

    logging.getLogger("api.startup").info(
        "api ready",
        extra={
            "version": __version__,
            "env": settings.env,
            "database": str(settings.database_path),
            "auth": "disabled" if settings.auth_is_disabled else "enabled",
        },
    )
    return app
