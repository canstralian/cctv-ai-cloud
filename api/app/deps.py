"""Shared FastAPI dependencies."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends

from .config import Settings, get_settings
from .db import closing_connection


def get_db(
    settings: Annotated[Settings, Depends(get_settings)],
) -> Iterator[sqlite3.Connection]:
    """One connection per request; closed when the request ends."""
    with closing_connection(settings.database_path) as conn:
        yield conn


Db = Annotated[sqlite3.Connection, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]
