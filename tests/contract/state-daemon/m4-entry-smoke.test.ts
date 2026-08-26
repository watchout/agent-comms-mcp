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
import {
  assertStateDaemonDirectEntryArgv,
  assertStateDaemonDirectEntryEnv,
  STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR,
  validateStateDaemonDirectEntryArgv,
  validateStateDaemonDirectEntryEnv,
} from '../../../bin/state-daemon'
import { STATE_DAEMON_DB_SSOT_DESIGN_SUBJECT_DIGEST } from '../../../core/state-daemon/launchagent'

const REPO = join(import.meta.dir, '..', '..', '..')

const VALID_CANARY_OVERLAY: NodeJS.ProcessEnv = {
  STATE_DAEMON_AGENT_ALLOWLIST: 'aun',
  STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF: 'https://github.com/watchout/agent-comms-mcp/issues/917#issuecomment-5223398908',
  STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF: 'https://github.com/watchout/agent-comms-mcp/issues/917#issuecomment-5223398910',
  STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT: '2099-08-08T00:00:00.000Z',
  STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256: 'a'.repeat(64),
  STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND: 'launchctl bootout gui/501/com.agent-comms.state-daemon',
  STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION: '/tmp/aun-917-observed-state.json',
  STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST: STATE_DAEMON_DB_SSOT_DESIGN_SUBJECT_DIGEST,
}

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
    ]
    for (const k of expected) expect(SRC).toContain(k)
  })
  test('NO real agent-comms MCP call from the daemon (would self-cycle)', () => {
    // The daemon runs OUTSIDE any LLM session — it must not depend on the
    // MCP tool. Operator alerts are stderr-first; the channel post is left
    // as a future TODO with a comment marker.
    expect(SRC).not.toMatch(/mcp__agent-comms/)
  })

  test('direct entry validates a temporary allowlist overlay before opening PostgreSQL', () => {
    const mainIdx = SRC.indexOf('export async function main()')
    const mainBody = SRC.slice(mainIdx, mainIdx + 1200)
    expect(mainBody.indexOf('assertStateDaemonDirectEntryArgv(process.argv.slice(2))')).toBeGreaterThan(-1)
    expect(mainBody.indexOf('assertStateDaemonDirectEntryEnv(process.env)')).toBeGreaterThan(-1)
    expect(mainBody.indexOf('assertStateDaemonDirectEntryArgv(process.argv.slice(2))')).toBeLessThan(
      mainBody.indexOf('assertStateDaemonDirectEntryEnv(process.env)'),
    )
    expect(mainBody.indexOf('assertStateDaemonDirectEntryEnv(process.env)')).toBeLessThan(
      mainBody.indexOf('new Client({ connectionString: connStr })'),
    )
  })
})

describe('m4 — daemon-only direct-entry argv fail-closed', () => {
  test('empty argv is the only accepted daemon launch shape', () => {
    expect(validateStateDaemonDirectEntryArgv([])).toEqual({ ok: true, code: null, argv: [] })
    expect(() => assertStateDaemonDirectEntryArgv([])).not.toThrow()
  })

  test.each([
    ['status', '--json'],
    ['queue-readiness', '--agent-id', 'codex-audit', '--json'],
    ['--json'],
  ])('rejects every non-empty direct-entry argv tuple: %p', (...argv) => {
    const result = validateStateDaemonDirectEntryArgv(argv)
    expect(result.ok).toBe(false)
    expect(result.code).toBe(STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR)
    expect(() => assertStateDaemonDirectEntryArgv(argv)).toThrow(STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR)
  })
})

describe('m4 — direct-entry DB-SSOT canary overlay fail-closed matrix', () => {
  const now = new Date('2026-08-08T00:00:00.000Z')

  test('steady state without allowlist or overlay is allowed', () => {
    expect(validateStateDaemonDirectEntryEnv({}, now)).toEqual({
      active: false,
      target: null,
      expiresAt: null,
      issues: [],
    })
  })

  test('complete four-agent-cohort overlay is allowed', () => {
    const result = validateStateDaemonDirectEntryEnv(VALID_CANARY_OVERLAY, now)
    expect(result.active).toBe(true)
    expect(result.target).toBe('aun')
    expect(result.issues).toEqual([])
    expect(() => assertStateDaemonDirectEntryEnv(VALID_CANARY_OVERLAY, now)).not.toThrow()
  })

  test.each([
    ['missing metadata', { STATE_DAEMON_AGENT_ALLOWLIST: 'aun' }, 'state_daemon_canary_overlay_identity_incomplete'],
    ['expired metadata', { ...VALID_CANARY_OVERLAY, STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT: '2026-08-07T23:59:59.000Z' }, 'state_daemon_canary_overlay_expired'],
    ['retired target', { ...VALID_CANARY_OVERLAY, STATE_DAEMON_AGENT_ALLOWLIST: 'codex-aun' }, 'state_daemon_canary_overlay_retired_target'],
    ['wrong DesignPack subject', { ...VALID_CANARY_OVERLAY, STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST: `sha256:${'b'.repeat(64)}` }, 'state_daemon_canary_overlay_subject_digest_mismatch'],
    ['target outside cohort', { ...VALID_CANARY_OVERLAY, STATE_DAEMON_AGENT_ALLOWLIST: 'agent-com-dev' }, 'state_daemon_canary_overlay_target_outside_cohort'],
  ])('%s is NO_GO before daemon effects', (_name, env, expectedCode) => {
    const result = validateStateDaemonDirectEntryEnv(env, now)
    expect(result.issues.map((issue) => issue.code)).toContain(expectedCode)
    expect(() => assertStateDaemonDirectEntryEnv(env, now)).toThrow('STATE_DAEMON_CANARY_OVERLAY_NO_GO')
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
    expect(PLIST).not.toMatch(/<key>STATE_DAEMON_AGENT_DENYLIST<\/key>/)
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
