import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { toLegacy } from '../core/db/adapter'
import { ensureEventLogSchema } from '../core/eventlog'
import {
  claimD1Execution,
  computeD1AuthorizationDigest,
  invokeD1Execution,
  type D1AuthorizationEnvelope,
  type D1Effect,
} from '../core/shirube-d1-execution-adapter'
import {
  SHIRUBE_D1_RUNTIME_BINDING_VERSION,
  ShirubeD1RuntimeController,
  ShirubeD1RuntimeError,
  buildShirubeD1RuntimePolicy,
  computeShirubeD1InvocationKey,
  createShirubeD1DatabasePorts,
  type ShirubeD1RuntimeBinding,
} from '../core/shirube-d1-runtime'
import {
  claimPendingQueueForAunRuntimeV2,
  runAunRuntimeV2,
} from '../core/aun-runtime-v2'
import {
  QUEUE_WORK_RESULT_VERSION,
  type LlmRuntimeAdapter,
  type QueueWorkGithubIssueCommentWriteback,
} from '../core/queue-work'
import { makeDeliveryFixture } from './aun-k3/delivery-fixture'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function sqliteFixture(): { adapter: SqliteAdapter; db: ReturnType<typeof toLegacy> } {
  const dir = mkdtempSync(join(tmpdir(), 'shirube-d1-runtime-'))
  tempDirs.push(dir)
  const path = join(dir, 'agent-com.db')
  migrateSqlite(path)
  const adapter = new SqliteAdapter(path)
  return { adapter, db: toLegacy(adapter) }
}

function envelope(): D1AuthorizationEnvelope {
  const unsigned = {
    control_source: 'https://github.com/watchout/agent-comms-mcp/issues/887',
    handoff_id: 'CH-ACM-887-SHIRUBE-V4-D1-ACTIVATION-001',
    exact_base_sha: '6efac0626c0947d3816e8f63e0575740a21b5554',
    allowed_paths: [
      'core/shirube-d1-runtime.ts',
      'core/aun-runtime-v2.ts',
      'db/migrations/2026-07-21-shirube-v4-d1-runtime.up.sql',
    ],
  }
  return { ...unsigned, authorization_digest: computeD1AuthorizationDigest(unsigned) }
}

function binding(allowedEffects: D1Effect[] = ['github_writeback']): ShirubeD1RuntimeBinding {
  return {
    schema_version: SHIRUBE_D1_RUNTIME_BINDING_VERSION,
    target: {
      repository: 'watchout/agent-comms-mcp',
      agent_id: 'dev-001',
      control_source: envelope().control_source,
    },
    authorization: envelope(),
    activation_evidence: {
      adapter_head_sha: 'a'.repeat(40),
      independent_audit_ref: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-audit',
      qa_ref: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-qa',
      check_ref: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-check',
      cto_go_ref: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-cto',
    },
    allowed_effects: allowedEffects,
  }
}

function enabledEnv(killSwitch = false): NodeJS.ProcessEnv {
  return {
    SHIRUBE_D1_ENABLED: '1',
    SHIRUBE_D1_KILL_SWITCH: killSwitch ? '1' : '0',
    SHIRUBE_D1_TARGET_ALLOWLIST: JSON.stringify([binding().target]),
    SHIRUBE_D1_AUTHORIZATION_DIGEST: envelope().authorization_digest,
    SHIRUBE_D1_ADAPTER_HEAD_SHA: 'a'.repeat(40),
    SHIRUBE_D1_AUDIT_REF: binding().activation_evidence.independent_audit_ref,
    SHIRUBE_D1_QA_REF: binding().activation_evidence.qa_ref,
    SHIRUBE_D1_CHECK_REF: binding().activation_evidence.check_ref,
    SHIRUBE_D1_CTO_GO_REF: binding().activation_evidence.cto_go_ref,
  } as NodeJS.ProcessEnv
}

function noOpPerformers() {
  const result = async (effect: D1Effect, key: string) => `${effect}:${key}`
  return {
    internal_reply: (key: string) => result('internal_reply', key),
    github_writeback: (key: string) => result('github_writeback', key),
    external_send: (key: string) => result('external_send', key),
  }
}

describe('Shirube V4 D1 production runtime', () => {
  test('defaults disabled with the kill switch active', () => {
    expect(buildShirubeD1RuntimePolicy({} as NodeJS.ProcessEnv)).toEqual({
      enabled: false,
      kill_switch: true,
      allowlist: [],
      authorization_digest: null,
      adapter_head_sha: null,
      gate_refs: {
        independent_audit_ref: '',
        qa_ref: '',
        check_ref: '',
        cto_go_ref: '',
      },
    })
  })

  test('missing authorization on an enrolled tuple causes zero D1 persistence', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      const controller = new ShirubeD1RuntimeController(adapter, { env: enabledEnv() })
      await expect(controller.beforeClaim({
        id: 1,
        agent_id: 'dev-001',
        message_id: 'message-1',
        payload: JSON.stringify({ content: 'missing binding' }),
        status: 'pending',
      })).rejects.toMatchObject({ code: 'D1_AUTHORIZATION_REQUIRED' })
      expect(await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_claims')).toEqual([{ count: 0 }])
      expect(await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_invocations')).toEqual([{ count: 0 }])
      expect(await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_effect_deliveries')).toEqual([{ count: 0 }])
    } finally {
      await adapter.close()
    }
  })

  test('kill switch rejects the exact enrolled tuple before persistence', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      const controller = new ShirubeD1RuntimeController(adapter, { env: enabledEnv(true) })
      const error = await controller.beforeClaim({
        id: 2,
        agent_id: 'dev-001',
        message_id: 'message-2',
        payload: JSON.stringify({ shirube_v4_d1: binding() }),
        status: 'pending',
      }).catch((caught) => caught)
      expect(error).toBeInstanceOf(ShirubeD1RuntimeError)
      expect(error.code).toBe('D1_KILL_SWITCH_ACTIVE')
      expect(await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_claims')).toEqual([{ count: 0 }])
    } finally {
      await adapter.close()
    }
  })

  test('multi-target canary activation is rejected before opening the DB', () => {
    const env = enabledEnv()
    env.SHIRUBE_D1_TARGET_ALLOWLIST = JSON.stringify([
      binding().target,
      { ...binding().target, repository: 'watchout/agent-memory' },
    ])
    expect(() => buildShirubeD1RuntimePolicy(env)).toThrow('exactly one target')
  })

  test('activated digest mismatch causes zero D1 persistence', async () => {
    const { adapter } = sqliteFixture()
    try {
      const env = enabledEnv()
      env.SHIRUBE_D1_AUTHORIZATION_DIGEST = 'f'.repeat(64)
      const controller = new ShirubeD1RuntimeController(adapter, { env })
      await expect(controller.beforeClaim({
        id: 3,
        agent_id: 'dev-001',
        message_id: 'message-3',
        payload: JSON.stringify({ shirube_v4_d1: binding() }),
        status: 'pending',
      })).rejects.toMatchObject({ code: 'D1_AUTHORIZATION_REQUIRED' })
      expect(await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_claims')).toEqual([{ count: 0 }])
    } finally {
      await adapter.close()
    }
  })

  test('live D1 refuses execution without mediated finalization', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      const controller = new ShirubeD1RuntimeController(adapter, { env: enabledEnv() })
      const outcome = await runAunRuntimeV2(db, {
        agentId: 'dev-001', queueId: 1, messageId: 'message-1',
        createdAfter: '2026-07-21T07:59:00.000Z',
        adapter: {
          runtime_id: 'must-not-run',
          capabilities: { input: 'stdin_context', output: 'schema_json', supportsBareMode: true, supportsResume: false, supportsToolAllowlist: false, supportsSandbox: true, supportsUsageMetadata: false },
          async invoke() { throw new Error('must not run') },
        },
        d1Runtime: controller,
      })
      expect(outcome).toMatchObject({ ok: false, code: 'D1_FINALIZATION_REQUIRED' })
    } finally {
      await adapter.close()
    }
  })

  test('database ports serialize concurrent same-key delivery to one receipt', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      let effects = 0
      const performers = noOpPerformers()
      performers.github_writeback = async (key) => {
        effects += 1
        await Bun.sleep(20)
        return `github:${key}:receipt`
      }
      const authorization = envelope()
      const ports = createShirubeD1DatabasePorts(adapter, authorization, performers, {
        effectLeaseMs: 1_000,
        effectWaitMs: 2_000,
        effectPollMs: 2,
      })
      const claimed = await claimD1Execution(authorization, 'claim:concurrent', ports)
      const [left, right] = await Promise.all([
        invokeD1Execution(authorization, claimed, 'invoke:concurrent', 'github_writeback', ports),
        invokeD1Execution(authorization, claimed, 'invoke:concurrent', 'github_writeback', ports),
      ])
      expect(effects).toBe(1)
      expect(left.github_writeback_receipt).toBe(right.github_writeback_receipt)
      expect(await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_effect_deliveries')).toEqual([{ count: 1 }])
    } finally {
      await adapter.close()
    }
  })

  test('ack loss retries through the downstream idempotency key without duplicate effect', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      const durableDownstream = new Map<string, string>()
      let actualEffects = 0
      let loseAck = true
      const performers = noOpPerformers()
      performers.external_send = async (key) => {
        let receipt = durableDownstream.get(key)
        if (!receipt) {
          receipt = `external:${key}:receipt`
          durableDownstream.set(key, receipt)
          actualEffects += 1
        }
        if (loseAck) {
          loseAck = false
          throw new Error('SIMULATED_ACK_LOSS')
        }
        return receipt
      }
      const authorization = envelope()
      const firstPorts = createShirubeD1DatabasePorts(adapter, authorization, performers, {
        effectLeaseMs: 1,
        effectWaitMs: 100,
        effectPollMs: 1,
        effectReadbacks: {
          external_send: async (key) => durableDownstream.get(key) ?? null,
        },
      })
      const claimed = await claimD1Execution(authorization, 'claim:ack-loss', firstPorts)
      await expect(invokeD1Execution(
        authorization,
        claimed,
        'invoke:ack-loss',
        'external_send',
        firstPorts,
      )).rejects.toThrow('SIMULATED_ACK_LOSS')
      await Bun.sleep(5)
      const restartedPorts = createShirubeD1DatabasePorts(adapter, authorization, performers, {
        effectLeaseMs: 1,
        effectWaitMs: 100,
        effectPollMs: 1,
        effectReadbacks: {
          external_send: async (key) => durableDownstream.get(key) ?? null,
        },
      })
      const replayed = await invokeD1Execution(
        authorization,
        claimed,
        'invoke:ack-loss',
        'external_send',
        restartedPorts,
      )
      expect(actualEffects).toBe(1)
      expect(replayed.external_send_receipt).toBe(durableDownstream.get('invoke:ack-loss'))
    } finally {
      await adapter.close()
    }
  })

  test('expired lease never starts a second performer while the original performer is still alive', async () => {
    const { adapter } = sqliteFixture()
    try {
      let effects = 0
      let release!: () => void
      let started!: () => void
      const performerStarted = new Promise<void>((resolve) => { started = resolve })
      const performerRelease = new Promise<void>((resolve) => { release = resolve })
      const performers = noOpPerformers()
      performers.github_writeback = async (key) => {
        effects += 1
        started()
        await performerRelease
        return `github:${key}:receipt`
      }
      const authorization = envelope()
      const ports = createShirubeD1DatabasePorts(adapter, authorization, performers, {
        effectLeaseMs: 1,
        effectWaitMs: 100,
        effectPollMs: 1,
        effectReadbacks: { github_writeback: async () => null },
      })
      const claimed = await claimD1Execution(authorization, 'claim:expired-live', ports)
      const first = invokeD1Execution(authorization, claimed, 'invoke:expired-live', 'github_writeback', ports)
      await performerStarted
      await Bun.sleep(5)
      await expect(invokeD1Execution(
        authorization,
        claimed,
        'invoke:expired-live',
        'github_writeback',
        ports,
      )).rejects.toThrow('D1_EFFECT_OUTCOME_UNKNOWN')
      expect(effects).toBe(1)
      release()
      const completed = await first
      expect(completed.github_writeback_receipt).toBe('github:invoke:expired-live:receipt')
      expect(effects).toBe(1)
    } finally {
      await adapter.close()
    }
  })

  test('runtime-v2 rejects missing D1 authorization before D1 persistence or effect', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      await adapter.execute(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 1, $4)`,
        ['dev-001', 'message-missing', JSON.stringify({ content: 'missing auth' }), '2026-07-21T08:00:00.000Z'],
      )
      let modelCalls = 0
      const runtime: LlmRuntimeAdapter = {
        runtime_id: 'fixture',
        capabilities: {
          input: 'stdin_context', output: 'schema_json', supportsBareMode: true,
          supportsResume: false, supportsToolAllowlist: false, supportsSandbox: true,
          supportsUsageMetadata: false,
        },
        async invoke() {
          modelCalls += 1
          return {
            schema_version: QUEUE_WORK_RESULT_VERSION,
            ok: true,
            summary: 'authorization-negative fixture',
            evidence: ['semantic_outcome=close', 'outcome_reason=authorization_negative'],
            next_action: 'close',
          }
        },
      }
      const controller = new ShirubeD1RuntimeController(adapter, { env: enabledEnv() })
      const outcome = await runAunRuntimeV2(db, {
        agentId: 'dev-001', queueId: 1, messageId: 'message-missing',
        createdAfter: '2026-07-21T07:59:00.000Z', adapter: runtime, finalize: true,
        d1Runtime: controller,
      })
      expect(outcome).toMatchObject({ ok: false, code: 'D1_FINALIZATION_FENCE_FAILED' })
      expect(modelCalls).toBe(1)
      expect(await adapter.query<{ status: string }>('SELECT status FROM message_queue WHERE id = 1')).toEqual([{ status: 'done' }])
      expect(await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_claims')).toEqual([{ count: 0 }])
    } finally {
      await adapter.close()
    }
  })

  test('runtime-v2 performs one authorized GitHub writeback and persists its exact receipt', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      const writeback: QueueWorkGithubIssueCommentWriteback = {
        mode: 'github_issue_comment',
        repo: 'watchout/agent-comms-mcp',
        issue_number: 887,
        body: '<!-- aun:technical-check/v1 -->\nrepo: watchout/agent-comms-mcp\nissue: 887\nrole: check\nsource_queue_id: 1\nsource_message_id: message-canary\nverdict: PASS',
      }
      await adapter.execute(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 1, $4)`,
        [
          'dev-001',
          'message-canary',
          JSON.stringify({
            content: 'check handoff https://github.com/watchout/agent-comms-mcp/issues/887',
            message_type: 'phase_handoff',
            reply_contract: { required: false },
            shirube_v4_d1: binding(['github_writeback']),
          }),
          '2026-07-21T08:00:00.000Z',
        ],
      )
      const runtime: LlmRuntimeAdapter = {
        runtime_id: 'fixture',
        capabilities: {
          input: 'stdin_context', output: 'schema_json', supportsBareMode: true,
          supportsResume: false, supportsToolAllowlist: false, supportsSandbox: true,
          supportsUsageMetadata: false,
        },
        async invoke() {
          return {
            schema_version: QUEUE_WORK_RESULT_VERSION,
            ok: true,
            summary: 'canary complete',
            evidence: ['semantic_outcome=close', 'outcome_reason=canary_complete'],
            writeback,
            next_action: 'close',
          }
        },
      }
      let writebackEffects = 0
      let observedIdempotencyKey: string | null | undefined
      const controller = new ShirubeD1RuntimeController(adapter, { env: enabledEnv() })
      const outcome = await runAunRuntimeV2(db, {
        agentId: 'dev-001', queueId: 1, messageId: 'message-canary',
        createdAfter: '2026-07-21T07:59:00.000Z', adapter: runtime,
        finalize: true, d1Runtime: controller,
        writebackSender: {
          async sendWriteback(input) {
            await adapter.transaction(async () => undefined)
            writebackEffects += 1
            observedIdempotencyKey = input.writeback.idempotency_key
            return { posted_with: 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-canary' }
          },
        },
      })
      expect(outcome).toMatchObject({
        ok: true,
        code: 'E2E_DONE',
        plan: { live_activation: true },
        shirube_v4_d1: {
          enabled: true,
          queue_id: '1',
          effect_delivery_performed: true,
          durable_receipts: [{
            effect: 'github_writeback',
            receipt: 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-canary',
          }],
          duplicate_effects: 0,
        },
      })
      expect(writebackEffects).toBe(1)
      expect(observedIdempotencyKey).toBe(`d1-canary:agent-comms-mcp:887:${'a'.repeat(40)}`)
      expect(await adapter.query<{ status: string; receipt: string }>(
        'SELECT status, receipt FROM shirube_d1_effect_deliveries',
      )).toEqual([{
        status: 'completed',
        receipt: 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-canary',
      }])
      expect(await adapter.query<{ status: string }>('SELECT status FROM message_queue WHERE id = 1')).toEqual([{ status: 'replied' }])

      const replayed = await runAunRuntimeV2(db, {
        agentId: 'dev-001', queueId: 1, messageId: 'message-canary',
        createdAfter: '2026-07-21T07:59:00.000Z', finalize: true, d1Runtime: controller,
        adapter: {
          runtime_id: 'must-not-rerun',
          capabilities: {
            input: 'stdin_context', output: 'schema_json', supportsBareMode: true,
            supportsResume: false, supportsToolAllowlist: false, supportsSandbox: true,
            supportsUsageMetadata: false,
          },
          async invoke() { throw new Error('completed D1 work must not rerun the model') },
        },
        writebackSender: {
          async sendWriteback() {
            writebackEffects += 1
            throw new Error('completed D1 work must not repost')
          },
        },
      })
      expect(replayed).toMatchObject({
        ok: true,
        code: 'E2E_DONE',
        finalizer: { code: 'ALREADY_REPLIED' },
        shirube_v4_d1: {
          durable_receipts: [{
            receipt: 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-canary',
          }],
          duplicate_effects: 0,
        },
      })
      expect(writebackEffects).toBe(1)

      const killed = new ShirubeD1RuntimeController(adapter, { env: enabledEnv(true) })
      expect(await killed.effectReadback('1')).toMatchObject({
        enabled: false,
        effect_delivery_performed: true,
        durable_receipts: [{ receipt: 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-canary' }],
      })
      const beforeRollbackCounts = await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_claims')
      await expect(killed.beforeClaim({
        id: 2,
        agent_id: 'dev-001',
        message_id: 'message-after-kill',
        payload: JSON.stringify({ shirube_v4_d1: binding() }),
        status: 'pending',
      })).rejects.toMatchObject({ code: 'D1_KILL_SWITCH_ACTIVE' })
      expect(await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_claims')).toEqual(beforeRollbackCounts)
    } finally {
      await adapter.close()
    }
  })

  test('runtime-v2 internal reply selects exactly one port outside the queue lock', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      await adapter.execute(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 1, $4)`,
        ['dev-001', 'message-internal', JSON.stringify({
          content: 'internal reply fixture', author_id: 'qa', reply_contract: { required: true },
          shirube_v4_d1: binding(['internal_reply']),
        }), '2026-07-21T08:00:00.000Z'],
      )
      let effects = 0
      const controller = new ShirubeD1RuntimeController(adapter, { env: enabledEnv() })
      const outcome = await runAunRuntimeV2(db, {
        agentId: 'dev-001', queueId: 1, messageId: 'message-internal',
        createdAfter: '2026-07-21T07:59:00.000Z', finalize: true, d1Runtime: controller,
        adapter: {
          runtime_id: 'fixture',
          capabilities: { input: 'stdin_context', output: 'schema_json', supportsBareMode: true, supportsResume: false, supportsToolAllowlist: false, supportsSandbox: true, supportsUsageMetadata: false },
          async invoke() { return { schema_version: QUEUE_WORK_RESULT_VERSION, ok: true, summary: 'reply', reply: 'done', evidence: ['semantic_outcome=reply', 'outcome_reason=done'], next_action: 'reply' } },
        },
        replySender: {
          async sendReply() {
            await adapter.transaction(async () => undefined)
            effects += 1
            return { message_id: 'internal-message-receipt' }
          },
        },
      })
      expect(outcome).toMatchObject({ ok: true, code: 'E2E_DONE', shirube_v4_d1: { effect_delivery_performed: true } })
      expect(effects).toBe(1)
      expect(await adapter.query<{ effect: string; internal_reply_receipt: string }>(
        'SELECT effect, internal_reply_receipt FROM shirube_d1_invocations',
      )).toEqual([{ effect: 'internal_reply', internal_reply_receipt: 'internal-message-receipt' }])
    } finally {
      await adapter.close()
    }
  })

  test('runtime-v2 external reply enqueues one EventLog outbox record and performs no provider call', async () => {
    const { adapter, db } = sqliteFixture()
    try {
      await ensureEventLogSchema(adapter)
      const externalBinding = binding(['external_send'])
      const key = computeShirubeD1InvocationKey(externalBinding, '1', 'external_send')
      const fixture = makeDeliveryFixture('provider_ack', 'shirube-d1', 'fixture-mcp', `d1:${key}`)
      externalBinding.external_event = {
        eventId: `d1:reply-enqueued:${key}`,
        eventType: 'reply.enqueued',
        seatId: fixture.unit.sender_seat_id,
        conversationId: fixture.unit.conversation_id,
        causationId: fixture.unit.causation_id,
        correlationId: fixture.unit.correlation_id,
        turnId: fixture.unit.turn_id,
        replyId: `d1:${key}`,
        payload: fixture.unit,
        loaded_registration: fixture.registration,
      }
      await adapter.execute(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 1, $4)`,
        ['dev-001', 'message-external', JSON.stringify({
          content: 'external reply fixture', author_id: 'external-target', reply_contract: { required: true },
          shirube_v4_d1: externalBinding,
        }), '2026-07-21T08:00:00.000Z'],
      )
      const controller = new ShirubeD1RuntimeController(adapter, { env: enabledEnv() })
      const outcome = await runAunRuntimeV2(db, {
        agentId: 'dev-001', queueId: 1, messageId: 'message-external',
        createdAfter: '2026-07-21T07:59:00.000Z', finalize: true, d1Runtime: controller,
        adapter: {
          runtime_id: 'fixture',
          capabilities: { input: 'stdin_context', output: 'schema_json', supportsBareMode: true, supportsResume: false, supportsToolAllowlist: false, supportsSandbox: true, supportsUsageMetadata: false },
          async invoke() { return { schema_version: QUEUE_WORK_RESULT_VERSION, ok: true, summary: 'external', reply: fixture.unit.content.text, evidence: ['semantic_outcome=reply', 'outcome_reason=external'], next_action: 'reply' } },
        },
      })
      expect(outcome).toMatchObject({ ok: true, code: 'E2E_DONE' })
      expect(await adapter.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM event_log WHERE event_type = 'reply.enqueued' AND reply_id = $1`,
        [`d1:${key}`],
      )).toEqual([{ count: 1 }])
      expect(await adapter.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM event_log WHERE event_type IN ('reply.provider_nonce_reserved','reply.provider_invocation_started','reply.delivered')`,
      )).toEqual([{ count: 0 }])
    } finally {
      await adapter.close()
    }
  })
})
