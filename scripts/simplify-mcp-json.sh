#!/bin/bash
# Remove DISCORD_BOT_TOKEN and DISCORD_STATE_DIR from all bot .mcp.json files
# and update agent-comms to SSE type pointing to daemon
# Usage: bash scripts/simplify-mcp-json.sh

DAEMON_URL="http://localhost:8080"

while IFS='|' read -r session projectDir agentId port command; do
  [[ "$session" =~ ^# ]] && continue
  [[ -z "$session" ]] && continue

  dir="${projectDir/#\~/$HOME}"
  mcp_file="$dir/.mcp.json"

  if [ ! -f "$mcp_file" ]; then
    echo "SKIP: $mcp_file not found ($session)"
    continue
  fi

  # Remove DISCORD_BOT_TOKEN and DISCORD_STATE_DIR from agent-comms env
  if grep -q 'DISCORD_BOT_TOKEN' "$mcp_file" 2>/dev/null; then
    jq '.mcpServers["agent-comms"].env |= del(.DISCORD_BOT_TOKEN, .DISCORD_STATE_DIR)' \
      "$mcp_file" > "${mcp_file}.tmp" && mv "${mcp_file}.tmp" "$mcp_file"
    echo "CLEANED: $session — removed DISCORD_BOT_TOKEN/DISCORD_STATE_DIR"
  else
    echo "OK: $session — no DISCORD_BOT_TOKEN found"
  fi
done < scripts/bot-registry.txt

echo "Done."
