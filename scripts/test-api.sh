#!/usr/bin/env bash
# Run the API test suite.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${REPO_ROOT}/.venv"

if [[ ! -x "${VENV}/bin/python" ]]; then
  python3 -m venv "${VENV}"
  "${VENV}/bin/pip" install --quiet --upgrade pip
fi

"${VENV}/bin/pip" install --quiet -r "${REPO_ROOT}/api/requirements-dev.txt"

cd "${REPO_ROOT}/api"
exec "${VENV}/bin/python" -m pytest "$@"
