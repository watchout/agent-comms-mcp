#!/usr/bin/env bash
# PR #233 — auto-next hook (v4-compliant, stdin-parsing).
#
# Fires on SessionStart + UserPromptSubmit. Modern Claude Code passes the hook
# payload (including `hook_event_name`) as JSON on stdin; the older
# `$CLAUDE_HOOK_EVENT_NAME` env var path is no longer reliable, so we parse
# stdin and fall back to SessionStart only for dry-run / smoke-test.
#
# Background: the xmarketing pilot (2026-04-24) failed with a hardcoded
# `SessionStart` on UserPromptSubmit — type mismatch silenced the
# additionalContext. The 2026-04-26 outage (auto-next.sh hookEventName
# stripped via sed) re-surfaced the same class of failure.
#
# Install: see scripts/install-auto-next-hook.sh (registers this script for
# both SessionStart and UserPromptSubmit in each bot's .claude/settings.json).

set -euo pipefail

INPUT=$(cat)
EVENT=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hook_event_name','SessionStart'))" 2>/dev/null || echo "SessionStart")

cat <<JSON
{"hookSpecificOutput":{"hookEventName":"$EVENT","additionalContext":"auto-next: pending message_queue may be non-empty. Call \`mcp__agent-comms__next\` once; if waiting>0 process the message, otherwise no-op and continue."}}
JSON
