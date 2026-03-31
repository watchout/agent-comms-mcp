#!/usr/bin/env bash
# start-auditor.sh — Start API Auditor with API keys from ~/.agent-com-api-keys
# Usage: ./scripts/start-auditor.sh [provider]
#   provider: anthropic (default), openai, google

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load API keys
API_KEYS_FILE="$HOME/.agent-com-api-keys"
if [ -f "$API_KEYS_FILE" ]; then
  set -a
  source "$API_KEYS_FILE"
  set +a
  echo "[start-auditor] Loaded API keys from $API_KEYS_FILE" >&2
else
  echo "[start-auditor] Warning: $API_KEYS_FILE not found" >&2
fi

# Set provider from argument or default
export LLM_PROVIDER="${1:-${LLM_PROVIDER:-anthropic}}"
export DATABASE_URL="${DATABASE_URL:-postgresql://localhost/agent_comms}"

echo "[start-auditor] Provider: $LLM_PROVIDER" >&2

cd "$PROJECT_DIR"
exec bun run scripts/api-auditor.ts
