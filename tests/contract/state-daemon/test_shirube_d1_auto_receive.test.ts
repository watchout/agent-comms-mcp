import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RuntimeV2ShirubeD1AutoReceiveDispatcher,
  SHIRUBE_D1_AUTO_RECEIVE_SOURCE,
} from '../../../bin/state-daemon'
import { computeD1AuthorizationDigest } from '../../../core/shirube-d1-execution-adapter'
import {
  SHIRUBE_D1_RUNTIME_BINDING_VERSION,
  computeShirubeD1InvocationKey,
  type ShirubeD1RuntimeBinding,
} from '../../../core/shirube-d1-runtime'
import { StateDaemon } from '../../../core/state-daemon'
import { migrateSqlite } from '../../../db/migrate-sqlite'
import { SqliteAdapter } from '../../../core/db/sqlite-adapter'
import { toLegacy } from '../../../core/db/adapter'
import { ensureEventLogSchema } from '../../../core/eventlog'
import { makeDeliveryFixture } from '../../aun-k3/delivery-fixture'
import { FakeAlertSink, FakeClock, FakeMetrics, FakePgListen, FakeTmux } from './fakes'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function authorization() {
  const unsigned = {
    control_source: 'https://github.com/watchout/ai-dev-framework/issues/556',
    handoff_id: 'CH-ACM-887-D1-AUTO-RECEIVE-CORRECTIVE-001',
    exact_base_sha: 'b8da4fe8e938016f4a5329f2851e7b34b393c4e1',
    allowed_paths: [
      'bin/state-daemon.ts',
      'core/state-daemon/index.ts',
      'core/state-daemon/types.ts',
      'core/shirube-d1-runtime.ts',
      'tests/state-daemon-queue-work-scheduler.test.ts',
      'tests/shirube-d1-runtime.test.ts',
      'tests/contract/state-daemon/test_shirube_d1_auto_receive.test.ts',
      'docs/operations/shirube-v4-d1-runtime.md',
    ],
  }
  return { ...unsigned, authorization_digest: computeD1AuthorizationDigest(unsigned) }
}

function evidence() {
  return {
    adapter_head_sha: 'a'.repeat(40),
    independent_audit_ref: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-audit',
    qa_ref: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-qa',
    check_ref: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-check',
    cto_go_ref: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-cto',
  }
}

function envFor(path: string, binding: ShirubeD1RuntimeBinding): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: path,
    SHIRUBE_D1_ENABLED: '1',
    SHIRUBE_D1_KILL_SWITCH: '0',
    SHIRUBE_D1_TARGET_ALLOWLIST: JSON.stringify([binding.target]),
    SHIRUBE_D1_AUTHORIZATION_DIGEST: binding.authorization.authorization_digest,
    SHIRUBE_D1_ADAPTER_HEAD_SHA: binding.activation_evidence.adapter_head_sha,
    SHIRUBE_D1_AUDIT_REF: binding.activation_evidence.independent_audit_ref,
    SHIRUBE_D1_QA_REF: binding.activation_evidence.qa_ref,
    SHIRUBE_D1_CHECK_REF: binding.activation_evidence.check_ref,
    SHIRUBE_D1_CTO_GO_REF: binding.activation_evidence.cto_go_ref,
    // Production defaults to codex-exec. This fixture explicitly selects a
    // deterministic command adapter so it proves transport/exact-once, not
    // model quality, while still traversing the real runtime-v2 adapter seam.
    STATE_DAEMON_SHIRUBE_D1_RUNTIME: 'command-json',
    AUN_QUEUE_WORK_COMMAND: 'bun',
    AUN_QUEUE_WORK_ARGS_JSON: JSON.stringify(['-e', [
      "await Bun.stdin.text();",
      "process.stdout.write(JSON.stringify({",
      "schema_version:'queue_work_result_v1',ok:true,summary:'auto receive fixture',",
      "reply:'hello-shirube-d1-auto',",
      "evidence:['semantic_outcome=reply','outcome_reason=auto_receive_fixture'],",
      "next_action:'reply'",
      "}))",
    ].join('')]),
  } as NodeJS.ProcessEnv
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe('Shirube D1 state-daemon queue-arrival auto-receive', () => {
  test('queue notification alone performs one claim, invocation, external effect, receipt, and finalization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shirube-d1-auto-receive-'))
    tempDirs.push(dir)
    const path = join(dir, 'agent-com.db')
    const previousDbType = process.env.AGENT_COM_DB
    const previousDbPath = process.env.AGENT_COM_SQLITE_PATH
    process.env.AGENT_COM_DB = 'sqlite'
    process.env.AGENT_COM_SQLITE_PATH = path
    migrateSqlite(path)
    const db = new SqliteAdapter(path)
    await ensureEventLogSchema(db)
    await db.execute('ALTER TABLE message_queue ADD COLUMN last_wake_attempt_at TEXT')

    const target = {
      repository: 'watchout/agent-comms-mcp',
      agent_id: 'dev-001',
      control_source: authorization().control_source,
    }
    const binding: ShirubeD1RuntimeBinding = {
      schema_version: SHIRUBE_D1_RUNTIME_BINDING_VERSION,
      target,
      authorization: authorization(),
      activation_evidence: evidence(),
      allowed_effects: ['external_send'],
    }
    const invocationKey = computeShirubeD1InvocationKey(binding, '1', 'external_send')
    const delivery = makeDeliveryFixture('provider_ack', 'shirube-d1-auto', 'fixture-mcp', `d1:${invocationKey}`)
    binding.external_event = {
      eventId: `d1:reply-enqueued:${invocationKey}`,
      eventType: 'reply.enqueued',
      seatId: delivery.unit.sender_seat_id,
      conversationId: delivery.unit.conversation_id,
      causationId: delivery.unit.causation_id,
      correlationId: delivery.unit.correlation_id,
      turnId: delivery.unit.turn_id,
      replyId: `d1:${invocationKey}`,
      payload: delivery.unit,
      loaded_registration: delivery.registration,
    }

    await db.execute(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
       VALUES ($1, $2, $3, 'pending', 1, $4)`,
      ['dev-001', 'message-auto-receive', JSON.stringify({
        content: delivery.unit.content.text,
        author_id: 'external-target',
        message_type: 'phase_handoff',
        reply_contract: { required: true },
        shirube_v4_d1: binding,
      }), '2026-07-23T00:00:00.000Z'],
    )

    const env = envFor(path, binding)
    const metrics = new FakeMetrics()
    const alerts = new FakeAlertSink()
    const listen = new FakePgListen()
    const legacyDb = toLegacy(db)
    const daemon = new StateDaemon({
      db: {
        query: (sql, params) => legacyDb.query(sql.replace('am.id::text', 'CAST(am.id AS TEXT)'), params),
      },
      pgListen: listen,
      tmux: new FakeTmux(),
      clock: new FakeClock('2026-07-23T00:00:01.000Z'),
      metrics,
      alert: alerts,
      shirubeD1AutoReceive: new RuntimeV2ShirubeD1AutoReceiveDispatcher(env, join(import.meta.dir, '..', '..', '..')),
    })

    await daemon.start()
    try {
      const event = JSON.stringify({
        op: 'INSERT', id: 1, agent_id: 'dev-001', status: 'pending', claim_expires_at: null,
      })
      // No receive/runtime-v2/runner/finalizer call is made by the fixture.
      // Duplicate delivery is deliberate: the daemon must coalesce it.
      listen.emit(event)
      listen.emit(event)
      try {
        await waitFor(async () => (
          (await db.queryOne<{ status: string }>('SELECT status FROM message_queue WHERE id = 1'))?.status === 'replied'
        ), 3_000)
      } catch {
        const row = await db.queryOne<{ status: string; payload: string }>('SELECT status, payload FROM message_queue WHERE id = 1')
        throw new Error(JSON.stringify({ row, alerts: alerts.alerts, metrics: metrics.calls }))
      }

      expect(await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_claims')).toEqual([{ count: 1 }])
      expect(await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_invocations')).toEqual([{ count: 1 }])
      expect(await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM shirube_d1_effect_deliveries')).toEqual([{ count: 1 }])
      expect(await db.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM event_log WHERE event_type = 'reply.enqueued' AND reply_id = $1`,
        [`d1:${invocationKey}`],
      )).toEqual([{ count: 1 }])
      expect(await db.query<{ status: string; receipt: string }>(
        'SELECT status, receipt FROM shirube_d1_effect_deliveries',
      )).toEqual([{ status: 'completed', receipt: `d1:${invocationKey}` }])
      expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'started' })).toBe(1)
      expect(metrics.countInc('state_daemon_shirube_d1_auto_receive_total', { result: 'terminal', code: 'E2E_DONE' })).toBe(1)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'routing_non_actionable_held' })).toBe(0)
      expect(alerts.alerts).toEqual([])
    } finally {
      await daemon.stop()
      await db.close()
      if (previousDbType === undefined) delete process.env.AGENT_COM_DB
      else process.env.AGENT_COM_DB = previousDbType
      if (previousDbPath === undefined) delete process.env.AGENT_COM_SQLITE_PATH
      else process.env.AGENT_COM_SQLITE_PATH = previousDbPath
    }
  }, 10_000)
})
