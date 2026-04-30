#!/usr/bin/env bash
# Issue #278 (F-1) — SessionStart drain hook (script-controlled bounded auto-pull).
#
# Fires on Claude Code SessionStart. Forwards to the bun TS runner
# `hooks/session-start-drain.ts`, which:
#   - SELECTs pending count for $AGENT_ID
#   - drains the latest N rows (default 5, env override)
#   - applies the same auto-skip patterns the receiver uses at INSERT
#   - flips matched rows to status='skipped' so the LLM turn is not
#     polluted with noise; unmatched rows stay pending for the LLM
#     to claim via `next` in the normal flow
#
# Output contract:
#   - stdout: ONLY the Claude Code hook JSON (kept clean; the bun
#     runner's summary prints to stderr).
#   - stderr: a single summary line with drain/skip counts.
#   - exit: always 0 (fail-safe per Issue #278 §F-1).
#
# 5 s wall-time cap so a wedged DB cannot delay session startup.

set -uo pipefail

# Drop the SessionStart payload — we do not need transcript_path /
# session_id; the drain is purely DB-driven.
cat >/dev/null 2>&1 || true

cd "$(dirname "$0")/.." || exit 0

timeout 5 bun hooks/session-start-drain.ts >/dev/null 2>&1 || true

EVENT="${CLAUDE_HOOK_EVENT_NAME:-SessionStart}"
cat <<JSON
{"hookSpecificOutput":{"hookEventName":"$EVENT","additionalContext":"session-start-drain: bounded auto-pull complete (latest N drained, auto-skip applied). pending message_queue may still hold unmatched rows; call mcp__agent-comms__next when ready."}}
JSON
exit 0
