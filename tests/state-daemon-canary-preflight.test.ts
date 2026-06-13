import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db'
import { buildStateDaemonCanaryPreflightReport } from '../core/state-daemon-canary-preflight'

const EXPECTED_COMMIT = '193791749f855b6da1f130a1f180a1c1e3295349'

function plist(env: Record<string, string>): string {
  const envXml = Object.entries(env)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-comms.state-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/bun</string>
    <string>/tmp/current/bin/state-daemon.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/tmp/current</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`
}

async function withDb<T>(seedSql: string, fn: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-canary-preflight-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    seed.exec(seedSql)
    seed.close()
    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter)
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function runtimeCleanupReport(overrides: any = {}): any {
  return {
    ok: true,
    dry_run: true,
    generated_at: '2026-06-14T00:00:00.000Z',
    plan_hash: 'clean-plan',
    policy: {},
    options: {},
    summary: {
      targets: 1,
      cleanup_targets: 0,
      executable_actions: 0,
      unknown_risk_targets: 0,
      ...overrides.summary,
    },
    targets: overrides.targets ?? [],
    blockers: [],
  }
}

describe('state-daemon canary preflight', () => {
  test('returns GO for one qa allowlist, clean checkout, no target backlog, and startup-safety pass', async () => {
    await withDb(`
      INSERT INTO agents
        (agent_id, display_name, agent_type, runtime, status, metadata, channel_port, home_directory, runtime_engine_preference, profile_enabled)
      VALUES
        ('qa', 'QA', 'dev', 'TUI', 'idle', '{"tmux_session":"discord-qa","supervisor_type":"tmux"}', 8822, '/tmp/qa', 'codex', 1),
        ('audit', 'Audit', 'dev', 'TUI', 'idle', '{"tmux_session":"discord-audit","supervisor_type":"tmux"}', 8823, '/tmp/audit', 'codex', 1);

      INSERT INTO message_queue
        (agent_id, message_id, payload, status, created_at)
      VALUES
        ('audit', 'msg-audit', '{}', 'pending', '2026-06-13T23:59:00.000Z');
    `, async (db) => {
      const report = await buildStateDaemonCanaryPreflightReport(db, {
        targetAgentId: 'qa',
        expectedCommit: EXPECTED_COMMIT,
        requireSchedulerEnabled: true,
        now: new Date('2026-06-14T00:00:00.000Z'),
        plistText: plist({
          STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
          STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
          STATE_DAEMON_AGENT_DENYLIST: 'ceo,codex-test',
          STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
          STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
          STATE_DAEMON_RESTORE_COMMIT: EXPECTED_COMMIT,
        }),
        checkoutEvidence: {
          checkout_path: '/tmp/current',
          commit_sha: EXPECTED_COMMIT,
          dirty: false,
          status_short: '',
          source: 'git',
        },
        startupPortListeners: [],
        startupTmuxRuntimeEvidence: [],
        runtimeCleanupReport: runtimeCleanupReport(),
      })

      expect(report.ok).toBe(true)
      expect(report.go_no_go).toBe('GO')
      expect(report.policy.no_live_canary_insert).toBe(true)
      expect(report.state_daemon.scheduler_enabled).toBe(true)
      expect(report.state_daemon.agent_allowlist).toEqual(['qa'])
      expect(report.queue.target_active_count).toBe(0)
      expect(report.queue.non_target_active_count).toBe(1)
      expect(report.queue.rows[0]?.classification).toBe('pre_existing_excluded_backlog')
      expect(report.warnings.map((warning) => warning.code)).toContain('pre_existing_excluded_backlog_present')
      expect(report.blockers).toEqual([])
    })
  })

  test('returns NO_GO when target has active work and startup-safety sees a wrong port owner', async () => {
    await withDb(`
      INSERT INTO agents
        (agent_id, display_name, agent_type, runtime, status, metadata, channel_port, home_directory, runtime_engine_preference, profile_enabled)
      VALUES
        ('qa', 'QA', 'dev', 'TUI', 'idle', '{"tmux_session":"discord-qa","supervisor_type":"tmux"}', 8822, '/tmp/qa', 'codex', 1);

      INSERT INTO message_queue
        (agent_id, message_id, payload, status, created_at)
      VALUES
        ('qa', 'msg-qa', '{}', 'pending', '2026-06-14T00:00:00.000Z');
    `, async (db) => {
      const report = await buildStateDaemonCanaryPreflightReport(db, {
        targetAgentId: 'qa',
        expectedCommit: EXPECTED_COMMIT,
        requireSchedulerEnabled: true,
        now: new Date('2026-06-14T00:00:00.000Z'),
        plistText: plist({
          STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
          STATE_DAEMON_AGENT_ALLOWLIST: 'qa,audit',
          STATE_DAEMON_AGENT_DENYLIST: 'ceo,codex-test',
        }),
        checkoutEvidence: {
          checkout_path: '/tmp/current',
          commit_sha: '90bbde67d20321c57237574ba88435d1313fec1e',
          dirty: false,
          status_short: '',
          source: 'git',
        },
        startupPortListeners: [{
          pid: 123,
          port: 8822,
          observed_agent_id: 'codex-cto',
          orphan: false,
        }],
        startupTmuxRuntimeEvidence: [],
        runtimeCleanupReport: runtimeCleanupReport({
          summary: { cleanup_targets: 1, unknown_risk_targets: 1 },
          targets: [{
            target_id: 'agent:qa:stale-heartbeat',
            classification: 'unknown-risk',
            risk: 'unknown-risk',
            agent_id: 'qa',
            pid: 123,
            port: 8822,
            tmux_session: 'discord-qa',
            actions: [{ kind: 'noop', reason: 'listener_pid_does_not_match_runtime_pid' }],
          }],
        }),
      })

      expect(report.ok).toBe(false)
      expect(report.go_no_go).toBe('NO_GO')
      expect(report.queue.target_active_count).toBe(1)
      expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        'scheduler_not_enabled',
        'scheduler_allowlist_not_exact_target',
        'state_daemon_commit_mismatch',
        'startup_safety_port_owned_by_different_agent',
        'canary_target_has_active_queue_rows',
        'runtime_cleanup_unknown_risk_targets',
      ]))
    })
  })
})
