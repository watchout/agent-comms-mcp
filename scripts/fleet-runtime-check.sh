#!/usr/bin/env bash
# fleet-runtime-check.sh — read-only fleet runtime diagnostics
#
# Reports:
#   1. Runtime mismatch: DB profile says X but tmux pane runs Y
#   2. Wake-stuck bots: pending queue + no active claims + no wake progress
#   3. Codex-runner gap: codex runtime bots with stuck pending
#      (wake-daemon tmux send-keys "check inbox" does not reliably wake Codex TUI;
#       state-daemon codex-runner path is required — if disabled, bots stall silently)
#   4. Missing endpoint leases for active connectors
#
# Exit codes:
#   0 → all clear
#   1 → issues found (review needed)
#
# Usage:
#   bash scripts/fleet-runtime-check.sh [--json]
#   DATABASE_URL=... bash scripts/fleet-runtime-check.sh
set -euo pipefail

OUTPUT_JSON=0
[[ "${1:-}" == "--json" ]] && OUTPUT_JSON=1

DB_URL="${DATABASE_URL:-postgresql:///agent_comms?host=/tmp}"

ISSUE_LIST=""

add_issue() {
  if [[ -z "$ISSUE_LIST" ]]; then
    ISSUE_LIST="$*"
  else
    ISSUE_LIST="${ISSUE_LIST}
$*"
  fi
}

# ── 1. Query DB for all active bots ─────────────────────────────────────────
bot_data=$(psql "$DB_URL" -tA --csv -c "
  SELECT
    a.agent_id,
    COALESCE(a.runtime_engine_preference, '') AS runtime_pref,
    a.status,
    COALESCE(a.metadata->>'tmux_session', '') AS tmux_session,
    (
      SELECT COUNT(*)
      FROM message_queue mq
      WHERE mq.agent_id = a.agent_id
        AND mq.status = 'pending'
        AND mq.created_at < NOW() - INTERVAL '5 minutes'
    )::int AS stuck_pending,
    (
      SELECT COUNT(*)
      FROM message_queue mq
      WHERE mq.agent_id = a.agent_id
        AND mq.status = 'in_progress'
    )::int AS active_claims
  FROM agents a
  WHERE a.status IN ('online','idle','busy')
  ORDER BY a.agent_id
" 2>/dev/null || echo "DB_ERROR")

if [[ "$bot_data" == "DB_ERROR" ]]; then
  echo "ERROR: cannot connect to DB at $DB_URL" >&2
  exit 1
fi

# ── 2. Fetch tmux pane commands once (avoid N separate tmux calls) ───────────
# Format: "session_name pane_cmd" pairs, one per line
tmux_snapshot=""
if command -v tmux >/dev/null 2>&1; then
  tmux_snapshot=$(tmux list-panes -aF '#{session_name} #{pane_current_command}' 2>/dev/null || true)
fi

get_pane_cmd() {
  local session="$1"
  [[ -z "$session" ]] && echo "unknown" && return
  echo "$tmux_snapshot" | awk -v s="$session" '$1==s{print $2; exit}' || echo "unknown"
}

# ── 3. Per-bot analysis ──────────────────────────────────────────────────────
ROW_OUTPUT=""
JSON_ROWS=""
first_json=1

while IFS=',' read -r agent_id runtime_pref status tmux_session stuck_pending active_claims; do
  [[ "$agent_id" == "agent_id" ]] && continue  # skip CSV header

  pane_cmd=$(get_pane_cmd "$tmux_session")
  wake_stuck=0
  runtime_mismatch=0
  codex_runner_gap=0

  # wake-stuck: pending > 0, no active claims
  if [[ "$stuck_pending" -gt 0 && "$active_claims" -eq 0 ]]; then
    wake_stuck=1
    add_issue "WAKE_STUCK: ${agent_id} (${stuck_pending} stuck pending, 0 active claims)"
  fi

  # runtime mismatch
  if [[ "$runtime_pref" == "codex" && "$pane_cmd" != "unknown" ]]; then
    case "$pane_cmd" in
      node|codex) ;;  # expected
      *)
        runtime_mismatch=1
        add_issue "RUNTIME_MISMATCH: ${agent_id} DB=codex pane=${pane_cmd}"
        ;;
    esac
  fi
  if [[ "$runtime_pref" == "claude-code" && "$pane_cmd" != "unknown" ]]; then
    case "$pane_cmd" in
      node|claude|claude.exe|bun) ;;  # expected (claude.exe = macOS Claude Code CLI)
      codex)
        runtime_mismatch=1
        add_issue "RUNTIME_MISMATCH: ${agent_id} DB=claude-code pane=${pane_cmd}"
        ;;
    esac
  fi

  # codex-runner gap: codex runtime + stuck pending
  if [[ "$runtime_pref" == "codex" && "$stuck_pending" -gt 0 && "$active_claims" -eq 0 ]]; then
    codex_runner_gap=1
    add_issue "CODEX_RUNNER_GAP: ${agent_id} has ${stuck_pending} stuck pending — codex-runner required to drain"
  fi

  ROW_OUTPUT="${ROW_OUTPUT}
${agent_id}|${runtime_pref}|${status}|${pane_cmd}|${stuck_pending}|${active_claims}|${wake_stuck}|${runtime_mismatch}|${codex_runner_gap}"

  if [[ "$OUTPUT_JSON" -eq 1 ]]; then
    [[ "$first_json" -eq 0 ]] && JSON_ROWS="${JSON_ROWS},"
    first_json=0
    JSON_ROWS="${JSON_ROWS}{\"agent_id\":\"${agent_id}\",\"runtime_pref\":\"${runtime_pref}\",\"status\":\"${status}\",\"pane_cmd\":\"${pane_cmd}\",\"stuck_pending\":${stuck_pending},\"active_claims\":${active_claims},\"wake_stuck\":${wake_stuck},\"runtime_mismatch\":${runtime_mismatch},\"codex_runner_gap\":${codex_runner_gap}}"
  fi
done <<< "$bot_data"

# ── 4. Missing endpoint leases ───────────────────────────────────────────────
missing_leases=$(psql "$DB_URL" -tAc "
  SELECT ci.agent_id
  FROM connector_instances ci
  LEFT JOIN control_plane_leases cpl
    ON cpl.lease_scope_type = 'runtime_instance'
   AND cpl.lease_scope_id = ci.runtime_instance_id::text
   AND cpl.status = 'active'
   AND cpl.expires_at > NOW()
  WHERE ci.status = 'active'
    AND cpl.lease_id IS NULL
  GROUP BY ci.agent_id
  ORDER BY ci.agent_id
" 2>/dev/null || true)

JSON_LEASE_ROWS=""
first_lease=1
if [[ -n "$missing_leases" ]]; then
  while IFS= read -r bot; do
    [[ -z "$bot" ]] && continue
    add_issue "MISSING_LEASE: ${bot} active connector has no valid endpoint lease"
    if [[ "$OUTPUT_JSON" -eq 1 ]]; then
      [[ "$first_lease" -eq 0 ]] && JSON_LEASE_ROWS="${JSON_LEASE_ROWS},"
      first_lease=0
      JSON_LEASE_ROWS="${JSON_LEASE_ROWS}\"${bot}\""
    fi
  done <<< "$missing_leases"
fi

# ── 5. Output ────────────────────────────────────────────────────────────────
issue_count=0
[[ -n "$ISSUE_LIST" ]] && issue_count=$(echo "$ISSUE_LIST" | wc -l | tr -d ' ')

if [[ "$OUTPUT_JSON" -eq 1 ]]; then
  printf '{"bots":[%s],"missing_leases":[%s],"issue_count":%d}\n' \
    "$JSON_ROWS" "$JSON_LEASE_ROWS" "$issue_count"
else
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "  Fleet Runtime Check"
  echo "══════════════════════════════════════════════════════════════"
  printf "%-22s %-14s %-8s %-10s %6s %6s\n" "AGENT" "RUNTIME_PREF" "STATUS" "PANE" "STUCK" "CLAIMS"
  echo "──────────────────────────────────────────────────────────────"
  while IFS='|' read -r agent_id runtime_pref status pane_cmd stuck_pending active_claims wake_stuck runtime_mismatch codex_runner_gap; do
    [[ -z "$agent_id" ]] && continue
    flag=""
    [[ "$wake_stuck" -eq 1 ]] && flag="${flag} ⚠WAKE"
    [[ "$runtime_mismatch" -eq 1 ]] && flag="${flag} ❌MISMATCH"
    [[ "$codex_runner_gap" -eq 1 ]] && flag="${flag} 🔴GAP"
    printf "%-22s %-14s %-8s %-10s %6s %6s%s\n" \
      "$agent_id" "$runtime_pref" "$status" "$pane_cmd" "$stuck_pending" "$active_claims" "$flag"
  done <<< "$ROW_OUTPUT"
  echo ""
  if [[ "$issue_count" -eq 0 ]]; then
    echo "  ✅ No issues found"
  else
    echo "  Issues (${issue_count}):"
    while IFS= read -r issue; do
      echo "    - $issue"
    done <<< "$ISSUE_LIST"
  fi
  echo "══════════════════════════════════════════════════════════════"
  echo ""
fi

[[ "$issue_count" -eq 0 ]] && exit 0 || exit 1
