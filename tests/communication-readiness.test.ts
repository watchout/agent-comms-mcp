import { describe, expect, test } from 'bun:test'
import type { BotStatusDbRow } from '../core/bot-status-db'
import {
  buildCommunicationReadinessReport,
  formatCommunicationReadinessText,
} from '../core/communication-readiness'
import type {
  RuntimeInventoryAgent,
  RuntimeInventoryConnector,
  RuntimeInventoryReport,
} from '../core/runtime-inventory'
import type { StateDaemonRuntimeReadiness } from '../core/state-daemon-readiness'

function drift(ok = true) {
  return {
    approved_commit: null,
    approved_checkout_roots: [],
    runtime_instance_id: null,
    checkout_path: null,
    commit_sha: null,
    dirty: null,
    ok,
    reasons: [],
  }
}

function botStatus(overrides: Partial<BotStatusDbRow> = {}): BotStatusDbRow {
  return {
    agent_id: 'kodama',
    status: 'online',
    last_seen_at: '2026-06-17T10:00:00.000Z',
    heartbeat_ok: true,
    pending_count: 0,
    oldest_pending_at: null,
    active_claim_count: 0,
    health_state: 'healthy',
    active_connector_count: 1,
    runtime_linked_connector_count: 1,
    active_endpoint_lease_count: 1,
    endpoint_lease_state: 'ok',
    endpoint_lease_expires_at: '2026-06-17T10:10:00.000Z',
    endpoint_lease_heartbeat_at: '2026-06-17T10:00:00.000Z',
    ...overrides,
  }
}

function runtimeAgent(overrides: Partial<RuntimeInventoryAgent> = {}): RuntimeInventoryAgent {
  return {
    agent_id: 'kodama',
    agent_status: 'online',
    declared_runtime: 'TUI',
    runtime_instance_count: 1,
    latest_runtime_instance_id: 'runtime-kodama',
    runtime_status: 'running',
    runtime_engine: 'codex',
    runtime_kind: 'local_process',
    session_name: 'discord-kodama',
    process_id: 123,
    port: 8803,
    checkout_path: '/Users/yuji/Developer/kodama',
    commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    checkout_drift: drift(),
    last_seen_at: '2026-06-17T10:00:00.000Z',
    freshness: 'fresh',
    warnings: [],
    ...overrides,
  }
}

function connector(overrides: Partial<RuntimeInventoryConnector> = {}): RuntimeInventoryConnector {
  return {
    connector_instance_id: 'connector-kodama',
    agent_id: 'kodama',
    provider: 'discord',
    connector_uri: 'discord://agents/kodama',
    status: 'active',
    trust_status: 'local',
    runtime_instance_id: 'runtime-kodama',
    runtime_freshness: 'fresh',
    active_binding_count: 1,
    last_seen_at: '2026-06-17T10:00:00.000Z',
    warnings: [],
    ...overrides,
  }
}

function runtimeInventory(overrides: Partial<RuntimeInventoryReport> = {}): RuntimeInventoryReport {
  return {
    ok: true,
    generated_at: '2026-06-17T10:00:00.000Z',
    policy: {
      db_is_source_of_truth: true,
      runtime_identity: 'agent_id is logical identity; runtime_instance_id is concrete process/session evidence',
      final_design_guardrail: 'read-only inventory',
    },
    options: {
      stale_minutes: 15,
      expected_commit: null,
      approved_checkout_roots: [],
      provider: 'discord',
      binding_role: 'outbound',
    },
    summary: {
      agents: 1,
      runtime_instances: 1,
      fresh_runtimes: 1,
      stale_runtimes: 0,
      connectors: 1,
      active_connectors: 1,
      active_bindings: 1,
      policy_gaps: 0,
      blockers: 0,
    },
    agents: [runtimeAgent()],
    connectors: [connector()],
    bindings: [],
    policy_gaps: [],
    blockers: [],
    warnings: [],
    ...overrides,
  }
}

function stateDaemon(overrides: Partial<StateDaemonRuntimeReadiness> = {}): StateDaemonRuntimeReadiness {
  const base: StateDaemonRuntimeReadiness = {
    label: 'com.agent-comms.state-daemon',
    status: 'ok',
    checked_at: '2026-06-17T10:00:00.000Z',
    launchd: {
      available: true,
      loaded: true,
      running: true,
      state: 'running',
      pid: 98894,
      last_exit_status: null,
    },
    process: {
      pid: 98894,
      command: 'bun bin/state-daemon.ts',
      cwd: '/Users/yuji/.agent-comms/state-daemon/checkouts/main',
    },
    paths: {
      program: '/Users/yuji/.bun/bin/bun',
      script: '/Users/yuji/.agent-comms/state-daemon/checkouts/main/bin/state-daemon.ts',
      working_directory: '/Users/yuji/.agent-comms/state-daemon/checkouts/main',
      stdout_path: '/tmp/state.out',
      stderr_path: '/tmp/state.err',
      plist_path: '/Users/yuji/Library/LaunchAgents/com.agent-comms.state-daemon.plist',
    },
    environment: {
      database_url: 'postgresql:///agent_comms',
      codex_runner_enabled: '0',
      queue_work_scheduler_enabled: '1',
      agent_allowlist: null,
      agent_denylist: null,
    },
    stderr: {
      path: '/tmp/state.err',
      exists: true,
      fatal_fingerprint: null,
    },
  }
  return {
    ...base,
    ...overrides,
    launchd: { ...base.launchd, ...(overrides.launchd ?? {}) },
    process: { ...base.process, ...(overrides.process ?? {}) },
    paths: { ...base.paths, ...(overrides.paths ?? {}) },
    environment: { ...base.environment, ...(overrides.environment ?? {}) },
    stderr: { ...base.stderr, ...(overrides.stderr ?? {}) },
  }
}

describe('#722 communication readiness', () => {
  test('passes for a scoped fresh bot with scheduler enabled and no open queue', () => {
    const report = buildCommunicationReadinessReport(
      [botStatus()],
      runtimeInventory(),
      stateDaemon(),
      {
        agentIds: ['kodama'],
        now: new Date('2026-06-17T10:01:00.000Z'),
      },
    )

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.summary.blockers).toBe(0)
    expect(report.state_daemon.runner_enabled).toBe(true)
    expect(report.policy).toMatchObject({
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_discord_live_write: true,
      no_next_inbox_fifo_drain: true,
      no_prompt_driven_processing: true,
      no_live_smoke: true,
    })
  })

  test('fails closed on stale pending active bot, stale runtime, missing lease, policy gap, and disabled runner', () => {
    const report = buildCommunicationReadinessReport(
      [
        botStatus({
          agent_id: 'l2auditor',
          pending_count: 2,
          oldest_pending_at: '2026-06-17T09:30:00.000Z',
          active_endpoint_lease_count: 0,
          endpoint_lease_state: 'missing_lease',
        }),
      ],
      runtimeInventory({
        agents: [runtimeAgent({
          agent_id: 'l2auditor',
          latest_runtime_instance_id: 'runtime-l2',
          freshness: 'stale',
          last_seen_at: '2026-06-17T09:00:00.000Z',
          warnings: ['runtime_stale'],
        })],
        connectors: [connector({
          agent_id: 'l2auditor',
          runtime_instance_id: 'runtime-l2',
          runtime_freshness: 'stale',
          warnings: ['connector_runtime_stale'],
        })],
        policy_gaps: [{
          channel_id: 'dev-arc',
          channel_name: 'dev-arc',
          adapter_owner_agent_id: 'l2auditor',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'active_binding_wrong_owner',
          active_binding_agents: ['arc'],
        }],
      }),
      stateDaemon({
        environment: {
          database_url: 'postgresql:///agent_comms',
          codex_runner_enabled: '0',
          queue_work_scheduler_enabled: null,
          agent_allowlist: null,
          agent_denylist: null,
        },
      }),
      {
        now: new Date('2026-06-17T10:01:00.000Z'),
        stalePendingMinutes: 15,
      },
    )

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.state_daemon.blocker_codes).toEqual(['STATE_DAEMON_RUNNER_DISABLED'])
    expect(report.agents[0].blocker_codes).toEqual([
      'ACTIVE_PENDING_OVER_SLO',
      'RUNTIME_NOT_FRESH',
      'ENDPOINT_LEASE_NOT_READY',
    ])
    expect(report.blockers.map((blocker) => blocker.code)).toContain('OUTBOUND_POLICY_GAP')
    expect(report.summary.active_enabled_pending_over_slo).toBe(1)
    expect(report.summary.runtime_blocked_agents).toBe(1)
    expect(report.summary.endpoint_lease_blocked_agents).toBe(1)
    expect(report.summary.policy_gaps).toBe(1)
  })

  test('flags human or Discord runtime pending rows as non-autonomous targets', () => {
    const report = buildCommunicationReadinessReport(
      [
        botStatus({
          agent_id: 'ceo',
          status: 'online',
          pending_count: 1,
          oldest_pending_at: '2026-06-17T09:55:00.000Z',
          active_connector_count: 0,
          runtime_linked_connector_count: 0,
          active_endpoint_lease_count: 0,
          endpoint_lease_state: 'not_applicable',
        }),
      ],
      runtimeInventory({
        agents: [runtimeAgent({
          agent_id: 'ceo',
          declared_runtime: 'discord',
          freshness: 'unknown',
          latest_runtime_instance_id: null,
          runtime_status: null,
          warnings: ['no_runtime_instance'],
        })],
        connectors: [],
      }),
      stateDaemon(),
      { now: new Date('2026-06-17T10:01:00.000Z') },
    )

    expect(report.ok).toBe(false)
    expect(report.agents[0].blocker_codes).toContain('HUMAN_OR_DISCORD_TARGET_PENDING')
    expect(report.agents[0].blocker_codes).toContain('RUNTIME_NOT_FRESH')
  })

  test('text formatter exposes read-only evidence without implying live activation', () => {
    const report = buildCommunicationReadinessReport(
      [botStatus()],
      runtimeInventory(),
      stateDaemon(),
      { now: new Date('2026-06-17T10:01:00.000Z') },
    )
    const text = formatCommunicationReadinessText(report)

    expect(text).toContain('AUN Communication Readiness')
    expect(text).toContain('State daemon: status=ok')
    expect(text).toContain('Mutation performed: false')
    expect(text).toContain('Restart performed: false')
  })
})
