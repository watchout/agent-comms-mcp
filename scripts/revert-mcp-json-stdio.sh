#!/bin/bash
# Revert agent-comms to stdio mode (no Discord, tools only)
# Keep channel-server as-is
# Usage: bash scripts/revert-mcp-json-stdio.sh

CHANNEL_SERVER_PATH="/Users/yuji/Developer/agent-comms-mcp/channel-server.ts"
SERVER_PATH="/Users/yuji/Developer/agent-comms-mcp/server.ts"
BUN_PATH="/Users/yuji/.bun/bin/bun"

while IFS='|' read -r session projectDir agentId port command; do
  [[ "$session" =~ ^# ]] && continue
  [[ -z "$session" ]] && continue

  dir="${projectDir/#\~/$HOME}"
  mcp_file="$dir/.mcp.json"

  if [ ! -f "$mcp_file" ]; then
    echo "SKIP: $mcp_file not found ($session)"
    continue
  fi

  channel_port=$(echo "$command" | grep -o 'CHANNEL_PORT=[0-9]*' | cut -d= -f2)
  if [ -z "$channel_port" ]; then
    echo "SKIP: no CHANNEL_PORT for $session"
    continue
  fi

  # Replace agent-comms SSE with stdio (no Discord token)
  jq --arg server "$SERVER_PATH" \
     --arg bun "$BUN_PATH" \
     --arg agentId "$agentId" \
     --arg port "$port" \
     --arg chPath "$CHANNEL_SERVER_PATH" \
     --arg chPort "$channel_port" \
     '
     .mcpServers["agent-comms"] = {
       "command": $bun,
       "args": ["run", $server],
       "env": {
         "AGENT_ID": $agentId,
         "DATABASE_URL": "postgresql://localhost/agent_comms",
         "WEBHOOK_PORT": $port
       }
     }
     |
     .mcpServers["channel-server"] = {
       "command": $bun,
       "args": ["run", $chPath],
       "env": {
         "CHANNEL_PORT": $chPort
       }
     }
     ' "$mcp_file" > "${mcp_file}.tmp" && mv "${mcp_file}.tmp" "$mcp_file"

  echo "UPDATED: $session — agent-comms=stdio(tools only), channel-server=port:$channel_port"
done < scripts/bot-registry.txt

echo "Done."
