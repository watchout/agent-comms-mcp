/**
 * ADR-029R Spike A harness — real-client remote MCP connection evidence.
 *
 * Boots the real server.ts with the experimental Streamable HTTP endpoint
 * (bearer auth enforced) and connects REAL clients:
 *   1. Codex CLI  — native streamable HTTP config (url + bearer_token_env_var)
 *   2. Claude Code — http transport via --mcp-config (+ Authorization header)
 * Each client is asked to list MCP tools and call bot_status; stdout is
 * captured verbatim as evidence. Results print as JSON for the result doc.
 *
 * Run manually (costs two LLM calls):
 *   bun scripts/spike-029r-a-remote-mcp.ts
 *
 * SDK-level protocol coverage (initialize / tools / lifecycle / sessions) is
 * CI-tested in tests/contract/test_http_mcp_transport.test.ts.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Client as PgClient } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const HTTP_PORT = 39850
const WEBHOOK_PORT = 40850
const PREFIX = `sd-test-spikea-${process.pid}`
const BOT = `${PREFIX}-bot`
const AUTH_TOKEN = `spike-a-${randomUUID()}`
const MCP_URL = `http://127.0.0.1:${HTTP_PORT}/mcp?bot_id=${BOT}`

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server /health never became ready')
}

async function main(): Promise<void> {
  const pg = new PgClient({ connectionString: DATABASE_URL })
  await pg.connect()
  await pg.query(
    `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, last_seen_at, registered_at)
     VALUES ($1, 'default', $1, 'dev', 'TUI', 'idle', now(), now())
     ON CONFLICT (agent_id) DO UPDATE SET status='idle', last_seen_at=now()`,
    [BOT],
  )

  const server = spawn('bun', ['run', 'server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      AGENT_ID: `${PREFIX}-stdio`,
      AGENT_COM_EXPECTED_AGENT_ID: `${PREFIX}-stdio`,
      AGENT_COMMS_PORT: String(HTTP_PORT),
      WEBHOOK_PORT: String(WEBHOOK_PORT),
      AGENT_COMMS_EXPERIMENTAL_HTTP_MCP: '1',
      // PR 4: default identity mode is 'binding'; this harness predates
      // per-bot credentials, so it opts into the dev/test spike mode.
      AGENT_COMMS_HTTP_MCP_IDENTITY: 'spike-bot-id',
      AUTH_TOKEN,
      AUTH_SKIP_LOCALHOST: 'false',
      AGENT_COM_PG_NOTIFY: 'false',
      AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
      AGENT_COM_RUNTIME_HEARTBEAT_DISABLED: '1',
      DATABASE_URL,
      DISCORD_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const evidence: Record<string, unknown> = {
    spike: 'ADR-029R Spike A',
    mcp_url: MCP_URL,
    auth: 'bearer token, AUTH_SKIP_LOCALHOST=false (enforced)',
  }

  try {
    await waitForHealth()

    // ── 1. Codex CLI: native streamable HTTP (url + bearer_token_env_var) ──
    const codexPrompt =
      'You have an MCP server named "spikea". List the names of its tools (comma-separated, no commentary). Then call its bot_status tool with arguments {} and print the first 200 characters of the raw result.'
    const codex = spawnSync('codex', [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c', `mcp_servers.spikea.url="${MCP_URL}"`,
      '-c', 'mcp_servers.spikea.bearer_token_env_var="SPIKE_A_TOKEN"',
      codexPrompt,
    ], {
      encoding: 'utf-8',
      timeout: 180_000,
      env: { ...process.env, SPIKE_A_TOKEN: AUTH_TOKEN },
      maxBuffer: 1024 * 1024 * 8,
    })
    evidence.codex = {
      version: spawnSync('codex', ['--version'], { encoding: 'utf-8' }).stdout?.trim(),
      config: `[mcp_servers.spikea] url + bearer_token_env_var (no -c command/args; remote-native)`,
      exit_status: codex.status,
      stdout_tail: (codex.stdout ?? '').slice(-1500),
      stderr_tail: (codex.stderr ?? '').slice(-500),
    }

    // ── 2. Claude Code: http transport via --mcp-config ──
    const claudeCfg = JSON.stringify({
      mcpServers: {
        spikea: {
          type: 'http',
          url: MCP_URL,
          headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        },
      },
    })
    const claudePrompt =
      'You have an MCP server named "spikea". List the names of its tools (comma-separated, no commentary). Then call its bot_status tool with arguments {} and print the first 200 characters of the raw result.'
    const claude = spawnSync('claude', [
      '--print',
      '--mcp-config', claudeCfg,
      '--dangerously-skip-permissions',
      '--max-turns', '4',
      claudePrompt,
    ], {
      encoding: 'utf-8',
      timeout: 180_000,
      env: process.env,
      maxBuffer: 1024 * 1024 * 8,
    })
    evidence.claude = {
      version: spawnSync('claude', ['--version'], { encoding: 'utf-8' }).stdout?.trim(),
      config: `--mcp-config {type: http, url, headers.Authorization} (remote-native)`,
      exit_status: claude.status,
      stdout_tail: (claude.stdout ?? '').slice(-1500),
      stderr_tail: (claude.stderr ?? '').slice(-500),
    }

    // ── 3. Negative: bearer missing → 401 (auth actually enforced) ──
    const noAuth = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    })
    evidence.no_auth_request = { expected: 401, actual: noAuth.status }
  } finally {
    server.kill('SIGTERM')
    await pg.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.end()
  }

  console.log(JSON.stringify(evidence, null, 2))
}

void main()
