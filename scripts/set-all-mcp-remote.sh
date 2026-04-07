#!/bin/bash
# Set all bot .mcp.json to use mcp-remote (local install) for agent-comms
# Usage: bash scripts/set-all-mcp-remote.sh

MCP_REMOTE="/opt/homebrew/bin/mcp-remote"
DAEMON_URL="http://localhost:8800"
CHANNEL_SERVER="/Users/yuji/Developer/agent-comms-mcp/channel-server.ts"
BUN="/Users/yuji/.bun/bin/bun"

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

  jq --arg remote "$MCP_REMOTE" \
     --arg url "${DAEMON_URL}/sse?bot_id=${agentId}" \
     --arg bun "$BUN" \
     --arg chPath "$CHANNEL_SERVER" \
     --arg chPort "$channel_port" \
     '
     .mcpServers["agent-comms"] = {
       "command": $remote,
       "args": [$url, "--header", "Authorization: Bearer local-no-auth"]
     }
     |
     .mcpServers["channel-server"] = {
       "command": $bun,
       "args": ["run", $chPath],
       "env": { "CHANNEL_PORT": $chPort }
     }
     ' "$mcp_file" > "${mcp_file}.tmp" && mv "${mcp_file}.tmp" "$mcp_file"

  echo "SET: $session → mcp-remote(bot_id=$agentId) + channel-server(port:$channel_port)"
done < scripts/bot-registry.txt

echo "Done."
