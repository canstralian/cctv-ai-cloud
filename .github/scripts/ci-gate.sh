#!/usr/bin/env bash
# Decide the `required` check from the change selectors and the job results.
#
# Fail-closed: every combination not explicitly allowed below fails.
#   changes result   must be "success"
#   selector         must be exactly "true" or "false"
#   selector=true    the service job must have succeeded
#   selector=false   the service job must have been skipped
# So a job that was skipped although its service changed (a broken `if:`,
# a renamed output) fails the gate, and so does a job that ran although
# nothing selected it.
#
# Inputs (environment):
#   CHANGES                  result of the `changes` job
#   API_SELECTED, API_RESULT selector output and result of the `api` job
#   WEB_SELECTED, WEB_RESULT selector output and result of the `web` job
#
# Exits 0 when the gate passes, 1 otherwise. Prints one line per decision.
set -uo pipefail

fail=0
# err MESSAGE: print a GitHub error annotation and mark the gate failed.
err() { echo "::error::$*"; fail=1; }

if [ "${CHANGES:-}" != "success" ]; then
  err "Change detection did not succeed (result='${CHANGES:-}')."
fi

# check NAME SELECTED RESULT: allow only true:success or false:skipped.
check() {
  local name=$1 selected=$2 result=$3
  case "$selected:$result" in
    true:success)   echo "$name: changed, validation passed." ;;
    false:skipped)  echo "$name: unchanged, validation skipped." ;;
    true:*)         err "$name changed but its validation ended as '$result' (expected success)." ;;
    false:*)        err "$name is unchanged but its validation ended as '$result' (expected skipped)." ;;
    *)              err "$name selector is '$selected' (expected 'true' or 'false'); result '$result'." ;;
  esac
}

check api "${API_SELECTED:-}" "${API_RESULT:-}"
check web "${WEB_SELECTED:-}" "${WEB_RESULT:-}"

[ "$fail" -eq 0 ] && echo "All required validation passed."
exit "$fail"
