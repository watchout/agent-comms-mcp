#!/usr/bin/env bash
# Issue #278 (§C + §G-3) — Stop hook v8 claim-close enforcement wrapper.
#
# Forwards stdin (Claude Code Stop hook payload) to the bun TS runner
# `hooks/claim-close-enforcement.ts`, which:
#   - inspects the bot's per-row claims + pending count
#   - blocks (exit 2 + additionalContext) when a claim is open or
#     pending rows remain unclaimed
#   - escalates on retry-limit-reached (§G-3) by writing audit_log,
#     a bypass log entry, and a CEO mention via `bun cli/index.ts notify`
#
# Output contract:
#   stdout = Claude Code hookSpecificOutput JSON (when blocking) or empty
#   stderr = error log lines if anything fails
#   exit   = 2 (block + re-prompt) | 0 (pass / escalation / fail-safe)
#
# 5 s wall-time cap so a wedged DB / MCP cannot delay session close.

set -uo pipefail

# Capture stdin so the bun runner can re-read it (timeout cannot pipe).
PAYLOAD=$(cat 2>/dev/null || true)

cd "$(dirname "$0")/.." || exit 0

# Forward via heredoc; preserve the runner's stdout (block JSON) and exit code.
OUT=$(printf '%s' "$PAYLOAD" | timeout 5 bun hooks/claim-close-enforcement.ts 2>>/dev/null)
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
