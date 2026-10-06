#!/usr/bin/env bash
# Outcome matrix for ci-gate.sh. Runs in CI before the gate is trusted, so a
# regression in the gate logic fails the build instead of silently passing.
set -uo pipefail
gate="$(dirname "$0")/ci-gate.sh"
failures=0

# expect  CHANGES  API_SEL API_RES   WEB_SEL WEB_RES   description
cases=(
  "pass success true  success   true  success   both changed, both passed"
  "pass success true  success   false skipped   api changed and passed, web legitimately skipped"
  "pass success false skipped   true  success   web changed and passed, api legitimately skipped"
  "pass success false skipped   false skipped   nothing changed, both legitimately skipped"
  "fail success true  skipped   false skipped   api changed but unexpectedly skipped"
  "fail success false skipped   true  skipped   web changed but unexpectedly skipped"
  "fail success true  failure   false skipped   api failed"
  "fail success false skipped   true  failure   web failed"
  "fail success true  cancelled false skipped   api cancelled"
  "fail success false skipped   true  cancelled web cancelled"
  "fail success false success   false skipped   api ran although unselected"
  "fail success false failure   false skipped   api failed although unselected"
  "fail failure false skipped   false skipped   change detection failed (skips must not pass)"
  "fail cancelled false skipped false skipped   change detection cancelled"
  "fail success _     skipped   false skipped   api selector missing"
  "fail success TRUE  success   false skipped   api selector not exactly true/false"
  "fail success true  _         false skipped   api result missing"
)

for c in "${cases[@]}"; do
  read -r expect changes api_sel api_res web_sel web_res desc <<<"$c"
  [ "$api_sel" = "_" ] && api_sel=""
  [ "$api_res" = "_" ] && api_res=""
  if CHANGES=$changes API_SELECTED=$api_sel API_RESULT=$api_res \
     WEB_SELECTED=$web_sel WEB_RESULT=$web_res bash "$gate" >/dev/null 2>&1; then
    got=pass
  else
    got=fail
  fi
  if [ "$got" = "$expect" ]; then
    echo "ok   [$expect] $desc"
  else
    echo "FAIL [expected $expect, got $got] $desc"
    failures=$((failures + 1))
  fi
done

echo "${#cases[@]} cases, $failures failures."
[ "$failures" -eq 0 ]
