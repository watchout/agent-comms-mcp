#!/bin/bash
# classify-pr.sh — automatic PR route classification
#
# Scans changed files against protected pattern list and emits:
#   route:ceo-approval  — DB schema, auth, MCP contract, state-daemon, transport
#   route:fast-merge    — everything else
#
# Usage:
#   bash scripts/classify-pr.sh [BASE_BRANCH] [--json]
#   bash scripts/classify-pr.sh origin/main --json
#
# Exit codes:
#   0 → route:fast-merge
#   2 → route:ceo-approval
set -euo pipefail

BASE_BRANCH="${1:-origin/main}"
OUTPUT_FORMAT="text"
if [[ "${2:-}" == "--json" ]]; then
  OUTPUT_FORMAT="json"
fi

CHANGED=$(
  git diff --name-only "${BASE_BRANCH}...HEAD" 2>/dev/null \
    || git diff --name-only "${BASE_BRANCH}..HEAD"
)

if [ -z "$CHANGED" ]; then
  if [ "$OUTPUT_FORMAT" = "json" ]; then
    echo '{"route":"fast-merge","reasons":[],"files":[]}'
  else
    echo "route:fast-merge (no changed files)"
  fi
  exit 0
fi

REASONS=()
MATCHED_FILES=()

check_pattern() {
  local pattern="$1"
  local reason="$2"
  local matches
  matches=$(echo "$CHANGED" | grep -E "$pattern" || true)
  if [ -n "$matches" ]; then
    REASONS+=("$reason")
    MATCHED_FILES+=("$(echo "$matches" | head -3 | tr '\n' ' ')")
  fi
}

# ── DB schema / migration ──────────────────────────────────────────────────
check_pattern 'db/migrations/.*\.sql$'           "DB migration (.sql)"
check_pattern 'db/schema'                        "DB schema definition"

# ── Auth / credential / token ──────────────────────────────────────────────
check_pattern 'core/oauth'                       "OAuth/auth module"
check_pattern 'core/token'                       "Token management"
check_pattern '(credential|secret|\.env)'        "Credential/secret file"

# ── MCP contract / public API ─────────────────────────────────────────────
check_pattern 'adapters/streamable-http'         "MCP Streamable HTTP transport"
check_pattern 'core/routing/ports/'              "MCP routing port definitions"
# server.ts: only protected if HTTP endpoint surface changes
if echo "$CHANGED" | grep -q 'server\.ts$'; then
  if git diff "${BASE_BRANCH}...HEAD" -- server.ts 2>/dev/null \
     | grep -qE '^\+.*(pathname.*===.*\/mcp|\.well-known|oauth\/|\/sse[^-]|ListToolsRequest|CallToolRequest)'; then
    REASONS+=("server.ts: MCP/OAuth endpoint surface changed")
    MATCHED_FILES+=("server.ts")
  fi
fi

# ── State-daemon / runtime adapter ────────────────────────────────────────
check_pattern 'core/state-daemon/'               "State-daemon core"
check_pattern 'bin/(aun-watchdog|wake-daemon)'   "Daemon entrypoint"
check_pattern 'adapters/(discord|outbound)'      "Runtime adapter (Discord/outbound)"

# ── Queue / routing / claim / recovery ────────────────────────────────────
check_pattern 'config/queue-work-'               "Queue-work runtime policy"
check_pattern 'docs/spec/queue-work-'            "Queue-work runtime policy spec"
check_pattern 'scripts/queue-work-'              "Queue-work runtime tooling"
check_pattern 'tests/contract/state-daemon/'     "State-daemon contract tests"
check_pattern 'tests/(contract/state-daemon/)?state-daemon.*queue-work' "Queue-work/state-daemon contract tests"
check_pattern 'core/route-message\.'             "Core routing logic"
check_pattern 'core/send-(fanout|fallback|errors)' "Send/fanout/recovery"
check_pattern 'adapters/inbound-receiver'        "Inbound receiver"

# ── Production deploy / launchd ──────────────────────────────────────────
check_pattern '\.(plist|service|socket)$'        "launchd/systemd service file"

# ── Governance / gate scripts ────────────────────────────────────────────
check_pattern '\.github/workflows/'              "GitHub Actions workflow"
check_pattern 'scripts/(detect-breaking|classify-pr|post-merge-smoke)' "Gate/governance script"

# ── Result ────────────────────────────────────────────────────────────────
if [ ${#REASONS[@]} -eq 0 ]; then
  if [ "$OUTPUT_FORMAT" = "json" ]; then
    printf '{"route":"fast-merge","reasons":[],"files":[]}\n'
  else
    echo "route:fast-merge"
  fi
  exit 0
fi

if [ "$OUTPUT_FORMAT" = "json" ]; then
  reasons_json=$(printf '"%s",' "${REASONS[@]}"); reasons_json="[${reasons_json%,}]"
  files_json=$(printf '"%s",' "${MATCHED_FILES[@]}"); files_json="[${files_json%,}]"
  printf '{"route":"ceo-approval","reasons":%s,"files":%s}\n' "$reasons_json" "$files_json"
  exit 2
fi

echo "route:ceo-approval"
echo ""
echo "Protected pattern matches:"
for i in "${!REASONS[@]}"; do
  echo "  [${REASONS[$i]}]  →  ${MATCHED_FILES[$i]:-}"
done
exit 2
