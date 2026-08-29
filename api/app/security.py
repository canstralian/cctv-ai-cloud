"""Authentication and scope enforcement.

Two credential types, because there are two kinds of caller:

* ``X-API-Key`` — machine clients (the NVR and the ML worker pushing events).
* ``Authorization: Bearer <jwt>`` — the web UI, signed with ``JWT_SECRET``.

Both resolve to a :class:`Principal` carrying a set of scopes. Every route under
``/api`` declares the scope it needs; nothing is open by default.
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, Header, status

from .config import Settings, get_settings
from .errors import ApiError

READ = "read"
WRITE = "write"

_UNAUTHORIZED = "unauthorized"


@dataclass(frozen=True)
class Principal:
    """Who is calling, and what they are allowed to do."""

    subject: str
    scopes: frozenset[str]
    kind: str  # "api_key" | "jwt" | "anonymous"

    def has(self, scope: str) -> bool:
        return scope in self.scopes


ANONYMOUS_DEV = Principal(
    subject="dev",
    scopes=frozenset({READ, WRITE}),
    kind="anonymous",
)


def _unauthorized(message: str) -> ApiError:
    return ApiError(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED, message)


def _match_api_key(settings: Settings, presented: str) -> Principal | None:
    """Constant-time compare against every configured key."""
    for key in settings.parsed_api_keys.values():
        if hmac.compare_digest(key.secret, presented):
            return Principal(subject=key.name, scopes=key.scopes, kind="api_key")
    return None


def _decode_jwt(settings: Settings, token: str) -> Principal:
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            issuer=settings.jwt_issuer,
            options={"require": ["exp", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise _unauthorized("Token has expired.") from exc
    except jwt.InvalidTokenError as exc:
        raise _unauthorized("Token is not valid.") from exc

    raw_scopes = claims.get("scope", "")
    if isinstance(raw_scopes, str):
        scopes = frozenset(s for s in raw_scopes.split() if s)
    else:
        scopes = frozenset(str(s) for s in raw_scopes)

    return Principal(subject=str(claims["sub"]), scopes=scopes, kind="jwt")


def resolve_principal(
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
    authorization: Annotated[str | None, Header()] = None,
    settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
) -> Principal:
    """Turn whatever credential was presented into a Principal, or reject it."""
    if settings.auth_is_disabled:
        return ANONYMOUS_DEV

    if x_api_key:
        principal = _match_api_key(settings, x_api_key)
        if principal is None:
            raise _unauthorized("API key is not recognised.")
        return principal

    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            raise _unauthorized("Authorization header must be 'Bearer <token>'.")
        return _decode_jwt(settings, token.strip())

    raise _unauthorized(
        "Provide an X-API-Key header or an Authorization: Bearer token."
    )


def require_scope(scope: str):
    """Dependency factory: demand a specific scope on a route."""

    def _dependency(
        principal: Annotated[Principal, Depends(resolve_principal)],
    ) -> Principal:
        if not principal.has(scope):
            raise ApiError(
                status.HTTP_403_FORBIDDEN,
                "forbidden",
                f"This endpoint requires the {scope!r} scope.",
            )
        return principal

    return _dependency


RequireRead = Annotated[Principal, Depends(require_scope(READ))]
RequireWrite = Annotated[Principal, Depends(require_scope(WRITE))]


def issue_token(
    settings: Settings,
    subject: str,
    scopes: list[str],
    expires_in_seconds: int = 3600,
) -> str:
    """Mint a UI token. Exposed for operators via `python -m app.token`."""
    import time

    now = int(time.time())
    return jwt.encode(
        {
            "sub": subject,
            "scope": " ".join(scopes),
            "iss": settings.jwt_issuer,
            "iat": now,
            "exp": now + expires_in_seconds,
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
