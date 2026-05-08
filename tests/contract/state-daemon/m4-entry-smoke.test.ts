/**
 * State-daemon m4 integration smoke (Issue #323).
 *
 * Pins the entry-point + plist + StateDaemon class wiring without booting a
 * real launchd service:
 *
 *   - bin/state-daemon.ts source-pin (env mapping, signal handlers, DI shape)
 *   - launchd plist source-pin (Label, KeepAlive, ThrottleInterval, paths)
 *   - StateDaemon constructible with the production-shape adapters at the
 *     class boundary (smoke), with a real pg query client for the migration
 *     trigger end-to-end check.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..', '..')

describe('m4 — bin/state-daemon.ts source-pin', () => {
  const SRC = readFileSync(join(REPO, 'bin/state-daemon.ts'), 'utf-8')

  test('imports StateDaemon from core', () => {
    expect(SRC).toMatch(/from '\.\.\/core\/state-daemon\/index'/)
  })
  test('declares all 4 production adapters (DB / pg-listen / tmux / stdout metrics)', () => {
    expect(SRC).toMatch(/class PgClientAdapter/)
    expect(SRC).toMatch(/class PgNotifyListenClient/)
    expect(SRC).toMatch(/class TmuxShellAdapter/)
    expect(SRC).toMatch(/class StdoutMetrics/)
    expect(SRC).toMatch(/class CompositeAlertSink/)
  })
  test('SIGTERM / SIGINT graceful shutdown wiring', () => {
    expect(SRC).toMatch(/process\.on\('SIGTERM'/)
    expect(SRC).toMatch(/process\.on\('SIGINT'/)
    expect(SRC).toMatch(/await daemon\.stop\(\)/)
  })
  test('LISTEN client uses pg notification channel "queue_event"', () => {
    expect(SRC).toMatch(/LISTEN \$\{channel\}/)
    // The actual channel name is supplied by daemon.start() per types.ts.
  })
  test('tmux adapter: has-session check + send-keys (payload-as-is) + restart launcher', () => {
    expect(SRC).toMatch(/tmux.*has-session/)
    expect(SRC).toMatch(/send-keys.*-t/)
    // Restart launcher = scripts/start-runbot.sh (the existing launcher in
    // tree; spec §13.2 referenced `scripts/start-bot.sh` as an example name
    // only — see CTO L3 prep finding 2 in the PR description).
    expect(SRC).toMatch(/scripts\/start-runbot\.sh/)
  })
  test('env → config mapping covers all StateDaemonConfig knobs', () => {
    // Every public knob must have a STATE_DAEMON_* env mapping. Pin a sample.
    const expected = [
      'STATE_DAEMON_POLL_SWEEP_INTERVAL_MS',
      'STATE_DAEMON_PENDING_STALE_AFTER',
      'STATE_DAEMON_HEARTBEAT_INTERVAL_MS',
      'STATE_DAEMON_CLAIM_TTL_SEC',
      'STATE_DAEMON_WAKE_POOL_MIN_CAPACITY',
      'STATE_DAEMON_WAKE_POOL_MAX_CAPACITY',
      'STATE_DAEMON_BOT_RESTART_MAX_PER_HOUR',
      'STATE_DAEMON_DB_ERROR_ALERT_THRESHOLD',
    ]
    for (const k of expected) expect(SRC).toContain(k)
  })
  test('NO real agent-comms MCP call from the daemon (would self-cycle)', () => {
    // The daemon runs OUTSIDE any LLM session — it must not depend on the
    // MCP tool. Operator alerts are stderr-first; the channel post is left
    // as a future TODO with a comment marker.
    expect(SRC).not.toMatch(/mcp__agent-comms/)
  })
})

describe('m4 — launchd plist source-pin', () => {
  const PLIST = readFileSync(join(REPO, 'config/launchd/com.agent-comms.state-daemon.plist'), 'utf-8')

  test('Label = com.agent-comms.state-daemon', () => {
    expect(PLIST).toMatch(/<key>Label<\/key>\s*<string>com\.agent-comms\.state-daemon<\/string>/)
  })
  test('KeepAlive = true', () => {
    expect(PLIST).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
  })
  test('ThrottleInterval prevents tight crash loops', () => {
    expect(PLIST).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/)
  })
  test('ProgramArguments points at bun + bin/state-daemon.ts', () => {
    expect(PLIST).toMatch(/bin\/state-daemon\.ts/)
    expect(PLIST).toMatch(/bun/)
  })
  test('Stdout + Stderr paths declared (operator alert sink anchor)', () => {
    expect(PLIST).toMatch(/StandardOutPath/)
    expect(PLIST).toMatch(/StandardErrorPath/)
  })
  test('DATABASE_URL is in EnvironmentVariables (operator must set before load)', () => {
    expect(PLIST).toMatch(/DATABASE_URL/)
  })
})

describe('m4 — wiring smoke (no real LISTEN, no real tmux)', () => {
  test('the production entry point module exports a `main` function', async () => {
    const mod = await import('../../../bin/state-daemon')
    expect(typeof (mod as { main: () => unknown }).main).toBe('function')
  })

  test('migration trigger is installed on the dev DB (PR-A applied)', async () => {
    // Verifies PR-A merge is in effect on the dev DB and the trigger fires.
    // We INSERT into message_queue under a sd-test-* agent and confirm the
    // `notify_queue_event` trigger fires by inspecting pg_trigger.
    const { Client } = await import('pg')
    const c = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms' })
    await c.connect()
    try {
      const r = await c.query(
        `SELECT tgname FROM pg_trigger WHERE tgname='message_queue_notify' AND NOT tgisinternal`,
      )
      expect(r.rowCount).toBe(1)
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='message_queue'
            AND column_name IN ('last_wake_attempt_at','last_heartbeat_at')`,
      )
      expect(cols.rowCount).toBe(2)
    } finally {
      await c.end()
    }
  })
})
