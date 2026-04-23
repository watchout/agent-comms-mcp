#!/usr/bin/env bash
# PR #0 — auto-next hook.
#
# Fires on SessionStart (or UserPromptSubmit after a wake-daemon tmux send-keys
# nudge). Emits a Claude Code hook payload whose `additionalContext` tells the
# session to drain its pending message_queue via `mcp__agent-comms__next`.
#
# The hook itself does not call the MCP tool — Claude Code does, guided by
# the additionalContext. Empty queue → the `next` tool returns {waiting:0}
# and the session no-ops (§1.3).
#
# Install: see scripts/install-auto-next-hook.sh (registers this script in
# each bot's .claude/settings.json).

set -euo pipefail

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "auto-next: pending message_queue may be non-empty. Call `mcp__agent-comms__next` once; if waiting>0 process the message, otherwise no-op and continue."
  }
}
JSON
