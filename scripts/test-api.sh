#!/usr/bin/env bash
# Run the API test suite.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${REPO_ROOT}/.venv"

# shellcheck source=scripts/_venv.sh
source "${REPO_ROOT}/scripts/_venv.sh"

ensure_venv "${VENV}"

"${VENV}/bin/pip" install --quiet --upgrade pip
"${VENV}/bin/pip" install --quiet -r "${REPO_ROOT}/api/requirements-dev.txt"

cd "${REPO_ROOT}/api"
exec "${VENV}/bin/python" -m pytest "$@"
