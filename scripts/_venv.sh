#!/usr/bin/env bash
# Shared virtualenv bootstrap, sourced by the scripts in this directory.
#
# The API uses PEP 695 type parameters (`class Page[T]`), which only parse on
# Python 3.12+. Without this check an older interpreter builds an environment
# happily and then fails with a bare "SyntaxError: invalid syntax" out of
# conftest.py, which says nothing about the real cause.

MIN_PY_MINOR=12

python_is_new_enough() {
  "$1" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, ${MIN_PY_MINOR}) else 1)" \
    >/dev/null 2>&1
}

python_version_of() {
  "$1" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null \
    || echo "unknown"
}

find_supported_python() {
  local candidate
  # 3.12 first because that is what CI runs: on a machine with several
  # interpreters, a local run should match the gates. Newer versions are
  # accepted as a fallback so a 3.13-only machine still works.
  for candidate in python3.12 python3.13 python3.14 python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1 \
      && python_is_new_enough "${candidate}"; then
      command -v "${candidate}"
      return 0
    fi
  done
  return 1
}

# ensure_venv <dir> -- create it if missing, replace it if its Python is too old.
ensure_venv() {
  local venv="$1" interpreter

  if [[ -x "${venv}/bin/python" ]]; then
    if python_is_new_enough "${venv}/bin/python"; then
      return 0
    fi
    echo "==> ${venv} runs Python $(python_version_of "${venv}/bin/python"), which" \
      "cannot parse this project; recreating it" >&2
    rm -rf "${venv}"
  fi

  if ! interpreter="$(find_supported_python)"; then
    echo "error: this project needs Python 3.${MIN_PY_MINOR} or newer." >&2
    echo "       found: $(python_version_of python3) via $(command -v python3 \
      || echo 'no python3 on PATH')" >&2
    return 1
  fi

  echo "==> creating virtualenv at ${venv} using ${interpreter}" \
    "(Python $(python_version_of "${interpreter}"))"
  "${interpreter}" -m venv "${venv}"
}
