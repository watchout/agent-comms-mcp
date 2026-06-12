/**
 * ADR-029R PR 5 — generate per-bot client config snippets for the Streamable
 * HTTP MCP daemon (identity binding mode).
 *
 * Prints, for one bot:
 *   - Codex CLI:    [mcp_servers.aun] url + bearer_token_env_var block
 *   - Claude Code:  .mcp.json mcpServers entry (type http + Authorization)
 *   - launchd-style env line for the token
 *
 * The token itself comes from scripts/issue-http-mcp-token.ts — this tool
 * only references the env var name, never the secret.
 *
 * Usage:
 *   bun scripts/generate-http-mcp-client-config.ts --agent-id <id> [--daemon-url http://127.0.0.1:8800]
 */

function parseArgs(argv: string[]): { agentId?: string; daemonUrl: string } {
  const out = { agentId: undefined as string | undefined, daemonUrl: 'http://127.0.0.1:8800' }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--agent-id') out.agentId = argv[++i]
    else if (argv[i] === '--daemon-url') out.daemonUrl = argv[++i]
  }
  return out
}

const { agentId, daemonUrl } = parseArgs(process.argv)
if (!agentId) {
  process.stderr.write('Usage: bun scripts/generate-http-mcp-client-config.ts --agent-id <id> [--daemon-url URL]\n')
  process.exit(2)
}

const envVar = `AUN_MCP_TOKEN_${agentId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`
const mcpUrl = `${daemonUrl.replace(/\/$/, '')}/mcp`

const codexToml = `# ~/.codex/config.toml — per-project or explicit -c override (NEVER a global
# identity; ADR-029R §5 forbids global identity defaults)
[mcp_servers.aun]
url = "${mcpUrl}"
bearer_token_env_var = "${envVar}"`

const claudeJson = JSON.stringify(
  {
    mcpServers: {
      aun: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: `Bearer \${${envVar}}` },
      },
    },
  },
  null,
  2,
)

process.stdout.write(JSON.stringify({
  agent_id: agentId,
  daemon_url: mcpUrl,
  token_env_var: envVar,
  token_issuance: `bun scripts/issue-http-mcp-token.ts --agent-id ${agentId}`,
  codex_config_toml: codexToml,
  claude_mcp_json: claudeJson,
  notes: [
    'Identity is derived from the bearer credential server-side (binding mode); no bot_id parameter, no AGENT_ID env.',
    'The plaintext token is issued once by issue-http-mcp-token.ts and must be injected via the env var above (launchd plist EnvironmentVariables or run script).',
    'stdio spawn entries for this bot should be REMOVED in the same change; emergency stdio fallback follows the runbook discipline (owner-stamped, time-boxed, logged).',
  ],
}, null, 2) + '\n')
