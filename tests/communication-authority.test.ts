import { describe, expect, test } from 'bun:test'
import {
  CHANNEL_COMMUNICATION_AUTHORITY,
  OUTBOUND_ALLOWLIST_COMPATIBILITY_STATUS,
  evaluateAutomaticProcessingEligibility,
  evaluateCommunicationAuthority,
} from '../core/communication-authority'
import { evaluateStateDaemonAutomaticProcessingEligibility } from '../core/state-daemon'

describe('Issue #917 Phase 1 communication authority', () => {
  test('F02 permits a member sender and member recipients', () => {
    expect(evaluateCommunicationAuthority({
      sender: 'aun',
      recipients: ['codex-audit', 'devauditor'],
      members: ['aun', 'codex-audit', 'devauditor'],
    })).toEqual({
      ok: true,
      authority: CHANNEL_COMMUNICATION_AUTHORITY,
      members: ['aun', 'codex-audit', 'devauditor'],
      violations: [],
      outbound_allowlist_status: OUTBOUND_ALLOWLIST_COMPATIBILITY_STATUS,
    })
  })

  test('F02 blocks every nonmember and reports channels.members as authority', () => {
    const verdict = evaluateCommunicationAuthority({
      sender: 'outside-sender',
      recipients: ['aun', 'outside-recipient'],
      members: ['aun'],
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.authority).toBe('channels.members')
    expect(verdict.violations).toEqual(['outside-sender', 'outside-recipient'])
  })

  test('F03 has no outbound_allowlist input and marks it non-authoritative', () => {
    const allowed = evaluateCommunicationAuthority({
      sender: 'aun',
      recipients: ['codex-audit'],
      members: ['aun', 'codex-audit'],
    })
    const blocked = evaluateCommunicationAuthority({
      sender: 'aun',
      recipients: ['codex-audit'],
      members: ['aun'],
    })
    expect(allowed.outbound_allowlist_status).toBe('DEPRECATED_NON_AUTHORITATIVE')
    expect(blocked.outbound_allowlist_status).toBe('DEPRECATED_NON_AUTHORITATIVE')
    expect(Object.keys(allowed)).not.toContain('outbound_allowlist')
  })
})

describe('Issue #917 Phase 1 automatic-processing eligibility', () => {
  test('F04 passes only when every DB-derived conjunct passes', () => {
    expect(evaluateAutomaticProcessingEligibility({
      enrolled: true,
      enabled: true,
      runtimeReady: true,
      channelMember: true,
      humanAgent: false,
    })).toEqual({
      ok: true,
      authority: 'db.agent_runtime_and_channels.members',
      reasons: [],
      host_allowlist_required: false,
    })
  })

  test.each([
    ['AGENT_NOT_ENROLLED', { enrolled: false }],
    ['AGENT_NOT_ENABLED', { enabled: false }],
    ['RUNTIME_NOT_READY', { runtimeReady: false }],
    ['AGENT_NOT_CHANNEL_MEMBER', { channelMember: false }],
    ['AGENT_TYPE_HUMAN', { humanAgent: true }],
  ] as const)('F04 blocks %s without requiring a host allowlist', (reason, patch) => {
    const verdict = evaluateAutomaticProcessingEligibility({
      enrolled: true,
      enabled: true,
      runtimeReady: true,
      channelMember: true,
      humanAgent: false,
      ...patch,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toContain(reason)
    expect(verdict.host_allowlist_required).toBe(false)
  })

  test('F04 state-daemon adapter accepts SQLite boolean 1, reads channels.members, and needs no host allowlist', async () => {
    const queries: string[] = []
    const db = {
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.includes('FROM agents')) {
          return {
            rows: [{
              agent_id: 'aun',
              runtime: 'codex-exec',
              runtime_engine_preference: null,
              status: 'online',
              profile_enabled: 1,
              disabled_at: null,
            }],
            rowCount: 1,
          }
        }
        return { rows: [{ members: '["aun","codex-audit"]' }], rowCount: 1 }
      },
    }

    const verdict = await evaluateStateDaemonAutomaticProcessingEligibility(db as any, {
      agentId: 'aun',
      channelId: 'channel-a',
      humanAgent: false,
    })

    expect(verdict).toMatchObject({ ok: true, host_allowlist_required: false, reasons: [] })
    expect(queries.some((sql) => sql.includes('FROM agents'))).toBe(true)
    expect(queries.some((sql) => sql.includes('FROM channels'))).toBe(true)
  })

  test('F04 state-daemon adapter blocks a DB-enrolled runtime when channels.members omits it', async () => {
    const db = {
      query: async (sql: string) => sql.includes('FROM agents')
        ? { rows: [{ agent_id: 'aun', runtime: 'codex-exec', status: 'online', profile_enabled: true, disabled_at: null }] }
        : { rows: [{ members: ['codex-audit'] }] },
    }
    const verdict = await evaluateStateDaemonAutomaticProcessingEligibility(db as any, {
      agentId: 'aun',
      channelId: 'channel-a',
      humanAgent: false,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toEqual(['AGENT_NOT_CHANNEL_MEMBER'])
  })

  test('F04 state-daemon adapter treats a whitespace-only runtime as not ready', async () => {
    const db = {
      query: async (sql: string) => sql.includes('FROM agents')
        ? { rows: [{ agent_id: 'aun', runtime: '   ', status: 'online', profile_enabled: true, disabled_at: null }] }
        : { rows: [{ members: ['aun'] }] },
    }
    const verdict = await evaluateStateDaemonAutomaticProcessingEligibility(db as any, {
      agentId: 'aun',
      channelId: 'channel-a',
      humanAgent: false,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toEqual(['RUNTIME_NOT_READY'])
  })

  test('F04 state-daemon adapter fails closed when runtime status is missing', async () => {
    const db = {
      query: async (sql: string) => sql.includes('FROM agents')
        ? { rows: [{ agent_id: 'aun', runtime: 'codex-exec', status: null, profile_enabled: true, disabled_at: null }] }
        : { rows: [{ members: ['aun'] }] },
    }
    const verdict = await evaluateStateDaemonAutomaticProcessingEligibility(db as any, {
      agentId: 'aun',
      channelId: 'channel-a',
      humanAgent: false,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.reasons).toEqual(['RUNTIME_NOT_READY'])
  })
})
