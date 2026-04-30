#!/usr/bin/env bash
# Issue #278 cycle 3 (CEO directive 3, action 3) — PreToolUse inbox gate wrapper.
#
# Forwards the Claude Code PreToolUse event payload to the bun TS
# runner `hooks/pre-tool-use-inbox-gate.ts`, which:
#   - allow-lists send / notify / skip / next / fail / reclaim
#     (the tools that drain the inbox),
#   - blocks every other tool whenever the bot has unread
#     message_queue rows (status='pending'),
#   - emits a re-prompt JSON on stdout when blocking.
#
# Output contract:
#   stdout = Claude Code hookSpecificOutput JSON (when blocking) or empty
#   stderr = error log lines if anything fails
#   exit   = 2 (block + re-prompt) | 0 (pass / allow-list / fail-safe)
#
# 5 s wall-time cap so a wedged DB cannot delay every tool call.

set -uo pipefail

# Capture stdin so the bun runner can re-read it (timeout cannot pipe).
PAYLOAD=$(cat 2>/dev/null || true)

cd "$(dirname "$0")/.." || exit 0

OUT=$(printf '%s' "$PAYLOAD" | timeout 5 bun hooks/pre-tool-use-inbox-gate.ts 2>>/dev/null)
RC=$?

# A wedged runner (timeout / unhandled error) → fail-safe pass.
if [ $RC -ne 0 ] && [ $RC -ne 2 ]; then
  exit 0
fi

# Pass-through stdout when the runner emitted block JSON.
if [ -n "$OUT" ]; then
  printf '%s\n' "$OUT"
fi

exit $RC
