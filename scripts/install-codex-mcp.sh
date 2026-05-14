#!/bin/bash
# install-codex-mcp.sh — Register agent-comms-mcp as a Codex CLI MCP server.
#
# This uses the Codex CLI's native registry command instead of editing
# ~/.codex/config.toml by hand. The resulting config shape is:
#   [mcp_servers.agent-comms]
#   command = "bun"
#   args = ["run", "--cwd", "<repo>", "server.ts"]
#
# Usage:
#   ./scripts/install-codex-mcp.sh --agent-id codex-bot
#   ./scripts/install-codex-mcp.sh --agent-id codex-bot --database-url postgresql://localhost/agent_comms --webhook-port 8795
#   ./scripts/install-codex-mcp.sh --force --name agent-comms-dev --agent-id codex-dev
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

NAME="agent-comms"
AGENT_ID="${AGENT_ID:-}"
DATABASE_URL="${DATABASE_URL:-postgresql://localhost/agent_comms}"
WEBHOOK_PORT="${WEBHOOK_PORT:-8795}"
FORCE=0

usage() {
  cat <<'EOS'
Usage: install-codex-mcp.sh --agent-id <id> [options]

Options:
  --name <name>              Codex MCP server name (default: agent-comms)
  --agent-id <id>            AGENT_ID for this Codex session (required)
  --database-url <url>       DATABASE_URL (default: postgresql://localhost/agent_comms)
  --webhook-port <port>      WEBHOOK_PORT (default: 8795)
  --force                    Remove an existing Codex MCP entry before adding
  -h, --help                 Show this help
EOS
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      NAME="${2:?--name requires a value}"
      shift 2
      ;;
    --name=*)
      NAME="${1#--name=}"
      shift
      ;;
    --agent-id)
      AGENT_ID="${2:?--agent-id requires a value}"
      shift 2
      ;;
    --agent-id=*)
      AGENT_ID="${1#--agent-id=}"
      shift
      ;;
    --database-url)
      DATABASE_URL="${2:?--database-url requires a value}"
      shift 2
      ;;
    --database-url=*)
      DATABASE_URL="${1#--database-url=}"
      shift
      ;;
    --webhook-port)
      WEBHOOK_PORT="${2:?--webhook-port requires a value}"
      shift 2
      ;;
    --webhook-port=*)
      WEBHOOK_PORT="${1#--webhook-port=}"
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unexpected argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$AGENT_ID" ] || { echo "ERROR: --agent-id is required" >&2; usage >&2; exit 2; }
command -v codex >/dev/null 2>&1 || { echo "ERROR: codex CLI not found in PATH" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found in PATH" >&2; exit 1; }

if [ "$FORCE" = "1" ]; then
  codex mcp remove "$NAME" >/dev/null 2>&1 || true
fi

codex mcp add "$NAME" \
  --env "AGENT_ID=$AGENT_ID" \
  --env "DATABASE_URL=$DATABASE_URL" \
  --env "WEBHOOK_PORT=$WEBHOOK_PORT" \
  -- bun run --cwd "$REPO_DIR" server.ts

echo "[install-codex-mcp] registered '$NAME' for AGENT_ID=$AGENT_ID"
echo "[install-codex-mcp] verify with: codex mcp get $NAME"
