#!/usr/bin/env bash
# PR #233 — auto-next hook (v4-compliant).
#
# Fires on SessionStart + UserPromptSubmit. Claude Code exports the triggering
# event name as $CLAUDE_HOOK_EVENT_NAME; the payload echoes that verbatim so
# the output's hookEventName matches the actual event (the xmarketing pilot
# 2026-04-24 failed with a hardcoded `SessionStart` on UserPromptSubmit — type
# mismatch silenced the additionalContext).
#
# The hook itself does not call the MCP tool — Claude Code does, guided by
# additionalContext. Empty queue → the `next` tool returns {waiting:0} and
# the session no-ops (§1.3).
#
# Install: see scripts/install-auto-next-hook.sh (registers this script for
# both SessionStart and UserPromptSubmit in each bot's .claude/settings.json).

set -euo pipefail

# Fallback is only used when the hook is dry-run outside of Claude Code; a
# real invocation always sets CLAUDE_HOOK_EVENT_NAME.
EVENT="${CLAUDE_HOOK_EVENT_NAME:-SessionStart}"

cat <<JSON
{"hookSpecificOutput":{"hookEventName":"$EVENT","additionalContext":"auto-next: pending message_queue may be non-empty. Call \`mcp__agent-comms__next\` once; if waiting>0 process the message, otherwise no-op and continue."}}
JSON
