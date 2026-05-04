#!/usr/bin/env bash
# claude-router test runner
#
# For each tests/*.json case:
#   1. Allocate a temp sandbox (mktemp -d).
#   2. Run `claude -p --dangerously-skip-permissions --output-format stream-json
#      --verbose <prompt>` inside the sandbox, with router env exported.
#   3. Parse the stream-json output - collect tool_use blocks, stop_reason,
#      and the model that answered (from the router footer).
#   4. Compare against the test's `expect` clause - print PASS / FAIL.
#   5. Persist the per-test result JSON under
#      ${RESULTS_DIR:-~/sandbox/claude-router-tests/results/<ts>}/<name>.json.
#
# Usage:
#   bin/run-tests.sh                    # run every tests/*.json
#   bin/run-tests.sh tests/00-bash-pwd.json  # run a specific test file
#   KEEP_SANDBOX=1 bin/run-tests.sh     # don't delete sandboxes (debug)
#
# Requires: jq, claude (Claude Code CLI), a running router stack on :3457.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS_DIR="${REPO_DIR}/tests"

TS="$(date '+%Y%m%dT%H%M%S')"
RESULTS_DIR="${RESULTS_DIR:-${HOME}/sandbox/claude-router-tests/results/${TS}}"
SANDBOX_BASE="${SANDBOX_BASE:-${HOME}/sandbox/claude-router-tests/sandboxes}"
mkdir -p "${RESULTS_DIR}" "${SANDBOX_BASE}"

# --- prerequisites -----------------------------------------------------------

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 2; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: claude not in PATH" >&2; exit 2; }

if ! curl -sf --noproxy '*' -o /dev/null --max-time 3 http://127.0.0.1:3457/; then
  echo "ERROR: router stack not responding on :3457. Start it: claude-router-reload" >&2
  exit 2
fi

# --- collect test files ------------------------------------------------------

if [ "$#" -gt 0 ]; then
  TESTS=("$@")
else
  TESTS=()
  while IFS= read -r -d '' f; do TESTS+=("$f"); done \
    < <(find "${TESTS_DIR}" -maxdepth 1 -name '*.json' -print0 | sort -z)
fi

if [ "${#TESTS[@]}" -eq 0 ]; then
  echo "no tests found in ${TESTS_DIR}" >&2
  exit 0
fi

echo "claude-router test suite"
echo "  tests:    ${#TESTS[@]}"
echo "  results:  ${RESULTS_DIR}"
echo

PASS=0
FAIL=0
ERROR=0

# --- per-test loop -----------------------------------------------------------

for test_file in "${TESTS[@]}"; do
  name=$(jq -r '.name' "${test_file}")
  prompt=$(jq -r '.prompt' "${test_file}")
  expect_tool=$(jq -r '.expect.tool_call_required // false' "${test_file}")
  expect_names=$(jq -r '.expect.tool_name_any_of // [] | join(",")' "${test_file}")

  printf '%-32s ' "${name}"

  sandbox=$(mktemp -d "${SANDBOX_BASE}/${name}.XXXXXX")
  raw_log="${RESULTS_DIR}/${name}.stream.jsonl"
  result_file="${RESULTS_DIR}/${name}.json"

  # Run claude in sandbox. Stack already runs on :3457 - we just point at it.
  set +e
  ( cd "${sandbox}" && \
    env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
        -u ALL_PROXY -u all_proxy -u ANTHROPIC_AUTH_TOKEN \
        ANTHROPIC_BASE_URL=http://localhost:3457 \
        ANTHROPIC_API_KEY=not-needed \
        API_TIMEOUT_MS=600000 \
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
        claude -p --dangerously-skip-permissions \
               --output-format stream-json --verbose \
               "${prompt}" \
  ) >"${raw_log}" 2>&1
  exit_code=$?
  set -e

  # --- parse stream output ---------------------------------------------------

  # tool_use blocks across all assistant events
  tool_uses=$(jq -c -s '
    [
      .[] | select(.type=="assistant") | .message.content[]?
      | select(.type=="tool_use") | {name, id}
    ]
  ' "${raw_log}" 2>/dev/null || echo "[]")
  tool_count=$(echo "${tool_uses}" | jq 'length')
  tool_names=$(echo "${tool_uses}" | jq -r 'map(.name) | join(",")')

  # final stop_reason and result text from the result event
  stop_reason=$(jq -r 'select(.type=="result") | .stop_reason' "${raw_log}" 2>/dev/null \
                | head -1)
  is_error=$(jq -r 'select(.type=="result") | .is_error' "${raw_log}" 2>/dev/null \
             | head -1)

  # router footer tells us which model the request landed on
  model_picked=$(grep -oE '\[router\] [a-z0-9-]+' "${raw_log}" \
                 | head -1 | awk '{print $2}')

  # --- decide PASS / FAIL ----------------------------------------------------

  status="PASS"
  reason=""

  if [ "${exit_code}" -ne 0 ] || [ "${is_error}" = "true" ]; then
    status="ERROR"
    reason="exit=${exit_code} api_error=${is_error}"
  elif [ "${expect_tool}" = "true" ]; then
    if [ "${tool_count}" -eq 0 ]; then
      status="FAIL"
      reason="expected tool call, got text-only (stop=${stop_reason})"
    elif [ -n "${expect_names}" ]; then
      ok=0
      IFS=',' read -ra wants <<< "${expect_names}"
      IFS=',' read -ra gots <<< "${tool_names}"
      for w in "${wants[@]}"; do
        for g in "${gots[@]}"; do
          [ "${w}" = "${g}" ] && ok=1 && break 2
        done
      done
      if [ "${ok}" -eq 0 ]; then
        status="FAIL"
        reason="expected tool name in {${expect_names}}, got {${tool_names}}"
      fi
    fi
  fi

  case "${status}" in
    PASS)  PASS=$((PASS+1)) ;;
    FAIL)  FAIL=$((FAIL+1)) ;;
    ERROR) ERROR=$((ERROR+1)) ;;
  esac

  printf '%-5s [model=%s tools=%d:%s stop=%s]' \
    "${status}" "${model_picked:--}" "${tool_count}" \
    "${tool_names:--}" "${stop_reason:--}"
  [ -n "${reason}" ] && printf ' -- %s' "${reason}"
  echo

  # --- persist per-test result ----------------------------------------------

  jq -n \
    --arg name "${name}" \
    --arg prompt "${prompt}" \
    --arg status "${status}" \
    --arg model "${model_picked:-}" \
    --arg stop "${stop_reason:-}" \
    --arg sandbox "${sandbox}" \
    --argjson tool_uses "${tool_uses}" \
    --arg reason "${reason}" \
    '{name:$name, status:$status, prompt:$prompt, model:$model,
      stop_reason:$stop, tool_uses:$tool_uses, reason:$reason,
      sandbox:$sandbox}' \
    > "${result_file}"

  # cleanup sandbox unless KEEP_SANDBOX=1 or test failed
  if [ "${KEEP_SANDBOX:-0}" != "1" ] && [ "${status}" = "PASS" ]; then
    rm -rf "${sandbox}"
  fi
done

# --- summary -----------------------------------------------------------------

echo
echo "Summary: ${PASS} passed, ${FAIL} failed, ${ERROR} errored"
echo "Per-test JSON results: ${RESULTS_DIR}/"
[ "${FAIL}" -eq 0 ] && [ "${ERROR}" -eq 0 ] && exit 0 || exit 1
