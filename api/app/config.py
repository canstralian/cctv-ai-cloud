"""Application settings, loaded from the environment / .env file."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_JWT_SECRET = "change-me"

# RFC 7518 §3.2: an HMAC key for HS256 should be at least as long as the digest.
MIN_JWT_SECRET_LENGTH = 32

REPO_ROOT = Path(__file__).resolve().parents[2]


class ApiKey:
    """A parsed API key entry: a label, the secret, and its granted scopes."""

    def __init__(self, name: str, secret: str, scopes: frozenset[str]) -> None:
        self.name = name
        self.secret = secret
        self.scopes = scopes


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: Literal["dev", "staging", "prod"] = "dev"
    domain: str = "localhost"
    log_level: str = "INFO"

    database_path: Path = REPO_ROOT / "data" / "cctv.db"

    jwt_secret: str = DEFAULT_JWT_SECRET
    jwt_algorithm: str = "HS256"
    jwt_issuer: str = "cctv-ai-cloud"

    # Comma-separated entries of "name:secret:scope|scope", e.g.
    #   API_KEYS=nvr-ingest:sk_abc:write,dashboard:sk_def:read
    api_keys: str = ""

    # Comma-separated allowed browser origins for the web UI.
    cors_origins: str = "http://localhost:5173"

    # Only honoured when env == "dev"; see `auth_is_disabled`.
    auth_disabled: bool = False

    # Events older than this are eligible for pruning by the retention task.
    event_retention_days: int = Field(default=30, ge=1, le=3650)

    @field_validator("log_level")
    @classmethod
    def _upper_log_level(cls, value: str) -> str:
        return value.upper()

    @property
    def is_dev(self) -> bool:
        return self.env == "dev"

    @property
    def auth_is_disabled(self) -> bool:
        """Auth may only be switched off in dev. Never trust the flag elsewhere."""
        return self.auth_disabled and self.is_dev

    @property
    def parsed_api_keys(self) -> dict[str, ApiKey]:
        """Map secret -> ApiKey. Malformed entries are skipped, not guessed at."""
        keys: dict[str, ApiKey] = {}
        for raw in self.api_keys.split(","):
            entry = raw.strip()
            if not entry:
                continue
            parts = entry.split(":")
            if len(parts) != 3:
                continue
            name, secret, scopes = (p.strip() for p in parts)
            if not name or not secret:
                continue
            granted = frozenset(s.strip() for s in scopes.split("|") if s.strip())
            if not granted:
                continue
            keys[secret] = ApiKey(name=name, secret=secret, scopes=granted)
        return keys

    @property
    def parsed_cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def validate_for_runtime(self) -> None:
        """Fail closed on startup rather than serving an unauthenticated API.

        Raises:
            RuntimeError: if a non-dev deployment has no usable credentials.
        """
        if self.is_dev:
            return

        if self.auth_disabled:
            raise RuntimeError(
                "AUTH_DISABLED is only permitted when ENV=dev "
                f"(current ENV={self.env!r})."
            )

        # The bearer path is always enabled, so a placeholder secret is a hole
        # even when API keys are configured — anyone who knows the default can
        # mint a token with any scope.
        secret = self.jwt_secret.strip()
        if not secret or secret == DEFAULT_JWT_SECRET:
            raise RuntimeError(
                "JWT_SECRET is unset or still the placeholder value. Set a real "
                "secret before running outside of dev."
            )
        if len(secret) < MIN_JWT_SECRET_LENGTH:
            raise RuntimeError(
                f"JWT_SECRET must be at least {MIN_JWT_SECRET_LENGTH} characters "
                f"for {self.jwt_algorithm}; got {len(secret)}."
            )

        if "*" in self.parsed_cors_origins:
            raise RuntimeError(
                "CORS_ORIGINS may not be '*' outside of dev; list explicit origins."
            )


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor. Tests clear the cache via `get_settings.cache_clear()`."""
    return Settings()
