#!/bin/bash
# Restore all bot .mcp.json to stdio mode with DISCORD_BOT_TOKEN
# Usage: bash scripts/restore-stdio-discord.sh

SERVER_PATH="/Users/yuji/Developer/agent-comms-mcp/server.ts"
BUN="/Users/yuji/.bun/bin/bun"
API_KEYS="$HOME/.agent-com-api-keys"

# Token map (agent_id → token key in api-keys file)
declare -A TOKEN_MAP
TOKEN_MAP[cto]="IYASAKA_CTO_token"
TOKEN_MAP[arc]="IYASAKA_ARC_token"
TOKEN_MAP[hotel-dev]="Hotel_Dev_token"
TOKEN_MAP[vice]="IYASAKA_VICE_token"
TOKEN_MAP[agent-com-dev]="Agentcom_Dev_token"
TOKEN_MAP[auditor]="Dev_Audit_token"
TOKEN_MAP[webb-dev]="Webb_Dev_token"
TOKEN_MAP[secretary]="IYASAKA_SEC_token"
TOKEN_MAP[agent-mem-dev]="Agentmem_DEV_token"

while IFS='|' read -r session projectDir agentId port command; do
  [[ "$session" =~ ^# ]] && continue
  [[ -z "$session" ]] && continue

  dir="${projectDir/#\~/$HOME}"
  mcp_file="$dir/.mcp.json"
  state_dir="$HOME/.claude/channels/$session"

  if [ ! -f "$mcp_file" ]; then
    echo "SKIP: $mcp_file not found ($session)"
    continue
  fi

  # Get token for this agent
  token_key="${TOKEN_MAP[$agentId]}"
  token=""
  if [ -n "$token_key" ] && [ -f "$API_KEYS" ]; then
    token=$(grep "^${token_key}=" "$API_KEYS" | cut -d= -f2)
  fi

  # Build env object
  env_json=$(jq -n \
    --arg id "$agentId" \
    --arg port "$port" \
    --arg token "$token" \
    --arg stateDir "$state_dir" \
    '{
      AGENT_ID: $id,
      DATABASE_URL: "postgresql://localhost/agent_comms",
      WEBHOOK_PORT: $port
    } + (if $token != "" then {DISCORD_BOT_TOKEN: $token, DISCORD_STATE_DIR: $stateDir} else {} end)')

  # Update .mcp.json: agent-comms = stdio, remove channel-server and mcp-remote
  jq --arg bun "$BUN" \
     --arg server "$SERVER_PATH" \
     --argjson env "$env_json" \
     '
     .mcpServers["agent-comms"] = {
       "command": $bun,
       "args": ["run", $server],
       "env": $env
     }
     | del(.mcpServers["channel-server"])
     ' "$mcp_file" > "${mcp_file}.tmp" && mv "${mcp_file}.tmp" "$mcp_file"

  echo "RESTORED: $session — stdio + Discord (token: ${token:+yes}${token:-no})"
done < scripts/bot-registry.txt

echo "Done."
