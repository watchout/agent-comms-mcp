import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRecoveryReadinessReport,
  formatRecoveryReadinessText,
  type RecoveryReadinessScope,
} from '../core/recovery-readiness'
import type { StateDaemonRuntimeReadiness } from '../core/state-daemon-readiness'
import { resetChannelPolicyCache } from '../core/channel-policy'

const REPO = join(import.meta.dir, '..')
const ROUTING_PATH = `/tmp/recovery-readiness-routing-${process.pid}-${Date.now()}.json`

function setRoutingConfig(channels: Record<string, unknown>) {
  writeFileSync(ROUTING_PATH, JSON.stringify({ version: 1, channels }), 'utf8')
  process.env.AGENT_COM_BOT_ROUTING_PATH = ROUTING_PATH
  resetChannelPolicyCache()
}

afterEach(() => {
  delete process.env.AGENT_COM_BOT_ROUTING_PATH
  resetChannelPolicyCache()
  try { if (existsSync(ROUTING_PATH)) unlinkSync(ROUTING_PATH) } catch {}
})

function launchRuntime(overrides: Partial<StateDaemonRuntimeReadiness> = {}): StateDaemonRuntimeReadiness {
  return {
    label: 'com.agent-comms.state-daemon',
    status: 'ok',
    checked_at: '2026-06-01T00:00:00.000Z',
    launchd: {
      available: true,
      loaded: true,
      running: true,
      state: 'running',
      pid: 4242,
      last_exit_status: 0,
    },
    process: {
      pid: 4242,
      command: '/usr/local/bin/bun /repo/bin/state-daemon.ts',
      cwd: '/repo',
    },
    paths: {
      program: '/usr/local/bin/bun',
      script: '/repo/bin/state-daemon.ts',
      working_directory: '/repo',
      stdout_path: '/repo/logs/out.log',
      stderr_path: '/repo/logs/err.log',
      plist_path: '/launch/com.agent-comms.state-daemon.plist',
    },
    environment: {
      database_url: 'postgresql:///agent_comms?host=/tmp',
      agent_allowlist: null,
      agent_denylist: null,
    },
    stderr: {
      path: '/repo/logs/err.log',
      exists: true,
      fatal_fingerprint: null,
    },
    ...overrides,
  }
}

function plist(entry = '/repo/bin/state-daemon.ts', cwd = '/repo'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-comms.state-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/bun</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>StandardErrorPath</key>
  <string>/repo/logs/err.log</string>
</dict>
</plist>`
}

function pathProbe(missing: string[] = []) {
  const missingSet = new Set(missing)
  return {
    exists: (path: string) => !missingSet.has(path),
    isDirectory: (path: string) => path === '/repo',
    isFile: (path: string) => path === '/usr/local/bin/bun' || path.endsWith('.ts'),
    isExecutable: (path: string) => path === '/usr/local/bin/bun',
  }
}

function scope(overrides: Partial<RecoveryReadinessScope> = {}): RecoveryReadinessScope {
  return {
    scope_id: 'cp80-602-603',
    agents: ['codex-cto', 'ceo'],
    channels: ['1487368919613444156'],
    state_daemon: {
      expected: true,
      plist_path: '/launch/com.agent-comms.state-daemon.plist',
    },
    projection_checks: [{
      channel_id: '1487368919613444156',
      sender_agent_id: 'codex-cto',
      recipient_agent_ids: ['ceo'],
      expected_consumer_agent_id: 'codex-cto',
      expected_consumer_source: 'sender_token_evidence',
    }],
    ...overrides,
  }
}

function queueSample(overrides: Record<string, unknown>) {
  return {
    source_table: 'message_queue.payload',
    record_id: 101,
    queue_id: 101,
    agent_id: 'codex-cto',
    message_id: 'message-101',
    status: 'pending',
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    evidence: 'sample',
    total_count: 1,
    ...overrides,
  }
}

function mockAgent(agentId: string, options: { agentType?: string; status?: string } = {}) {
  return {
    agent_id: agentId,
    agent_type: options.agentType ?? 'dev',
    status: options.status ?? 'idle',
    metadata: { discord_id: `${agentId}-discord-id` },
  }
}

function mockDb(options: {
  promptRows?: any[]
  staleActiveRows?: any[]
  backlogRows?: any[]
  bindingDeliveryAgents?: string[]
  readOnlyDeliveryAgents?: string[]
  eligibleDeliveryAgents?: string[]
  agents?: Record<string, any>
  completeRecoveryRows?: any[]
} = {}) {
  const bindingAgents = new Set(options.bindingDeliveryAgents ?? ['codex-cto'])
  const readOnlyAgents = new Set(options.readOnlyDeliveryAgents ?? [])
  const eligibleAgents = new Set(options.eligibleDeliveryAgents ?? [])
  const boundAgents = new Set([...bindingAgents, ...readOnlyAgents, ...eligibleAgents])
  const agents = {
    'codex-cto': mockAgent('codex-cto'),
    ceo: mockAgent('ceo', { agentType: 'human' }),
    aun: mockAgent('aun'),
    ...(options.agents ?? {}),
  }
  const connectorIdsFor = (agentId: string) => (
    boundAgents.has(agentId)
      ? [`connector-${agentId}`]
      : []
  )
  const filteredRows = (rows: any[] | undefined, params?: unknown[]) => {
    const agentFilter = params?.find((param): param is string => typeof param === 'string' && !/^\d+$/.test(param) && !param.includes('%')) ?? null
    return agentFilter ? (rows ?? []).filter((row) => row.agent_id === agentFilter) : (rows ?? [])
  }
  const agentFromConnector = (connectorId: unknown) => {
    if (typeof connectorId !== 'string') return ''
    return connectorId.replace(/^connector-/, '')
  }
  const queries: string[] = []
  const db = {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push(sql)
      if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql)) {
        throw new Error(`mutation SQL is forbidden in recovery readiness: ${sql}`)
      }
      if (sql.includes('GROUP BY mq.status') && !sql.includes('mq.agent_id')) {
        return { rows: [{ status: 'pending', count: options.backlogRows?.length ?? 0 }] }
      }
      if (sql.includes('GROUP BY mq.agent_id, mq.status')) {
        return { rows: filteredRows(options.backlogRows, params) }
      }
      if (sql.includes("'message_queue.payload'")) return { rows: filteredRows(options.promptRows, params) }
      if (sql.includes("'agent_messages.content'")) return { rows: [] }
      if (sql.includes("'agent_messages.metadata'")) return { rows: [] }
      if (sql.includes("'message_queue.active'")) return { rows: filteredRows(options.staleActiveRows, params) }
      if (sql.includes("'message_queue.baton'")) return { rows: [] }
      if (sql.includes('FROM message_queue') && sql.includes('WHERE id = $1')) {
        const queueId = params?.[0]
        return { rows: (options.completeRecoveryRows ?? []).filter((row) => String(row.id) === String(queueId)).slice(0, 1) }
      }
      if (sql.includes('FROM message_queue') && sql.includes('WHERE message_id = $1')) {
        const messageId = params?.[0]
        const agentId = params?.[1]
        return {
          rows: (options.completeRecoveryRows ?? [])
            .filter((row) => row.message_id === messageId && row.agent_id === agentId)
            .slice(0, 1),
        }
      }
      if (sql.includes('channel_routing_policy')) return { rows: [] }
      if (sql.includes('thread_adapters')) return { rows: [] }
      if (sql.includes('channel_adapters')) {
        return { rows: [{ external_id: '1487368919613444156', metadata: null }] }
      }
      if (sql.includes('connector_instances') && !sql.includes('channel_connector_bindings')) {
        const agentId = typeof params?.[1] === 'string' ? params[1] : ''
        return { rows: connectorIdsFor(agentId).map((connector_instance_id) => ({ connector_instance_id, status: 'active' })) }
      }
      if (sql.includes('connector_credentials')) {
        const agentId = typeof params?.[1] === 'string' ? params[1] : ''
        const connectorId = typeof params?.[2] === 'string' ? params[2] : ''
        return connectorIdsFor(agentId).includes(connectorId)
          ? { rows: [{ credential_id: `credential-${agentId}`, credential_status: 'active' }] }
          : { rows: [] }
      }
      if (sql.includes('channel_connector_bindings')) {
        if (sql.includes('JOIN connector_instances')) {
          return {
            rows: Array.from(boundAgents).flatMap((agentId) => connectorIdsFor(agentId).map((connector_instance_id) => ({
              agent_id: agentId,
              connector_instance_id,
              channel_binding_id: `binding-${agentId}`,
              priority: 10,
            }))),
          }
        }
        const agentId = agentFromConnector(params?.[2])
        return boundAgents.has(agentId)
          ? { rows: [{ channel_binding_id: `binding-${agentId}` }] }
          : { rows: [] }
      }
      if (sql.includes('provider_channel_access')) {
        const agentId = agentFromConnector(params?.[2])
        if (readOnlyAgents.has(agentId)) {
          return { rows: [{ provider_channel_access_id: `access-${agentId}`, capabilities: { channel_get: true } }] }
        }
        return eligibleAgents.has(agentId) || bindingAgents.has(agentId)
          ? { rows: [{ provider_channel_access_id: `access-${agentId}`, capabilities: { message_create: true } }] }
          : { rows: [] }
      }
      if (sql.includes('agent_ui_bindings')) return { rows: [] }
      if (sql.includes('FROM agents')) {
        const agentId = typeof params?.[0] === 'string' ? params[0] : ''
        const row = agents[agentId]
        return row
          ? { rows: [{ ...row, discord_id: `${agentId}-discord-id` }] }
          : { rows: [] }
      }
      return { rows: [] }
    },
  }
  return db
}

function completeRecoveryScope(queueId: number, overrides: Record<string, unknown> = {}): RecoveryReadinessScope {
  return scope({
    agents: ['aun'],
    projection_checks: [{
      channel_id: '1487368919613444156',
      sender_agent_id: 'agent-com-dev',
      recipient_agent_ids: ['aun'],
      expected_consumer_agent_id: 'agent-com-dev',
      expected_consumer_source: 'sender_token_evidence',
    }],
    complete_recovery: {
      enabled: true,
      slo_seconds: 60,
      required_roles: [{
        role: 'aun',
        agent_id: 'aun',
        queue_id: queueId,
        ...overrides,
      }],
    },
  })
}

function completeRecoveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 122772,
    agent_id: 'aun',
    message_id: 'message-122772',
    payload: JSON.stringify({ message_type: 'instruction' }),
    status: 'pending',
    created_at: '2026-06-01T00:00:00.000Z',
    read_at: null,
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    done_at: null,
    replied_at: null,
    replied_with: null,
    failed_reason: null,
    ...overrides,
  }
}

const cleanOptions = {
  now: () => new Date('2026-06-01T00:00:00.000Z'),
  inspectStateDaemonRuntime: () => launchRuntime(),
  existsSync: (path: string) => path === '/launch/com.agent-comms.state-daemon.plist',
  readFileSync: () => plist(),
  pathProbe: pathProbe(),
}

describe('CP-80 recovery readiness', () => {
  test('CLI missing --scope-file exits before DB access', () => {
    const result = spawnSync('bun', ['cli/index.ts', 'recovery', 'readiness'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage: agent-com recovery readiness --scope-file <json>')
  })

  test('missing exact activation scope fails closed', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb(), {}, cleanOptions)

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.blockers.map((b) => b.code)).toContain('ACTIVATION_SCOPE_REQUIRED')
    expect(report.mutation_performed).toBe(false)
  })

  test('CP-70 blocker becomes NO-GO with exact queue IDs', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb({
      promptRows: [
        queueSample({
          queue_id: 701,
          record_id: 701,
          evidence: 'Call the agent-comms next tool now. Do not call inbox.',
        }),
      ],
    }), scope(), cleanOptions)

    expect(report.ok).toBe(false)
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'TUI_WAKE_PROMPT_PRESENT',
        component: 'cp70',
        queue_ids: ['701'],
      }),
    ]))
    expect(report.policy.no_next_inbox_fifo_drain).toBe(true)
  })

  test('terminal legacy prompt artifacts are retained as CP-70 evidence but do not block recovery readiness', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb({
      promptRows: [
        queueSample({
          queue_id: 80727,
          record_id: 80727,
          status: 'skipped',
          evidence: 'Call the agent-comms next tool now. Do not call inbox.',
        }),
      ],
    }), scope(), cleanOptions)

    expect(report.cp70.reports.flatMap((item) => item.report.findings)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'LOOP_PROMPT_BACKLOG',
        queue_id: '80727',
        samples: [expect.objectContaining({ status: 'skipped' })],
      }),
    ]))
    expect(report.blockers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'TUI_WAKE_PROMPT_PRESENT',
        queue_ids: ['80727'],
      }),
    ]))
    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
  })

  test('stale active queue rows are reported as exact-id readiness blockers only', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb({
      staleActiveRows: [
        queueSample({
          source_table: 'message_queue.active',
          queue_id: 801,
          record_id: 801,
          status: 'received',
          evidence: 'claimed_by=codex-cto, claim_expires_at=2026-05-31T23:00:00.000Z',
        }),
      ],
    }), scope(), cleanOptions)

    expect(report.ok).toBe(false)
    expect(report.queue_readiness.stale_active_rows).toEqual([
      expect.objectContaining({ queue_id: 801, status: 'received' }),
    ])
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'STUCK_ACTIVE_QUEUE_ROW',
        component: 'queue',
        queue_ids: ['801'],
      }),
    ]))
    expect(report.mutation_performed).toBe(false)
  })

  test('missing LaunchAgent ProgramArguments[1] path is NO-GO', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb(), scope(), {
      ...cleanOptions,
      readFileSync: () => plist('/repo/bin/missing-state-daemon.ts'),
      pathProbe: pathProbe(['/repo/bin/missing-state-daemon.ts']),
    })

    expect(report.ok).toBe(false)
    expect(report.launchagent.validation?.errors.map((issue) => issue.code)).toContain('state_daemon_entry_missing')
    expect(report.blockers.map((b) => b.code)).toContain('LAUNCHAGENT_CONFIG_INVALID')
  })

  test('private tmp LaunchAgent checkout path is NO-GO unless explicitly allowed', async () => {
    setRoutingConfig({})
    const tmpPlist = plist('/private/tmp/agent-comms-stale/bin/state-daemon.ts', '/private/tmp/agent-comms-stale')
    const report = await buildRecoveryReadinessReport(mockDb(), scope(), {
      ...cleanOptions,
      inspectStateDaemonRuntime: () => launchRuntime({
        paths: {
          ...launchRuntime().paths,
          script: '/private/tmp/agent-comms-stale/bin/state-daemon.ts',
          working_directory: '/private/tmp/agent-comms-stale',
        },
        process: {
          pid: 4242,
          command: '/usr/local/bin/bun /private/tmp/agent-comms-stale/bin/state-daemon.ts',
          cwd: '/private/tmp/agent-comms-stale',
        },
      }),
      readFileSync: () => tmpPlist,
      pathProbe: {
        exists: () => true,
        isDirectory: (path: string) => path.endsWith('agent-comms-stale'),
        isFile: (path: string) => path === '/usr/local/bin/bun' || path.endsWith('.ts'),
        isExecutable: (path: string) => path === '/usr/local/bin/bun',
      },
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((b) => b.code)).toContain('LAUNCHAGENT_PRIVATE_TMP_PATH')
  })

  test('unloaded state_daemon is reported as NO-GO without restart evidence', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb(), scope(), {
      ...cleanOptions,
      inspectStateDaemonRuntime: () => launchRuntime({
        status: 'unloaded',
        launchd: {
          available: true,
          loaded: false,
          running: false,
          state: null,
          pid: null,
          last_exit_status: null,
        },
        process: { pid: null, command: null, cwd: null },
      }),
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((b) => b.code)).toContain('STATE_DAEMON_UNLOADED')
    expect(report.policy.no_state_daemon_restart).toBe(true)
    expect(report.recommended_next_commands.join('\n')).not.toMatch(/kickstart|bootstrap|restart/i)
  })

  test('AUN/router fallback projection is NO-GO unless explicitly scoped', async () => {
    setRoutingConfig({
      '1487368919613444156': {
        adapterOwner: 'aun',
        primary: 'aun',
      },
    })
    const fallbackDb = mockDb({
      bindingDeliveryAgents: ['aun'],
      readOnlyDeliveryAgents: ['codex-cto'],
    })
    const report = await buildRecoveryReadinessReport(fallbackDb, scope(), cleanOptions)

    expect(report.ok).toBe(false)
    expect(report.projection_readiness[0].decision.consumerAgentId).toBe('aun')
    expect(report.projection_readiness[0].decision.consumerSource).toBe('derived_single_connector')
    expect(report.blockers.map((b) => b.code)).toEqual(expect.arrayContaining([
      'PROJECTION_DIRECT_DELIVERY_MISMATCH',
    ]))

    const allowed = await buildRecoveryReadinessReport(fallbackDb, scope({
      projection_checks: [{
        channel_id: '1487368919613444156',
        sender_agent_id: 'codex-cto',
        recipient_agent_ids: ['ceo'],
        expected_consumer_agent_id: 'aun',
        expected_consumer_source: 'derived_single_connector',
        allow_fallback: true,
      }],
    }), cleanOptions)
    expect(allowed.projection_readiness[0].ok).toBe(true)
    expect(allowed.blockers.map((b) => b.code)).not.toContain('PROJECTION_FALLBACK_DISALLOWED')
  })

  test('durable JSON is stable and text format reports GO/NO-GO', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb({
      backlogRows: [{ agent_id: 'codex-cto', status: 'pending', count: 2 }],
    }), scope(), cleanOptions)
    const parsed = JSON.parse(JSON.stringify(report, null, 2))
    const text = formatRecoveryReadinessText(report)

    expect(parsed).toMatchObject({
      ok: true,
      go_no_go: 'GO',
      mutation_performed: false,
      scope: {
        scope_id: 'cp80-602-603',
        channels: ['1487368919613444156'],
      },
      queue_readiness: {
        pending_backlog: {
          total: 2,
        },
      },
    })
    expect(text).toContain('CP-80 Recovery Readiness')
    expect(text).toContain('Result: GO')
  })

  test('complete recovery gate fails pending unclaimed live evidence', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb({
      bindingDeliveryAgents: ['agent-com-dev'],
      agents: { 'agent-com-dev': mockAgent('agent-com-dev') },
      completeRecoveryRows: [completeRecoveryRow()],
    }), completeRecoveryScope(122772, {
      durable_evidence_urls: ['https://github.com/watchout/agent-comms-mcp/issues/715#issuecomment-1'],
    }), cleanOptions)

    expect(report.ok).toBe(false)
    expect(report.complete_recovery.summary).toMatchObject({ fail: 1, pass: 0 })
    expect(report.complete_recovery.role_results[0]).toMatchObject({
      status: 'FAIL',
      queue_id: 122772,
      queue_status: 'pending',
      blocker_codes: ['COMPLETE_RECOVERY_PENDING_UNCLAIMED'],
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'COMPLETE_RECOVERY_PENDING_UNCLAIMED',
        component: 'complete_recovery',
        queue_ids: [122772],
      }),
    ]))
  })

  test('complete recovery gate rejects processed rows without durable evidence URL', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb({
      bindingDeliveryAgents: ['agent-com-dev'],
      agents: { 'agent-com-dev': mockAgent('agent-com-dev') },
      completeRecoveryRows: [completeRecoveryRow({
        status: 'replied',
        claimed_by: 'aun',
        claimed_at: '2026-06-01T00:00:01.000Z',
        replied_at: '2026-06-01T00:00:03.000Z',
        payload: JSON.stringify({
          message_type: 'instruction',
          runner_result: { ok: true, summary: 'processed' },
        }),
      })],
    }), completeRecoveryScope(122772), cleanOptions)

    expect(report.ok).toBe(false)
    expect(report.complete_recovery.role_results[0]).toMatchObject({
      status: 'FAIL',
      blocker_codes: ['COMPLETE_RECOVERY_DURABLE_EVIDENCE_MISSING'],
    })
  })

  test('complete recovery gate passes only claimed processed durable evidence', async () => {
    setRoutingConfig({})
    const report = await buildRecoveryReadinessReport(mockDb({
      bindingDeliveryAgents: ['agent-com-dev'],
      agents: { 'agent-com-dev': mockAgent('agent-com-dev') },
      completeRecoveryRows: [completeRecoveryRow({
        status: 'replied',
        claimed_by: 'aun',
        claimed_at: '2026-06-01T00:00:01.000Z',
        replied_at: '2026-06-01T00:00:03.000Z',
        payload: JSON.stringify({
          message_type: 'instruction',
          runner_result: { ok: true, summary: 'processed' },
          writeback_result: {
            posted_with: 'https://github.com/watchout/agent-comms-mcp/issues/715#issuecomment-2',
            body_sha256: 'a'.repeat(64),
          },
        }),
      })],
    }), completeRecoveryScope(122772, {
      require_github_writeback: true,
    }), cleanOptions)

    expect(report.ok).toBe(true)
    expect(report.complete_recovery.summary).toMatchObject({ pass: 1, fail: 0, blocked: 0, untested: 0 })
    expect(report.complete_recovery.role_results[0]).toMatchObject({
      status: 'PASS',
      queue_id: 122772,
      durable_evidence_urls: ['https://github.com/watchout/agent-comms-mcp/issues/715#issuecomment-2'],
    })
  })

  test('recovery readiness source has no activation or FIFO-drain call path', () => {
    const src = readFileSync(join(REPO, 'core', 'recovery-readiness.ts'), 'utf8')
    const cli = readFileSync(join(REPO, 'cli', 'index.ts'), 'utf8')
    const recoveryBody = cli.match(/async function recoveryCommand[\s\S]*?\n}\n\nasync function repairQueue/)?.[0] ?? ''

    expect(src).not.toMatch(/restartSession|kickstart|bootstrap|send-keys|Discord\.Client|\.login\(|nextMessage\(|inbox\(/)
    expect(recoveryBody).not.toMatch(/nextMessage\(|receiveMessage\(|restartSession|kickstart|bootstrap|Discord\.Client|\.login\(/)
    expect(recoveryBody).toMatch(/buildRecoveryReadinessReport/)
  })
})
