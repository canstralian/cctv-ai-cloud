"""Mint a UI token: `python -m app.token --sub dashboard --scope read`."""

from __future__ import annotations

import argparse

from .config import get_settings
from .security import READ, WRITE, issue_token


def main() -> None:
    parser = argparse.ArgumentParser(description="Issue a JWT for the web UI.")
    parser.add_argument("--sub", required=True, help="Subject (user or service name).")
    parser.add_argument(
        "--scope",
        nargs="+",
        default=[READ],
        choices=[READ, WRITE],
        help="Scopes to grant.",
    )
    parser.add_argument(
        "--ttl",
        type=int,
        default=3600,
        help="Lifetime in seconds (default: 3600).",
    )
    args = parser.parse_args()

    settings = get_settings()
    print(issue_token(settings, args.sub, args.scope, args.ttl))


if __name__ == "__main__":
    main()
