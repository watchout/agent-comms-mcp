#!/usr/bin/env bash
# CTO spec dispatch (CEO P0) — cold-start LLM kick (SessionStart self-prime).
#
# Phase C bootstrap gap: on SessionStart (fresh install OR restart) the
# Claude Code TUI sits idle when there is a pending backlog but no new
# inbound message arrives to fire the wake-daemon. This hook closes the
# gap by reading the pending count itself and, when > 0, driving the
# TUI via `tmux send-keys` to call `mcp__agent-comms__next` once.
#
# Output contract:
#   - stdout: ONLY the Claude Code hook JSON (empty additionalContext —
#     the kick is a side effect, not a context inject).
#   - stderr: optional one-line warning on DB / tmux errors.
#   - exit: always 0 (Issue #278 §F-1 fail-safe; never break the hook
#     chain).
#
# 5 s wall-time cap so a wedged DB cannot delay session startup. The
# `sleep 3` before send-keys lives inside that budget — the actual
# tmux call is fire-and-forget after the sleep.

set -uo pipefail

# Drop the SessionStart payload — this hook is purely env / DB driven.
cat >/dev/null 2>&1 || true

EVENT="${CLAUDE_HOOK_EVENT_NAME:-SessionStart}"

emit_hook_json() {
  cat <<JSON
{"hookSpecificOutput":{"hookEventName":"$EVENT","additionalContext":""}}
JSON
}

# Always emit the JSON before doing the kick — the JSON is the visible
# contract; the kick is async side-effect. Doing it first means a later
# hard-error in the kick path cannot strip the JSON.
emit_hook_json

# Body runs under a 5 s wall cap.
{
  # (a) tmux session name — bail if not running under tmux.
  if [ -z "${TMUX:-}" ]; then
    exit 0
  fi
  session=$(tmux display-message -p '#S' 2>/dev/null || true)
  if [ -z "$session" ]; then
    exit 0
  fi

  # (b) AGENT_ID resolution.
  agent_id="${AGENT_ID:-}"
  if [ -z "$agent_id" ]; then
    # No AGENT_ID — cannot scope the count. Silent no-op.
    exit 0
  fi

  # (f) lock file: 5 min stale window prevents rapid-restart connect-storms.
  lock="/tmp/aun-self-kick-${agent_id}.lock"
  if [ -f "$lock" ]; then
    # File mtime within last 300 s = recent kick already fired.
    age=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || echo 0) ))
    if [ "$age" -ge 0 ] && [ "$age" -lt 300 ]; then
      exit 0
    fi
  fi

  # (c) DB query — 3 s timeout, failure tolerant.
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "aun-self-kick: DATABASE_URL unset, skipping" >&2
    exit 0
  fi

  total=$(timeout 3 psql "$DATABASE_URL" -tAX -v ON_ERROR_STOP=1 \
    -c "SELECT (SELECT COUNT(*) FROM message_queue WHERE agent_id='${agent_id}' AND status='pending') + (SELECT COUNT(*) FROM outbound_queue WHERE agent_id='${agent_id}' AND status IN ('pending','claimed')) AS total;" 2>/dev/null || echo "")

  if [ -z "$total" ] || ! [[ "$total" =~ ^[0-9]+$ ]]; then
    echo "aun-self-kick: DB unreachable or query failed, skipping" >&2
    exit 0
  fi

  if [ "$total" -le 0 ]; then
    exit 0
  fi

  # (d) kick — sleep 3 lets the TUI become interactive, then send-keys.
  touch "$lock" 2>/dev/null || true
  prompt="起動時 self-prime: pending ${total} 件。mcp__agent-comms__next を呼んで処理してください。"
  (
    sleep 3
    tmux send-keys -t "$session" "$prompt" 2>/dev/null || true
    tmux send-keys -t "$session" Enter 2>/dev/null || true
  ) &
  exit 0
} &

body_pid=$!
# Wall-time cap. If the body is still alive after 5 s, kill it. The
# backgrounded sleep+send-keys subshell is detached from $body_pid so
# the actual kick can still complete after this cap (intentional —
# the cap is for the synchronous DB / preflight portion only).
(
  sleep 5
  kill -0 "$body_pid" 2>/dev/null && kill "$body_pid" 2>/dev/null
) &

wait "$body_pid" 2>/dev/null || true
exit 0
