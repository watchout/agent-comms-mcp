import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf-8')
}

describe('Codex MCP integration — current CLI contract source pins', () => {
  test('Codex repo instructions require native agent-comms send/notify, not Discord echo', () => {
    const src = read('AGENTS.md')
    expect(src).toContain('Discord is downstream display only')
    expect(src).toContain('AGENT_COM_DISCORD_BOT_BRIDGE_IDS')
    expect(src).toContain("source='discord-bot-bridge'")
    expect(src).toContain('mcp__agent-comms__next')
    expect(src).toContain('mcp__agent-comms__send')
    expect(src).toContain('mcp__agent-comms__notify')
    expect(src).toContain('mcp__agent-comms__processing')
    expect(src).toContain('mcp__agent-comms__done')
    expect(src).toContain('Use `reply_to: <message_id>`')
    expect(src).toContain('Use `mention: <from>`')
    expect(src).toContain('Do not use `mentions`')
    expect(src).toContain('agent_messages.source')
    expect(src).toContain('message_queue')
  })

  test('operation doc records the 2026-05-14 Discord echo filter impact', () => {
    const src = read('docs/operations/codex-native-agent-comms.md')
    expect(src).toContain('2026-05-14 bot-authored Discord echo filter')
    expect(src).toContain('Codex traffic must therefore use the native')
    expect(src).toContain('agent_messages.source')
    expect(src).toContain('message_queue')
    expect(src).toContain('8-value union')
    expect(src).toContain('pending`, `read`, `received`, `in_progress`, `done`, `replied`, `skipped`')
    expect(src).toContain('Optional Discord Bot Bridge')
    expect(src).toContain('AGENT_COM_DISCORD_BOT_BRIDGE_IDS')
    expect(src).toContain("source='discord-bot-bridge'")
    expect(src).toContain('"mention": "<sender agent_id>"')
    expect(src).not.toContain('"mentions"')
  })

  test('runtime adapter architecture doc defines DB-native control plane + bridge invariants', () => {
    const src = read('docs/design/runtime-adapter-architecture.md')
    expect(src).toContain('DB is the SSOT')
    expect(src).toContain('Discord outbound echo is not a delivery source')
    expect(src).toContain('AGENT_COM_DISCORD_BOT_BRIDGE_IDS')
    expect(src).toContain("source='discord-bot-bridge'")
    expect(src).toContain('Claude Code')
    expect(src).toContain('Codex CLI')
    expect(src).toContain('8-value')
  })

  test('server gates bot-authored Discord ingress through the explicit bridge policy', () => {
    const src = read('server.ts')
    expect(src).toContain('decideDiscordBotIngress(msg)')
    expect(src).toContain('discord inbound bot echo blocked')
    expect(src).toContain('source: botIngress.source')
  })

  test('inbound receiver can persist bridge ingress with source override', () => {
    const src = read('adapters/inbound-receiver.ts')
    expect(src).toContain('source?: string')
    expect(src).toContain('const source = params.source ?? platform')
    expect(src).toMatch(/source,\s*\n\s*thread_id/)
  })

  test('README uses the current Codex config table and registry command', () => {
    const src = read('README.md')
    expect(src).toContain('codex mcp add agent-comms')
    expect(src).toContain('[mcp_servers.agent-comms]')
    expect(src).toContain('args = ["run", "--cwd", "/path/to/agent-comms-mcp", "server.ts"]')
    expect(src).toContain('Codex must use the agent-comms native MCP tools')
    expect(src).toContain('Discord is a')
    expect(src).not.toContain('[mcp.agent-comms]')
    expect(src).not.toContain('[mcp.agent-comms.env]')
  })

  test('install script registers via `codex mcp add` with bun --cwd server.ts', () => {
    const src = read('scripts/install-codex-mcp.sh')
    expect(src).toContain('codex mcp add "$NAME"')
    expect(src).toContain('--env "AGENT_ID=$AGENT_ID"')
    expect(src).toContain('--env "DATABASE_URL=$DATABASE_URL"')
    expect(src).toContain('--env "WEBHOOK_PORT=$WEBHOOK_PORT"')
    expect(src).toContain('-- bun run --cwd "$REPO_DIR" server.ts')
    expect(src).toContain('codex mcp remove "$NAME"')
  })

  test('Codex runner wraps run-bot with current `codex exec` flags', () => {
    const src = read('scripts/run-codex-bot.sh')
    expect(src).toContain('run-bot.sh')
    expect(src).toContain('codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral')
    expect(src).toContain('LLM_TIMEOUT_SECONDS="${LLM_TIMEOUT_SECONDS:-180}"')
    expect(src).toContain('never rely on Discord bot echo')
  })

  test('Codex run-bot command uses current `codex exec` non-interactive flags', () => {
    const migrate = read('scripts/migrate-bot.sh')
    const runbot = read('scripts/run-bot.sh')
    const spec = read('docs/agent-com-message-queue-spec.md')
    const expected = 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral'

    expect(migrate).toContain(`LLM_CMD="${expected}"`)
    expect(runbot).toContain(`LLM_CMD="${expected}"`)
    expect(spec).toContain(expected)
    expect(migrate).not.toContain('codex --quiet')
    expect(runbot).not.toContain('codex --quiet')
    expect(spec).not.toContain('codex --quiet')
  })
})
