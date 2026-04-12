#!/usr/bin/env bash
# S2-A (FEAT-005) rollout — daemon-owns-outbound
# Plan: docs/plans/outbound-forwarder-unification.md
# CEO approval: 2026-04-12 23:07 UTC
#
# Purpose: propagate AGENT_COM_RUNTIME=daemon to the bot tmux startup so
# `startOutboundConsumer()` and `PollingDriver.poll` actually boot after
# PR #164 merges. Without this env, the consumer runtime gate leaves the
# queue undrained.
#
# Current registry: scripts/bot-registry.txt (SESSION|PROJECT_DIR|AGENT_ID|PORT|COMMAND)
# Each row's COMMAND launches `claude ... server:agent-comms ...`; the MCP
# server inherits env from the tmux session, so setting the env before
# tmux new-session is enough — we do NOT need to rewrite the COMMAND column.
#
# Rollout stages (canary → fleet):
#   1. Apply to `discord-cto` and `discord-agent-com` only, verify:
#        - `psql $DATABASE_URL -f scripts/verify-no-outbound-dup.sql` = 0 rows
#        - No `status='processing'` rows stuck past OUTBOUND_ORPHAN_TIMEOUT_SEC
#   2. After 1h stable, roll the remaining sessions.
#   3. Rollback: remove the env from tmux env and `OUTBOUND_QUEUE_CONSUMER=0`
#      as the emergency kill.
#
# Usage:
#   bash scripts/rollout-daemon-owns-outbound.sh --dry-run
#   bash scripts/rollout-daemon-owns-outbound.sh --sessions discord-cto,discord-agent-com
#   bash scripts/rollout-daemon-owns-outbound.sh --all
#
# This script is a TEMPLATE. rollout execution is deferred to canary time
# (per CTO / lead-ama merge sequencing). Review before running.
set -euo pipefail

REGISTRY="${REGISTRY:-$(dirname "$0")/bot-registry.txt}"
DRY_RUN=0
TARGET=""

usage() {
  cat <<'USAGE'
Usage: rollout-daemon-owns-outbound.sh [options]
  --dry-run                         print planned actions, do not execute
  --sessions name1,name2,...        apply to specific tmux sessions only
  --all                             apply to every row in bot-registry.txt
  --help                            show this message
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --sessions) TARGET="$2"; shift 2 ;;
    --all) TARGET="__all__"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "error: one of --sessions or --all is required" >&2
  usage
  exit 2
fi

if [[ ! -f "$REGISTRY" ]]; then
  echo "error: registry not found: $REGISTRY" >&2
  exit 1
fi

apply_one() {
  local session="$1"
  local project_dir="$2"
  local agent_id="$3"
  local cmd="$4"
  echo "[${session}] agent=${agent_id} dir=${project_dir}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  DRY-RUN would: tmux kill-session -t ${session}; tmux new-session -d -s ${session} -c ${project_dir}"
    echo "  DRY-RUN would set AGENT_COM_RUNTIME=daemon in tmux env"
    return
  fi
  # Set session-scoped env first so the spawned claude inherits it.
  tmux set-environment -t "${session}" AGENT_COM_RUNTIME daemon 2>/dev/null || true
  # For existing sessions, the env is only picked up by new windows/panes.
  # Simpler + matches existing mcp__agent-comms__restart_bot pattern:
  tmux kill-session -t "${session}" 2>/dev/null || true
  tmux new-session -d -s "${session}" -c "${project_dir}" \
    "AGENT_COM_RUNTIME=daemon ${cmd}"
}

while IFS='|' read -r session project_dir agent_id port command; do
  [[ -z "${session:-}" || "${session:0:1}" == "#" ]] && continue
  if [[ "$TARGET" == "__all__" ]] || [[ ",${TARGET}," == *",${session},"* ]]; then
    # Expand ~ in project_dir
    project_dir="${project_dir/#\~/$HOME}"
    apply_one "$session" "$project_dir" "$agent_id" "$command"
  fi
done < "$REGISTRY"

echo "done."
