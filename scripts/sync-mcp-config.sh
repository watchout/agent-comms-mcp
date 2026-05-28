#!/usr/bin/env bash
# sync-mcp-config.sh — Export the DB bot profile into .mcp.json compatibility config
# Ensures AGENT_ID, AGENT_COM_EXPECTED_AGENT_ID, WEBHOOK_PORT,
# DISCORD_STATE_DIR, DATABASE_URL, and the agent-comms server path in each
# project's .mcp.json match the script-controlled runtime contract.
#
# Usage:
#   source sync-mcp-config.sh
#   sync_mcp_config <session> <project_dir> <agent_id> <port>
#
# - Overwrites only the agent-comms server path and runtime env keys
# - Preserves all other MCP servers and env vars (DISCORD_BOT_TOKEN, memory config, etc.)
# - Skips files without an agent-comms section
# - Requires: bun (for JSON manipulation) or python3/node as fallback

sync_mcp_config() {
  local session="$1" project_dir="$2" agent_id="$3" port="$4"
  local mcp_json="${project_dir}/.mcp.json"
  local state_dir="/Users/yuji/.claude/channels/${session}"
  local repo_root
  repo_root="$(cd "${SCRIPT_DIR}/.." && pwd)"
  local server_path="${AGENT_COMMS_SERVER_PATH:-${repo_root}/server.ts}"
  local database_url="${AGENT_COMMS_DATABASE_URL:-postgresql:///agent_comms?host=/tmp}"

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
    const oldExpected = env.AGENT_COM_EXPECTED_AGENT_ID;
    const oldPort = env.WEBHOOK_PORT;
    const oldState = env.DISCORD_STATE_DIR;
    const oldDb = env.DATABASE_URL;
    const oldArgs = Array.isArray(ac.args) ? ac.args.slice() : [];
    let changed = false;

    const desiredServer = '$server_path';
    if (!Array.isArray(ac.args) || ac.args.length === 0) {
      ac.args = ['run', desiredServer];
      changed = true;
    } else {
      const idx = ac.args.findIndex((value) => typeof value === 'string' && value.endsWith('/server.ts'));
      if (idx >= 0) {
        if (ac.args[idx] !== desiredServer) {
          ac.args[idx] = desiredServer;
          changed = true;
        }
      } else {
        ac.args = ['run', desiredServer];
        changed = true;
      }
    }

    if (env.AGENT_ID !== '$agent_id') { env.AGENT_ID = '$agent_id'; changed = true; }
    if (env.AGENT_COM_EXPECTED_AGENT_ID !== '$agent_id') { env.AGENT_COM_EXPECTED_AGENT_ID = '$agent_id'; changed = true; }
    if (env.WEBHOOK_PORT !== '$port') { env.WEBHOOK_PORT = '$port'; changed = true; }
    if (env.DISCORD_STATE_DIR !== '$state_dir') { env.DISCORD_STATE_DIR = '$state_dir'; changed = true; }
    if (env.DATABASE_URL !== '$database_url') { env.DATABASE_URL = '$database_url'; changed = true; }
    if (!changed) {
      console.error('[sync-mcp] ${session}: already in sync');
      process.exit(0);
    }
    ac.env = env;
    fs.writeFileSync('$mcp_json', JSON.stringify(cfg, null, 2) + '\n');
    const changes = [];
    if (JSON.stringify(oldArgs) !== JSON.stringify(ac.args)) changes.push('server: ' + oldArgs.join(' ') + ' → ' + ac.args.join(' '));
    if (oldId !== '$agent_id') changes.push('AGENT_ID: ' + oldId + ' → $agent_id');
    if (oldExpected !== '$agent_id') changes.push('EXPECTED: ' + (oldExpected||'(none)') + ' → $agent_id');
    if (oldPort !== '$port') changes.push('WEBHOOK_PORT: ' + oldPort + ' → $port');
    if (oldState !== '$state_dir') changes.push('STATE_DIR: ' + (oldState||'(none)') + ' → $state_dir');
    if (oldDb !== '$database_url') changes.push('DATABASE_URL: updated');
    console.error('[sync-mcp] ${session}: synced — ' + changes.join(', '));
  " 2>&1)

  echo "$updated" >&2
}
