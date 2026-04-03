#!/usr/bin/env bash
# sync-mcp-config.sh — Sync .mcp.json agent-comms env with bot-registry.txt
# Ensures AGENT_ID, WEBHOOK_PORT, DISCORD_STATE_DIR in each project's .mcp.json
# match the authoritative values in bot-registry.txt (SSOT).
#
# Usage:
#   source sync-mcp-config.sh
#   sync_mcp_config <session> <project_dir> <agent_id> <port>
#
# - Overwrites only AGENT_ID, WEBHOOK_PORT, DISCORD_STATE_DIR in the agent-comms section
# - Preserves all other MCP servers and env vars (DISCORD_BOT_TOKEN, DATABASE_URL, etc.)
# - Creates the agent-comms section if it doesn't exist
# - Requires: bun (for JSON manipulation) or python3/node as fallback

sync_mcp_config() {
  local session="$1" project_dir="$2" agent_id="$3" port="$4"
  local mcp_json="${project_dir}/.mcp.json"
  local state_dir="/Users/yuji/.claude/channels/${session}"

  if [ ! -f "$mcp_json" ]; then
    echo "[sync-mcp] ${session}: no .mcp.json at ${mcp_json}, skipping" >&2
    return 1
  fi

  # Use node (bundled with bun or system) to do precise JSON manipulation
  local updated
  updated=$(node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$mcp_json', 'utf8'));
    const ac = cfg.mcpServers?.['agent-comms'];
    if (!ac) {
      console.error('[sync-mcp] ${session}: no agent-comms section in .mcp.json, skipping');
      process.exit(1);
    }
    const env = ac.env || {};
    const oldId = env.AGENT_ID;
    const oldPort = env.WEBHOOK_PORT;
    const oldState = env.DISCORD_STATE_DIR;
    let changed = false;
    if (env.AGENT_ID !== '$agent_id') { env.AGENT_ID = '$agent_id'; changed = true; }
    if (env.WEBHOOK_PORT !== '$port') { env.WEBHOOK_PORT = '$port'; changed = true; }
    if (env.DISCORD_STATE_DIR !== '$state_dir') { env.DISCORD_STATE_DIR = '$state_dir'; changed = true; }
    if (!changed) {
      console.error('[sync-mcp] ${session}: already in sync');
      process.exit(0);
    }
    ac.env = env;
    fs.writeFileSync('$mcp_json', JSON.stringify(cfg, null, 2) + '\n');
    const changes = [];
    if (oldId !== '$agent_id') changes.push('AGENT_ID: ' + oldId + ' → $agent_id');
    if (oldPort !== '$port') changes.push('WEBHOOK_PORT: ' + oldPort + ' → $port');
    if (oldState !== '$state_dir') changes.push('STATE_DIR: ' + (oldState||'(none)') + ' → $state_dir');
    console.error('[sync-mcp] ${session}: synced — ' + changes.join(', '));
  " 2>&1)

  echo "$updated" >&2
}
