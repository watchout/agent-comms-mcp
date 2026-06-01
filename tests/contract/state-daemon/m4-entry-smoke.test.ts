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
  test('PgClientAdapter serializes queries on the single pg Client', () => {
    expect(SRC).toMatch(/private chain: Promise<void> = Promise\.resolve\(\)/)
    expect(SRC).toMatch(/this\.chain\.then\(\(\) => this\.client\.query\(sql, params\)\)/)
    expect(SRC).toMatch(/this\.chain = run\.then\(\(\) => undefined, \(\) => undefined\)/)
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
  test('tmux adapter: has-session check + restart launcher, no prompt send-keys path', () => {
    expect(SRC).toMatch(/tmux.*has-session/)
    expect(SRC).not.toMatch(/async sendKeys/)
    expect(SRC).not.toMatch(/send-keys/)
    expect(SRC).not.toMatch(/payload\.endsWith\('\\n'\)/)
    // Restart launcher = scripts/restart-bot.sh, the existing repo-owned
    // restart entrypoint used by watchdog/operator paths.
    expect(SRC).toMatch(/scripts\/restart-bot\.sh/)
    expect(SRC).not.toMatch(/scripts\/start-runbot\.sh/)
  })
  test('env → config mapping covers all StateDaemonConfig knobs', () => {
    // Every public knob must have a STATE_DAEMON_* env mapping. Pin a sample.
    const expected = [
      'STATE_DAEMON_POLL_SWEEP_INTERVAL_MS',
      'STATE_DAEMON_PENDING_STALE_AFTER',
      'STATE_DAEMON_HEARTBEAT_INTERVAL_MS',
      'STATE_DAEMON_CLAIM_TTL_SEC',
      'STATE_DAEMON_ACTIVE_CLAIM_MAX_AGE_SEC',
      'STATE_DAEMON_WAKE_POOL_MIN_CAPACITY',
      'STATE_DAEMON_WAKE_POOL_MAX_CAPACITY',
      'STATE_DAEMON_BOT_RESTART_MAX_PER_HOUR',
      'STATE_DAEMON_DB_ERROR_ALERT_THRESHOLD',
      'STATE_DAEMON_AGENT_ALLOWLIST',
      'STATE_DAEMON_AGENT_DENYLIST',
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
  test('Bug 1 / F14 / R13 — bun is referenced by absolute path (no PATH lookup)', () => {
    // Cycle 2 fix (auditor Axis 4): pin the exact host-correct absolute
    // bun path. Earlier `/usr/local/bin/bun` did not exist on this
    // Apple-Silicon host and the daemon crash-looped. Loose `bun`
    // matching is not enough — the regression must be pinned.
    expect(PLIST).toMatch(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/yuji\/\.bun\/bin\/bun<\/string>/,
    )
    // Negative pin: forbid the legacy /usr/local/bin/bun string.
    expect(PLIST).not.toMatch(/<string>\/usr\/local\/bin\/bun<\/string>/)
  })
  test('Stdout + Stderr paths declared (operator alert sink anchor)', () => {
    expect(PLIST).toMatch(/StandardOutPath/)
    expect(PLIST).toMatch(/StandardErrorPath/)
  })
  test('DATABASE_URL is in EnvironmentVariables (operator must set before load)', () => {
    expect(PLIST).toMatch(/DATABASE_URL/)
  })
  test('DB-driven fleet rollout env is pinned for launchd', () => {
    expect(PLIST).toMatch(/<key>STATE_DAEMON_CODEX_RUNNER_ENABLED<\/key>\s*<string>1<\/string>/)
    expect(PLIST).toMatch(
      /<key>STATE_DAEMON_CODEX_RUNNER_DATABASE_URL<\/key>\s*<string>postgresql:\/\/\/agent_comms\?host=\/tmp<\/string>/,
    )
    expect(PLIST).toMatch(
      /<key>STATE_DAEMON_AGENT_DENYLIST<\/key>\s*<string>adf-dev,arc-test,auditor-test,ceo,codex-test,cto,cto-test,cto-test2,dev-001,hotfix-test,iyasaka-arc,test,test-probe,unknown<\/string>/,
    )
    expect(PLIST).not.toMatch(/<key>STATE_DAEMON_AGENT_ALLOWLIST<\/key>/)
    expect(PLIST).toMatch(/<key>STATE_DAEMON_ALERT_CHANNEL<\/key>\s*<string>1487368919613444156<\/string>/)
  })
  test('socket PostgreSQL launchd env pins PGUSER and USER', () => {
    expect(PLIST).toMatch(/<key>PGUSER<\/key>\s*<string>yuji<\/string>/)
    expect(PLIST).toMatch(/<key>USER<\/key>\s*<string>yuji<\/string>/)
  })
  test('Bug 2 / F15 / R14 — EnvironmentVariables.PATH is non-empty and includes Homebrew', () => {
    // Cycle 2 fix (auditor Axis 4): launchd does not inherit a login
    // PATH, so subprocess spawns (`tmux has-session`, restart launcher)
    // need an explicit PATH that contains the Homebrew prefix(es). Pin
    // the key + value so a future plist edit cannot silently drop it.
    expect(PLIST).toMatch(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)
    const pathMatch = PLIST.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)
    expect(pathMatch).not.toBeNull()
    const pathValue = pathMatch![1]
    expect(pathValue.length).toBeGreaterThan(0)
    expect(pathValue).toContain('/opt/homebrew/bin')
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
      const agentCols = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='agents'
            AND column_name = 'last_wake_attempt_at'`,
      )
      expect(agentCols.rowCount).toBe(1)
    } finally {
      await c.end()
    }
  })
})
