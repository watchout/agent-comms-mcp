import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  buildRuntimeInventoryReport,
  formatRuntimeInventoryText,
  generateAllAgentCommunicationManifestCandidates,
} from '../core/runtime-inventory'
import { allAgentCommunicationTargetSha256 } from '../core/all-agent-communication-manifest'

const APPROVED_COMMIT = '540764dbc78bcd1bd9e12b11915f9b63d08de23b'
const OTHER_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

async function withRuntimeDb<T>(fn: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-runtime-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    seed.exec(`
      INSERT INTO agents (agent_id, display_name, agent_type, cli_type, status)
      VALUES
        ('hotel-dev', 'Hotel Dev', 'dev', 'TUI', 'idle'),
        ('stale-dev', 'Stale Dev', 'dev', 'TUI', 'idle'),
        ('gap-dev', 'Gap Dev', 'dev', 'TUI', 'idle');

      INSERT INTO channels (id, name, type, members)
      VALUES
        ('hotel-channel', 'hotel-kanri', 'channel', '["hotel-dev"]'),
        ('bidirectional-channel', 'bidirectional-gap', 'channel', '["hotel-dev"]'),
        ('role-gap-channel', 'role-gap', 'channel', '["hotel-dev"]'),
        ('wrong-owner-channel', 'wrong-owner', 'channel', '["hotel-dev", "stale-dev"]'),
        ('gap-channel', 'gap', 'channel', '["gap-dev"]');

      INSERT INTO channel_routing_policy (channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist)
      VALUES
        ('hotel-channel', 'hotel-dev', 'hotel-dev', '["hotel-dev"]'),
        ('bidirectional-channel', 'hotel-dev', 'hotel-dev', '["hotel-dev"]'),
        ('role-gap-channel', 'hotel-dev', 'hotel-dev', '["hotel-dev"]'),
        ('wrong-owner-channel', 'hotel-dev', 'hotel-dev', '["hotel-dev", "stale-dev"]'),
        ('gap-channel', 'gap-dev', 'gap-dev', '["gap-dev"]');

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id, checkout_path, commit_sha, status, last_seen_at, metadata)
      VALUES
        ('runtime-hotel', 'hotel-dev', 'codex', 'local_process', 'discord-hotel', 101, '/tmp/hotel', '${APPROVED_COMMIT}', 'active', datetime('now'), '{"git_dirty":false}'),
        ('runtime-stale', 'stale-dev', 'codex', 'local_process', 'discord-stale', 202, '/tmp/stale', '${OTHER_COMMIT}', 'active', '2020-01-01T00:00:00Z', '{"git_dirty":true}');

      INSERT INTO connector_instances
        (connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri, status, trust_status)
      VALUES
        ('connector-hotel', 'hotel-dev', 'runtime-hotel', 'discord', 'discord://agents/hotel-dev', 'active', 'local'),
        ('connector-stale', 'stale-dev', 'runtime-stale', 'discord', 'discord://agents/stale-dev', 'active', 'local');

      INSERT INTO channel_connector_bindings
        (channel_binding_id, channel_id, provider, connector_instance_id, binding_role, status)
      VALUES
        ('binding-hotel', 'hotel-channel', 'discord', 'connector-hotel', 'outbound', 'active'),
        ('binding-bidirectional-gap', 'bidirectional-channel', 'discord', 'connector-hotel', 'bidirectional', 'active'),
        ('binding-role-gap', 'role-gap-channel', 'discord', 'connector-hotel', 'inbound', 'active'),
        ('binding-wrong-owner', 'wrong-owner-channel', 'discord', 'connector-stale', 'outbound', 'active');
    `)
    seed.close()

    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter)
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('runtime inventory', () => {
  test('reports runtime freshness, connector linkage, and policy projection gaps', async () => {
    await withRuntimeDb(async (db) => {
      const report = await buildRuntimeInventoryReport(db, {
        staleMinutes: 60,
        expectedCommit: APPROVED_COMMIT,
      })

      const hotel = report.agents.find((agent) => agent.agent_id === 'hotel-dev')
      const stale = report.agents.find((agent) => agent.agent_id === 'stale-dev')
      const hotelConnector = report.connectors.find((connector) => connector.agent_id === 'hotel-dev')

      expect(report.policy.db_is_source_of_truth).toBe(true)
      expect(hotel?.freshness).toBe('fresh')
      expect(hotel?.warnings).not.toContain('runtime_commit_mismatch')
      expect(stale?.freshness).toBe('stale')
      expect(stale?.warnings).toContain('runtime_stale')
      expect(stale?.warnings).toContain('runtime_commit_mismatch')
      expect(stale?.warnings).toContain('runtime_dirty_checkout')
      expect(hotelConnector?.active_binding_count).toBe(3)
      expect(report.policy_gaps).toEqual([
        {
          channel_id: 'bidirectional-channel',
          channel_name: 'bidirectional-gap',
          adapter_owner_agent_id: 'hotel-dev',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'missing_active_binding',
          active_binding_agents: [],
        },
        {
          channel_id: 'gap-channel',
          channel_name: 'gap',
          adapter_owner_agent_id: 'gap-dev',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'missing_active_binding',
          active_binding_agents: [],
        },
        {
          channel_id: 'role-gap-channel',
          channel_name: 'role-gap',
          adapter_owner_agent_id: 'hotel-dev',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'missing_active_binding',
          active_binding_agents: [],
        },
        {
          channel_id: 'wrong-owner-channel',
          channel_name: 'wrong-owner',
          adapter_owner_agent_id: 'hotel-dev',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'active_binding_wrong_owner',
          active_binding_agents: ['stale-dev'],
        },
      ])
      expect(report.blockers).toContain('stale-dev:runtime_stale')
      expect(report.blockers).toContain('stale-dev:runtime_dirty_checkout')
      expect(report.blockers).toContain('bidirectional-channel:missing_active_binding')
      expect(report.blockers).toContain('gap-channel:missing_active_binding')
      expect(report.blockers).toContain('role-gap-channel:missing_active_binding')
      expect(report.blockers).toContain('wrong-owner-channel:active_binding_wrong_owner')
      expect(formatRuntimeInventoryText(report)).toContain('Runtime Inventory')
    })
  })

  test('policy gaps are scoped to the requested binding role', async () => {
    await withRuntimeDb(async (db) => {
      const report = await buildRuntimeInventoryReport(db, {
        staleMinutes: 60,
        bindingRole: 'inbound',
      })

      expect(report.options.binding_role).toBe('inbound')
      expect(report.policy_gaps.map((gap) => gap.channel_id)).not.toContain('role-gap-channel')
      expect(report.policy_gaps).toContainEqual({
        channel_id: 'hotel-channel',
        channel_name: 'hotel-kanri',
        adapter_owner_agent_id: 'hotel-dev',
        provider: 'discord',
        binding_role: 'inbound',
        reason: 'missing_active_binding',
        active_binding_agents: [],
      })
    })
  })

  test('approved checkout roots produce fail-closed runtime path blockers', async () => {
    await withRuntimeDb(async (db) => {
      const report = await buildRuntimeInventoryReport(db, {
        staleMinutes: 60,
        expectedCommit: APPROVED_COMMIT,
        approvedCheckoutRoots: ['/approved/fleet/checkouts'],
      })

      const hotel = report.agents.find((agent) => agent.agent_id === 'hotel-dev')
      expect(hotel?.warnings).toContain('runtime_checkout_path_unapproved')
      expect(hotel?.checkout_drift.approved_checkout_roots).toEqual(['/approved/fleet/checkouts'])
      expect(report.blockers).toContain('hotel-dev:runtime_checkout_path_unapproved')
    })
  })

  test('approved commit evidence requires a full SHA match', async () => {
    await withRuntimeDb(async (db) => {
      await db.execute(`UPDATE agent_runtime_instances SET commit_sha = '${APPROVED_COMMIT.slice(0, 3)}' WHERE runtime_instance_id = 'runtime-hotel'`)

      const report = await buildRuntimeInventoryReport(db, {
        staleMinutes: 60,
        expectedCommit: APPROVED_COMMIT,
      })

      const hotel = report.agents.find((agent) => agent.agent_id === 'hotel-dev')
      const hotelConnector = report.connectors.find((connector) => connector.agent_id === 'hotel-dev')
      expect(hotel?.warnings).toContain('runtime_commit_mismatch')
      expect(hotel?.checkout_drift.reasons).toContain('runtime_commit_mismatch')
      expect(hotelConnector?.warnings).toContain('connector_runtime_commit_mismatch')
      expect(report.blockers).toContain('hotel-dev:runtime_commit_mismatch')
    })
  })
})

describe('ordinary all-agent manifest candidate inventory', () => {
  function fakeManifestDb(
    includeUnresolvedNewSeat = false,
    liveRuntimeEngine = 'codex',
    includeProductionNameCollisionSeat = false,
    includeUnclassifiedSeat = false,
  ) {
    const now = '2026-07-26T00:00:00Z'
    return {
      async query(sql: string, params: unknown[] = []) {
        const agentId = String(params[0] ?? '')
        if (/FROM agents/.test(sql)) return [
          {
            agent_id: 'dev-001', agent_type: 'dev', profile_revision: 7, profile_enabled: true,
            disabled_at: null, runtime_engine_preference: 'codex', metadata: { profile_class: 'production' },
          },
          ...(includeUnresolvedNewSeat ? [{
            agent_id: 'new-dev', agent_type: 'dev', profile_revision: 1, profile_enabled: true,
            disabled_at: null, runtime_engine_preference: 'codex', metadata: { profile_class: 'production' },
          }] : []),
          ...(includeProductionNameCollisionSeat ? [{
            agent_id: 'contest-dev', agent_type: 'dev', profile_revision: 3, profile_enabled: true,
            disabled_at: null, runtime_engine_preference: 'codex', metadata: { profile_class: 'production' },
          }] : []),
          ...(includeUnclassifiedSeat ? [{
            agent_id: 'test-looking-dev', agent_type: 'dev', profile_revision: 1, profile_enabled: true,
            disabled_at: null, runtime_engine_preference: 'codex', metadata: {},
          }] : []),
          { agent_id: 'test-agent', agent_type: 'dev', profile_revision: 1, profile_enabled: true, disabled_at: null, runtime_engine_preference: 'codex', metadata: { profile_class: 'test' } },
        ]
        if (/FROM channels c/.test(sql)) return []
        if (/FROM agent_workspace_bindings/.test(sql)) {
          if (agentId === 'dev-001') {
            return [{ workspace_id: 'workspace-dev-001', local_path: '/work/dev-001', repo_url: 'https://github.com/watchout/agent-comms-mcp.git' }]
          }
          if (includeProductionNameCollisionSeat && agentId === 'contest-dev') {
            return [{ workspace_id: 'workspace-contest-dev', local_path: '/work/contest-dev', repo_url: 'https://github.com/watchout/contest.git' }]
          }
          return []
        }
        if (/FROM agent_runtime_instances/.test(sql)) {
          if (agentId === 'dev-001') {
            return [{ runtime_instance_id: 'runtime-1', workspace_id: 'workspace-dev-001', runtime_engine: liveRuntimeEngine, status: 'active', stopped_at: null, last_seen_at: now }]
          }
          if (includeProductionNameCollisionSeat && agentId === 'contest-dev') {
            return [{ runtime_instance_id: 'runtime-contest', workspace_id: 'workspace-contest-dev', runtime_engine: 'codex', status: 'active', stopped_at: null, last_seen_at: now }]
          }
          return []
        }
        if (/FROM agent_provider_identities/.test(sql)) {
          if (agentId === 'dev-001') return [{ provider_identity_id: 'identity-1' }]
          if (includeProductionNameCollisionSeat && agentId === 'contest-dev') return [{ provider_identity_id: 'identity-contest' }]
          return []
        }
        if (/FROM agent_ui_bindings/.test(sql)) {
          if (agentId === 'dev-001') return [{ binding_id: 'binding-1' }]
          if (includeProductionNameCollisionSeat && agentId === 'contest-dev') return [{ binding_id: 'binding-contest' }]
          return []
        }
        return []
      },
    } as any
  }

  function candidateOptions() {
    return {
      nowMs: Date.parse('2026-07-26T00:01:00Z'),
      controlSourceByAgent: { 'dev-001': 'https://github.com/watchout/agent-comms-mcp/issues/887' },
      activeFunctionByAgent: { 'dev-001': 'implementation_executor' },
      communicationAutoReceiveByAgent: { 'dev-001': true },
      protectedD1ByAgent: { 'dev-001': false },
      discordModeByAgent: { 'dev-001': 'native_verified' as const },
    }
  }

  test('resolves one exact workspace/runtime/profile/identity row without inferring protected D1', async () => {
    const report = await generateAllAgentCommunicationManifestCandidates(fakeManifestDb(), candidateOptions())
    expect(report).toMatchObject({ ok: true, expected_target_count: 1, resolved_target_count: 1, blockers: [] })
    expect(report.target_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(report.targets[0]).toMatchObject({
      agent_id: 'dev-001',
      target_repository: 'watchout/agent-comms-mcp',
      workspace_id: 'workspace-dev-001',
      runtime_engine: 'codex-exec',
      runtime_profile_ref: 'agent-profile://dev-001/revision/7',
      provider_identity_ref: 'discord-identity://dev-001/identity-1',
      communication_auto_receive: true,
      protected_d1: false,
      discord_mode: 'native_verified',
    })
  })

  test('keeps unresolved/new seats in the denominator and fails the complete candidate', async () => {
    const options = candidateOptions()
    const report = await generateAllAgentCommunicationManifestCandidates(fakeManifestDb(true), {
      ...options,
      controlSourceByAgent: { ...options.controlSourceByAgent, 'new-dev': 'https://github.com/watchout/agent-comms-mcp/issues/887' },
      activeFunctionByAgent: { ...options.activeFunctionByAgent, 'new-dev': 'implementation_executor' },
      communicationAutoReceiveByAgent: { ...options.communicationAutoReceiveByAgent, 'new-dev': true },
      protectedD1ByAgent: { ...options.protectedD1ByAgent, 'new-dev': false },
      discordModeByAgent: { ...options.discordModeByAgent, 'new-dev': 'native_verified' },
    })
    expect(report).toMatchObject({ ok: false, expected_target_count: 2, resolved_target_count: 1, target_sha256: null })
    expect(report.expected_agent_ids).toEqual(['dev-001', 'new-dev'])
    expect(report.blockers).toContain('new-dev:primary_workspace_count_0')
  })

  test('keeps explicitly production seats in the denominator when agent ids contain test substrings', async () => {
    const options = candidateOptions()
    const report = await generateAllAgentCommunicationManifestCandidates(fakeManifestDb(false, 'codex', true), {
      ...options,
      controlSourceByAgent: {
        ...options.controlSourceByAgent,
        'contest-dev': 'https://github.com/watchout/agent-comms-mcp/issues/887',
      },
      activeFunctionByAgent: { ...options.activeFunctionByAgent, 'contest-dev': 'implementation_executor' },
      communicationAutoReceiveByAgent: { ...options.communicationAutoReceiveByAgent, 'contest-dev': true },
      protectedD1ByAgent: { ...options.protectedD1ByAgent, 'contest-dev': false },
      discordModeByAgent: { ...options.discordModeByAgent, 'contest-dev': 'native_verified' },
    })

    expect(report).toMatchObject({ ok: true, expected_target_count: 2, resolved_target_count: 2, blockers: [] })
    expect(report.expected_agent_ids).toEqual(['contest-dev', 'dev-001'])
    expect(report.targets.map(target => target.agent_id)).toEqual(['contest-dev', 'dev-001'])
    expect(report.target_sha256).toBe(allAgentCommunicationTargetSha256(report.targets))
  })

  test('omitted protected_d1 is a blocker, never an inherited default', async () => {
    const options = candidateOptions()
    const report = await generateAllAgentCommunicationManifestCandidates(fakeManifestDb(), {
      ...options,
      protectedD1ByAgent: {},
    })
    expect(report.ok).toBe(false)
    expect(report.blockers).toContain('dev-001:protected_d1_not_explicit')
    expect(report.resolved_target_count).toBe(0)
  })

  test('enabled unclassified seats fail closed and are never classified from their names', async () => {
    const report = await generateAllAgentCommunicationManifestCandidates(
      fakeManifestDb(false, 'codex', false, true),
      candidateOptions(),
    )
    expect(report.ok).toBe(false)
    expect(report.blockers).toContain('test-looking-dev:profile_class_unclassified')
    expect(report.expected_agent_ids).toEqual(['dev-001'])
  })

  test('profile/runtime engine mismatch fails closed instead of choosing either value', async () => {
    const report = await generateAllAgentCommunicationManifestCandidates(
      fakeManifestDb(false, 'claude'),
      candidateOptions(),
    )
    expect(report.ok).toBe(false)
    expect(report.blockers).toContain('dev-001:runtime_engine_profile_mismatch')
    expect(report.resolved_target_count).toBe(0)
  })
})
