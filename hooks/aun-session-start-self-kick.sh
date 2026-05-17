#!/usr/bin/env bash
# CTO spec dispatch (CEO P0) — cold-start LLM kick (SessionStart self-prime).
#
# Phase C bootstrap gap: on SessionStart (fresh install OR restart) the
# Claude Code TUI sits idle when there is a pending backlog but no new
# inbound message arrives to fire the wake-daemon. This hook closes the
# gap by reading the pending count itself and, when > 0, driving the
# TUI via `tmux send-keys` to call `mcp__aun__next` once.
#
# --- Adapter / port architecture (PR #321 cycle 3, axis 5 BLOCK resolve) ---
# This file is the thin orchestrator. The three variation axes (DB
# query / tmux session resolution / lock store) live in
# `hooks/lib/aun-self-kick-helpers.sh` as independently mockable
# functions. Each adapter is exercised both via the existing T-1〜T-4
# behavioral tests and by U-1/U-2/U-3 unit tests against PATH-prefix
# stubs and an isolated tmpdir.
#
# Output contract:
#   - stdout: ONLY the Claude Code hook JSON (empty additionalContext —
#     the kick is a side effect, not a context inject).
#   - stderr: optional one-line warning emitted by the DB adapter on
#     unreachable / missing URL / query failure.
#   - exit: always 0 (Issue #278 §F-1 fail-safe; never break the hook
#     chain).
#
# Wall-time budget: the synchronous portion (DB query) has its own
# 3 s `timeout` cap inside the helper. The async `sleep 3 + tmux
# send-keys` subshell is fire-and-forget after the synchronous body
# returns.

set -uo pipefail

# Drop the SessionStart payload — this hook is purely env / DB driven.
cat >/dev/null 2>&1 || true

EVENT="${CLAUDE_HOOK_EVENT_NAME:-SessionStart}"

# Always emit the JSON before doing the kick — the JSON is the visible
# contract; the kick is async side-effect. Doing it first means a later
# hard-error in the kick path cannot strip the JSON.
cat <<JSON
{"hookSpecificOutput":{"hookEventName":"$EVENT","additionalContext":""}}
JSON

# Source the adapter helpers. Sibling lookup works in both the
# in-repo location (`hooks/lib/...`) and the `aun init` install
# location (`~/.claude/hooks/lib/...`) since `aun init` preserves the
# directory layout.
HELPERS="$(dirname "$0")/lib/aun-self-kick-helpers.sh"
if [ ! -f "$HELPERS" ]; then
  # Helper missing — graceful exit so the hook chain stays unbroken.
  # This is the §2 (d) "helper source 失敗 → graceful exit 0" contract.
  exit 0
fi
# shellcheck disable=SC1090
source "$HELPERS"

# Adapter 2 — session resolution.
session=$(aun_self_kick_resolve_session)
[ -z "$session" ] && exit 0

agent_id="${AGENT_ID:-}"
[ -z "$agent_id" ] && exit 0

# Adapter 3 — lock check (per-(agent, tmux session) scope).
lock="/tmp/aun-self-kick-${agent_id}-${session}.lock"
aun_self_kick_check_lock "$lock" || exit 0

# Adapter 1 — DB query.
total=$(aun_self_kick_db_query "$agent_id")
[ -z "$total" ] && exit 0
[ "$total" -le 0 ] && exit 0

# Kick — orchestrator core (intentionally NOT abstracted into an
# adapter; over-abstraction is forbidden by the cycle 3 §3).
touch "$lock" 2>/dev/null || true
prompt="起動時 self-prime: pending ${total} 件。mcp__aun__next を呼んで処理してください。legacy alias: mcp__agent_comms__next / mcp__agent-comms__next"
(
  sleep 3
  tmux send-keys -t "$session" "$prompt" 2>/dev/null || true
  tmux send-keys -t "$session" Enter 2>/dev/null || true
) &
disown 2>/dev/null || true
exit 0
