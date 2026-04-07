#!/bin/bash
# Update all bot .mcp.json: npx mcp-remote → mcp-remote (local install)
# Usage: bash scripts/update-mcp-remote-local.sh

MCP_REMOTE_PATH="/opt/homebrew/bin/mcp-remote"

while IFS='|' read -r session projectDir agentId port command; do
  [[ "$session" =~ ^# ]] && continue
  [[ -z "$session" ]] && continue

  dir="${projectDir/#\~/$HOME}"
  mcp_file="$dir/.mcp.json"

  if [ ! -f "$mcp_file" ]; then
    echo "SKIP: $mcp_file not found ($session)"
    continue
  fi

  # Check if using npx mcp-remote
  if grep -q '"npx"' "$mcp_file" 2>/dev/null; then
    # Replace npx with direct mcp-remote path
    jq --arg path "$MCP_REMOTE_PATH" \
       '.mcpServers["agent-comms"].command = $path |
        .mcpServers["agent-comms"].args = (.mcpServers["agent-comms"].args | map(select(. != "mcp-remote")))' \
       "$mcp_file" > "${mcp_file}.tmp" && mv "${mcp_file}.tmp" "$mcp_file"
    echo "UPDATED: $session → mcp-remote local"
  else
    echo "OK: $session — not using npx"
  fi
done < scripts/bot-registry.txt

echo "Done."
