#!/bin/bash
# run-codex-bot.sh — Codex runtime adapter for the native agent-comms loop.
#
# This is a thin, explicit wrapper around run-bot.sh. It keeps Codex bot
# traffic on the DB/MCP native route (`next` -> LLM -> `send`) instead of
# relying on Discord bot-authored echo messages.
set -euo pipefail

AGENT_ID="${1:?Usage: run-codex-bot.sh <agent-id>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export LLM_CMD="${LLM_CMD:-codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral}"
export LLM_TIMEOUT_SECONDS="${LLM_TIMEOUT_SECONDS:-180}"
export AGENT_COM_SYSTEM_PROMPT="${AGENT_COM_SYSTEM_PROMPT:-Codex runtime: communicate with peers only through native agent-comms. Use the provided response text as the body for agent-com send; never rely on Discord bot echo as delivery.}"

exec "$SCRIPT_DIR/run-bot.sh" "$AGENT_ID"
