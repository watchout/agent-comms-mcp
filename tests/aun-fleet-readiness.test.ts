import { describe, expect, test } from 'bun:test'
import type { DbAdapter } from '../core/db'
import {
  buildAunFleetReadinessReport,
  formatAunFleetReadinessText,
} from '../core/aun-fleet-readiness'

const APPROVED_COMMIT = '540764dbc78bcd1bd9e12b11915f9b63d08de23b'
const OTHER_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function fakeDb(): DbAdapter {
  const query = async (sql: string) => {
    if (sql.includes('FROM agents')) {
      return [
        { agent_id: 'codex-aun', agent_type: 'dev', status: 'idle', runtime: 'TUI', metadata: { tmux_session: 'discord-aun' }, profile_enabled: true, disabled_at: null },
        { agent_id: 'ready-dev', agent_type: 'dev', status: 'idle', runtime: 'TUI', metadata: { tmux_session: 'discord-ready' }, profile_enabled: true, disabled_at: null },
        { agent_id: 'offline-dev', agent_type: 'dev', status: 'offline', runtime: 'TUI', metadata: { tmux_session: 'discord-offline' }, profile_enabled: true, disabled_at: null },
        { agent_id: 'missing-runtime', agent_type: 'dev', status: 'idle', runtime: 'TUI', metadata: {}, profile_enabled: true, disabled_at: null },
        { agent_id: 'test-bot', agent_type: 'dev', status: 'idle', runtime: 'TUI', metadata: { tmux_session: 'discord-test', profile_class: 'test' }, profile_enabled: true, disabled_at: null },
        { agent_id: 'disabled-bot', agent_type: 'dev', status: 'idle', runtime: 'TUI', metadata: { tmux_session: 'discord-disabled' }, profile_enabled: false, disabled_at: null },
      ]
    }
    if (sql.includes('FROM channels')) {
      return [
        { id: 'agent-com', name: 'agent-com', members: ['codex-aun', 'ready-dev', 'offline-dev', 'missing-runtime'] },
        { id: 'test', name: 'test', members: ['test-bot', 'disabled-bot'] },
      ]
    }
    if (sql.includes('FROM agent_runtime_instances')) return []
    if (sql.includes("status IN ('pending','received','in_progress')")) return []
    if (sql.includes('FROM message_queue') && sql.includes('payload LIKE')) {
      return [
        {
          id: 101,
          agent_id: 'ready-dev',
          status: 'done',
          payload: JSON.stringify({
            author_id: 'codex-aun',
            content: 'AUN send/receive smoke RUN1 for ready-dev. Please reply exactly: ACK-ready-dev-RUN1.',
          }),
        },
        {
          id: 102,
          agent_id: 'codex-aun',
          status: 'done',
          payload: JSON.stringify({
            author_id: 'ready-dev',
            content: 'ACK-ready-dev-RUN1',
          }),
        },
        {
          id: 201,
          agent_id: 'offline-dev',
          status: 'in_progress',
          payload: JSON.stringify({
            author_id: 'codex-aun',
            content: 'AUN send/receive smoke RUN1 for offline-dev. Please reply exactly: ACK-offline-dev-RUN1.',
          }),
        },
      ]
    }
    if (sql.includes('FROM agent_messages')) {
      return [
        { id: 'm1', author_id: 'ready-dev', content: 'ACK-ready-dev-RUN1' },
      ]
    }
    return []
  }
  return {
    query,
    queryOne: async () => null,
    execute: async () => ({ rowCount: 0 }),
    transaction: async (fn) => fn(fakeDb()),
    close: async () => {},
  }
}

describe('AUN fleet readiness', () => {
  test('classifies ready, activation candidate, and excluded agents from DB evidence', async () => {
    const report = await buildAunFleetReadinessReport(fakeDb(), {
      smokeRunId: 'RUN1',
      requireSmoke: true,
    })

    const byAgent = Object.fromEntries(report.agents.map((agent) => [agent.agent_id, agent]))
    expect(byAgent['ready-dev'].readiness).toBe('ready')
    expect(byAgent['ready-dev'].smoke?.passed).toBe(true)
    expect(byAgent['offline-dev'].readiness).toBe('activation_candidate')
    expect(byAgent['offline-dev'].blockers).toContain('inactive_status')
    expect(byAgent['offline-dev'].blockers).toContain('smoke_request_not_terminal')
    expect(byAgent['missing-runtime'].blockers).toContain('no_runtime_evidence')
    expect(byAgent['missing-runtime'].blockers).toContain('smoke_missing')
    expect(byAgent['test-bot'].readiness).toBe('excluded')
    expect(byAgent['test-bot'].blockers).toContain('test_profile_excluded')
    expect(byAgent['disabled-bot'].readiness).toBe('excluded')
    expect(byAgent['disabled-bot'].blockers).toContain('disabled_profile_excluded')
    expect(report.summary).toMatchObject({ agents: 6, ready: 2, excluded: 2 })
  })

  test('can explicitly include test profiles in readiness', async () => {
    const report = await buildAunFleetReadinessReport(fakeDb(), {
      smokeRunId: 'RUN1',
      requireSmoke: true,
      includeTestProfiles: true,
    })
    const testBot = report.agents.find((agent) => agent.agent_id === 'test-bot')
    expect(testBot?.readiness).toBe('activation_candidate')
    expect(testBot?.blockers).toContain('smoke_missing')
  })

  test('accepts NORM-060 terminal queue evidence without requiring ACK rows', async () => {
    const db = fakeDb()
    const originalQuery = db.query
    db.query = async (sql: string) => {
      if (sql.includes('FROM message_queue') && sql.includes('payload LIKE')) {
        return [{
          id: 301,
          agent_id: 'ready-dev',
          status: 'done',
          payload: JSON.stringify({
            smoke_run_id: 'norm060-RUN1',
            author_id: 'codex-aun',
            content: 'NORM-060 full-channel smoke norm060-RUN1 for agent-com. Synthetic probe: no reply is required.',
          }),
        }]
      }
      if (sql.includes('FROM agent_messages')) return []
      return originalQuery(sql)
    }

    const report = await buildAunFleetReadinessReport(db, {
      smokeRunId: 'norm060-RUN1',
      requireSmoke: true,
    })

    const ready = report.agents.find((agent) => agent.agent_id === 'ready-dev')
    expect(ready?.smoke).toMatchObject({
      ack_required: false,
      request_status: 'done',
      request_terminal: true,
      passed: true,
    })
    expect(ready?.blockers).not.toContain('smoke_ack_missing')
    expect(ready?.readiness).toBe('ready')
  })

  test('approved checkout gate blocks tmux-only, stale, unapproved, and dirty runtimes', async () => {
    const db = fakeDb()
    const originalQuery = db.query
    db.query = async (sql: string) => {
      if (sql.includes('FROM agent_runtime_instances')) {
        return [
          {
            runtime_instance_id: 'runtime-ready',
            agent_id: 'ready-dev',
            status: 'running',
            stopped_at: null,
            checkout_path: `/fleet/checkouts/${APPROVED_COMMIT}`,
            commit_sha: APPROVED_COMMIT,
            metadata: { git_dirty: false },
          },
          {
            runtime_instance_id: 'runtime-offline',
            agent_id: 'offline-dev',
            status: 'running',
            stopped_at: null,
            checkout_path: '/Users/yuji/Developer/agent-comms-mcp',
            commit_sha: OTHER_COMMIT,
            metadata: { git_dirty: true },
          },
        ]
      }
      return originalQuery(sql)
    }

    const report = await buildAunFleetReadinessReport(db, {
      approvedCommit: APPROVED_COMMIT,
      approvedCheckoutRoots: ['/fleet/checkouts'],
      requireSmoke: false,
    })

    const byAgent = Object.fromEntries(report.agents.map((agent) => [agent.agent_id, agent]))
    expect(byAgent['ready-dev'].readiness).toBe('ready')
    expect(byAgent['ready-dev'].checkout_drift.ok).toBe(true)
    expect(byAgent['codex-aun'].blockers).toContain('no_runtime_evidence')
    expect(byAgent['offline-dev'].blockers).toContain('runtime_commit_mismatch')
    expect(byAgent['offline-dev'].blockers).toContain('runtime_checkout_path_unapproved')
    expect(byAgent['offline-dev'].blockers).toContain('runtime_dirty_checkout')
    expect(report.blockers).toContain('offline-dev:runtime_dirty_checkout')
  })

  test('approved checkout gate rejects short commit prefix evidence', async () => {
    const db = fakeDb()
    const originalQuery = db.query
    db.query = async (sql: string) => {
      if (sql.includes('FROM agent_runtime_instances')) {
        return [
          {
            runtime_instance_id: 'runtime-ready',
            agent_id: 'ready-dev',
            status: 'running',
            stopped_at: null,
            checkout_path: `/fleet/checkouts/${APPROVED_COMMIT}`,
            commit_sha: APPROVED_COMMIT.slice(0, 3),
            metadata: { git_dirty: false },
          },
        ]
      }
      return originalQuery(sql)
    }

    const report = await buildAunFleetReadinessReport(db, {
      approvedCommit: APPROVED_COMMIT,
      approvedCheckoutRoots: ['/fleet/checkouts'],
      requireSmoke: false,
    })

    const ready = report.agents.find((agent) => agent.agent_id === 'ready-dev')
    expect(ready?.readiness).toBe('activation_candidate')
    expect(ready?.blockers).toContain('runtime_commit_mismatch')
    expect(ready?.checkout_drift.runtimes[0]?.commit_sha).toBe(APPROVED_COMMIT.slice(0, 3))
    expect(report.blockers).toContain('ready-dev:runtime_commit_mismatch')
  })

  test('bounded drift exclusion requires actor, reason, expiry, and scope', async () => {
    const report = await buildAunFleetReadinessReport(fakeDb(), {
      approvedCommit: APPROVED_COMMIT,
      approvedCheckoutRoots: ['/fleet/checkouts'],
      requireSmoke: false,
      now: new Date('2026-06-08T00:00:00.000Z'),
      driftExclusions: [
        {
          agent_id: 'codex-aun',
          actor: 'operator',
          reason: 'outside current activation scope',
          expires_at: '2026-06-09T00:00:00.000Z',
          scope: 'fleet_checkout_drift',
        },
        {
          agent_id: 'missing-runtime',
          actor: 'operator',
          reason: 'missing scope exclusion ignored',
          expires_at: '2026-06-09T00:00:00.000Z',
        },
        {
          agent_id: 'missing-runtime',
          actor: 'operator',
          reason: 'expired exclusion ignored',
          expires_at: '2026-06-07T00:00:00.000Z',
          scope: 'fleet_checkout_drift',
        },
      ],
    })

    const byAgent = Object.fromEntries(report.agents.map((agent) => [agent.agent_id, agent]))
    expect(byAgent['codex-aun'].readiness).toBe('excluded')
    expect(byAgent['codex-aun'].approved_exclusion).toMatchObject({
      actor: 'operator',
      reason: 'outside current activation scope',
      scope: 'fleet_checkout_drift',
    })
    expect(byAgent['codex-aun'].blockers).toContain('approved_fleet_exclusion')
    expect(byAgent['missing-runtime'].readiness).toBe('activation_candidate')
    expect(byAgent['missing-runtime'].approved_exclusion).toBeNull()
    expect(byAgent['missing-runtime'].blockers).toContain('no_runtime_evidence')
  })

  test('does not allow a drift exclusion to hide contradictory runtime evidence', async () => {
    const db = fakeDb()
    const originalQuery = db.query
    db.query = async (sql: string) => {
      if (sql.includes('FROM agent_runtime_instances')) {
        return [{
          runtime_instance_id: 'runtime-ready',
          agent_id: 'ready-dev',
          status: 'running',
          stopped_at: null,
          checkout_path: `/fleet/checkouts/${APPROVED_COMMIT}`,
          commit_sha: APPROVED_COMMIT,
          metadata: {
            git_checkout_path: '/different/runtime',
            git_commit_sha: OTHER_COMMIT,
            git_dirty: false,
          },
        }]
      }
      return originalQuery(sql)
    }

    const report = await buildAunFleetReadinessReport(db, {
      requireSmoke: false,
      now: new Date('2026-06-08T00:00:00.000Z'),
      driftExclusions: [{
        agent_id: 'ready-dev',
        actor: 'operator',
        reason: 'must not bypass contradictory identity',
        expires_at: '2026-06-09T00:00:00.000Z',
        scope: 'fleet_checkout_drift',
      }],
    })

    const ready = report.agents.find((agent) => agent.agent_id === 'ready-dev')
    expect(ready?.approved_exclusion).toBeNull()
    expect(ready?.readiness).toBe('activation_candidate')
    expect(ready?.blockers).toContain('runtime_checkout_evidence_mismatch')
    expect(report.blockers).toContain('ready-dev:runtime_checkout_evidence_mismatch')
  })

  test('formats a compact operator report', async () => {
    const report = await buildAunFleetReadinessReport(fakeDb(), {
      smokeRunId: 'RUN1',
    })
    const text = formatAunFleetReadinessText(report)

    expect(text).toContain('AUN Fleet Readiness')
    expect(text).toContain('READY')
    expect(text).toContain('ready-dev')
    expect(text).toContain('ACTIVATION CANDIDATE')
    expect(text).toContain('offline-dev')
  })
})
