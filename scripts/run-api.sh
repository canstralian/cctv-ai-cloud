#!/usr/bin/env bash
# Run the API locally with a dev-friendly configuration.
#
#   ./scripts/run-api.sh            # reload server on http://127.0.0.1:8000
#   PORT=9000 ./scripts/run-api.sh  # somewhere else
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${REPO_ROOT}/.venv"
PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"

cd "${REPO_ROOT}"

if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "==> creating virtualenv at ${VENV}"
  python3 -m venv "${VENV}"
fi

echo "==> installing api dependencies"
"${VENV}/bin/pip" install --quiet --upgrade pip
"${VENV}/bin/pip" install --quiet -r "${REPO_ROOT}/api/requirements-dev.txt"

if [[ ! -f "${REPO_ROOT}/.env" ]]; then
  echo "==> no .env found; copying .env.example (dev defaults)"
  cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
fi

echo "==> starting api on http://${HOST}:${PORT}  (docs at /docs)"
cd "${REPO_ROOT}/api"
exec "${VENV}/bin/uvicorn" main:app --host "${HOST}" --port "${PORT}" --reload
