#!/bin/bash
# Add channel-server MCP entry to all bot project directories
# Usage: bash scripts/add-channel-server-mcp.sh

CHANNEL_SERVER_PATH="/Users/yuji/Developer/agent-comms-mcp/channel-server.ts"
BUN_PATH="/Users/yuji/.bun/bin/bun"

# Read bot registry and update each project's .mcp.json
while IFS='|' read -r session projectDir agentId port command; do
  # Skip comments and empty lines
  [[ "$session" =~ ^# ]] && continue
  [[ -z "$session" ]] && continue

  dir="${projectDir/#\~/$HOME}"
  mcp_file="$dir/.mcp.json"

  if [ ! -f "$mcp_file" ]; then
    echo "SKIP: $mcp_file not found ($session)"
    continue
  fi

  # Check if channel-server already exists
  if grep -q '"channel-server"' "$mcp_file" 2>/dev/null; then
    echo "EXISTS: $session already has channel-server in .mcp.json"
    continue
  fi

  # Extract channel_port from the command (CHANNEL_PORT=XXXX)
  channel_port=$(echo "$command" | grep -o 'CHANNEL_PORT=[0-9]*' | cut -d= -f2)
  if [ -z "$channel_port" ]; then
    echo "SKIP: no CHANNEL_PORT in command for $session"
    continue
  fi

  # Add channel-server entry using bun/jq
  if command -v jq &>/dev/null; then
    jq --arg path "$CHANNEL_SERVER_PATH" \
       --arg bun "$BUN_PATH" \
       --arg port "$channel_port" \
       '.mcpServers["channel-server"] = {
         "command": $bun,
         "args": ["run", $path],
         "env": {
           "CHANNEL_PORT": $port
         }
       }' "$mcp_file" > "${mcp_file}.tmp" && mv "${mcp_file}.tmp" "$mcp_file"
    echo "ADDED: $session → channel-server (port $channel_port)"
  else
    echo "ERROR: jq not installed"
    exit 1
  fi
done < scripts/bot-registry.txt

echo "Done."
