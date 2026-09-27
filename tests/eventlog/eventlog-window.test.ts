import { beforeEach, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { EventLog, ensureEventLogSchema, frozenEnabledSetSha256, runtimeSnapshotSha256, decodeV2NativeInboundPayload, parseEventPayload, type AppendEvent } from '../../core/eventlog'
import { v2Send, v2Status, v2WindowFailure, type V2WindowContext } from '../../core/eventlog/window'
import { runSeatWorkerOnce } from '../../core/eventlog/worker'

const agents = ['alpha', 'beta'].map(agent_id => ({ agent_id, profile_revision: '1', runtime_engine: 'fixture', runtime_instance_id: agent_id, runtime_checkout_root: '/fixture', runtime_checkout_sha: 'a'.repeat(40) }))
let db: SqliteAdapter, dir: string, c: V2WindowContext
const input = (key = 'key') => ({ to: 'beta', conversation_id: null as string | null, idempotency_key: key, content: 'hello', refs: { principal_ref: 'p', pack_digest: 'd', approval_ref: 'a', onza_run_id: 'run1' } })
const code = async (work: Promise<unknown>) => { try { await work; return 'UNEXPECTED_SUCCESS' } catch (e) { return v2WindowFailure(e).code } }
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'window-')); db = new SqliteAdapter(join(dir, 'db')); await ensureEventLogSchema(db)
  const scope = { schema_version: 'aun-v2-native-mesh-scope/v1', run_id: 'run1', stage_id: 'S0_IMPLEMENTATION', repository: 'watchout/agent-comms-mcp', exact_implementation_head: 'b'.repeat(40), database_identity: 'isolated', frozen_enabled_set: agents, frozen_enabled_set_sha256: frozenEnabledSetSha256(agents), runtime_snapshot_sha256: runtimeSnapshotSha256(agents), provider_dispatch: 'disabled', V1_mode: 'observe_only_no_traversal', deadline_ms: Date.now() + 60000 }
  c = { agentId: 'alpha', scope, nowMs: Date.now(), fence: { stage_id: 'S0_IMPLEMENTATION', exact_implementation_head: scope.exact_implementation_head, database_identity: scope.database_identity, runtime_snapshot_sha256: scope.runtime_snapshot_sha256 } }
})
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }) })

test('native send is idempotent, content/refs collisions roll back, invalid refs/identity/route have zero effects', async () => {
  for (const bad of [undefined, {}, { ...input().refs, pack_digest: '' }, { ...input().refs, approval_ref: 1 }]) {
    expect(await code(v2Send(db, c, { ...input(), refs: bad }))).toBe('REJECTED_INPUT')
    expect(await new EventLog(db).count()).toBe(0)
  }
  expect(await code(v2Send(db, { ...c, agentId: 'outside' }, input()))).toBe('REJECTED_IDENTITY')
  expect(await code(v2Send(db, c, { ...input(), to: 'outside' }))).toBe('REJECTED_ROUTE')
  expect(await code(v2Send(db, c, { ...input(), agent_id: 'beta' }))).toBe('REJECTED_INPUT')
  expect(await new EventLog(db).count()).toBe(0)
  const sent = await v2Send(db, c, input()); expect(await v2Send(db, c, input())).toEqual(sent)
  expect(await new EventLog(db).count()).toBe(2)
  for (const changed of [{ ...input(), content: 'changed' }, { ...input(), refs: { ...input().refs, onza_run_id: 'run2' } }]) {
    expect(await code(v2Send(db, c, changed))).toBe('CONFLICT'); expect(await new EventLog(db).count()).toBe(2)
  }
  const received = await new EventLog(db).getByEventId(sent.event_id)
  expect(decodeV2NativeInboundPayload(parseEventPayload(received!.payload)).content).toBe('hello')
  expect(parseEventPayload(received!.payload)).not.toHaveProperty('refs')
  expect(await code(v2Status(db, { ...c, agentId: 'beta' }, { conversation_id: sent.conversation_id }))).toBe('REJECTED_SCOPE')
})
test('refs survive worker tick and DB reopen; another run appends a second link', async () => {
  const sent = await v2Send(db, c, input()), before = await v2Status(db, c, { conversation_id: sent.conversation_id })
  await runSeatWorkerOnce(db, { seatId: 'beta', seatInstanceId: 'fixture', maxTurns: 1, runtime: { runTurn: async () => ({ outcome: 'replied', replies: [{ content: 'reply' }] }) } })
  await db.close(); db = new SqliteAdapter(join(dir, 'db'))
  expect((await v2Status(db, c, { conversation_id: sent.conversation_id })).links).toEqual(before.links)
  await v2Send(db, c, { ...input('key2'), conversation_id: sent.conversation_id, refs: { ...input().refs, onza_run_id: 'run2' } })
  const after = await v2Status(db, c, { conversation_id: sent.conversation_id })
  expect(after.links.map(l => l.onza_run_id)).toEqual(['run1', 'run2']); expect(after.links[0]).toEqual(before.links[0])
  expect(after.states.map(s => s.state)).toContain('replied'); expect(after.claims.turn).toEqual([])
})
test('link conflict cannot leave a received event; DB failures are unobservable', async () => {
  await new EventLog(db).append({ eventId: 'link:key', eventType: 'conversation.linked', payload: { other: true } })
  expect(await code(v2Send(db, c, input()))).toBe('CONFLICT'); expect(await new EventLog(db).count()).toBe(1)
  expect((await v2Status(db, c, { conversation_id: 'absent' })).states).toEqual([])
  expect(await code(v2Status({ ...db, query: async () => { throw Error('offline') } } as any, c, { conversation_id: 'absent' }))).toBe('UNOBSERVABLE')
})
test('eight states preserve details, strict/legacy receipt modes and only current unexpired claims', async () => {
  const sent = await v2Send(db, c, input()), log = new EventLog(db)
  const put = async (id: string, eventType: AppendEvent['eventType'], payload = {}, turnId = id, replyId: string | null = null, claimEpoch = 0, causationId: string | null = null) => log.append({ eventId: id, eventType, payload, conversationId: sent.conversation_id, turnId, replyId, claimEpoch, causationId })
  await put('old', 'turn.claimed', {}, 't'); await put('new', 'turn.claimed', {}, 't', null, 1)
  await put('release-old', 'turn.claim_released', {}, 't'); await put('expired', 'turn.claimed', { lease_expires_at: new Date(c.nowMs - 1).toISOString() }, 'expired')
  await put('done', 'turn.completed', { outcome: 'replied' }, 'done'); await put('enq', 'reply.enqueued', {}, 'done', 'r', 0, 'done')
  await put('dc', 'reply.delivery_claimed', {}, 'done', 'r'); await put('legacy', 'reply.delivered', { transport_message_id: 'internal-uuid' }, 'done', 'r')
  const receipt = { reply_id: 'strict', delivery_id: 'strict', recipient_seat_id: 'beta', receipt_digest: 'a'.repeat(64), fanout_child_provenance_digest: null }
  await put('strict', 'reply.delivered', { ...receipt, provider_request_digest: 'b'.repeat(64), resolved_delivery_decision_digest: 'c'.repeat(64) }, 'strict', 'strict')
  await put('handoff', 'reply.handoff_accepted', { ...receipt, reply_id: 'handoff' }, 'handoff', 'handoff')
  await put('unknown', 'reply.delivery_unknown', { reconciliation_mode: 'none', attempt_ordinal: 0, invocation_started_event_id: 'start', provider_request_digest: 'd'.repeat(64) }, 'u', 'u')
  await put('failed', 'turn.attempt_failed', { failure_code: 'ENGINE_EXIT', retryable: true }, 'failed')
  await put('retry', 'turn.retry_scheduled', { available_at: 'later', backoff_ms: 1 }, 'failed')
  await put('dead', 'turn.dead_lettered', { reason_code: 'BUDGET', reason_summary: 'exhausted', attempt_count: 3 }, 'dead')
  await put('rf', 'reply.failed', { kind: 'permanent', reason: 'gone' }, 'rf', 'rf')
  const result = await v2Status(db, c, { conversation_id: sent.conversation_id })
  expect([...new Set(result.states.map(s => s.state))].sort()).toEqual(['claimed', 'delivered', 'failed', 'placed', 'queued', 'replied', 'terminal', 'unknown'])
  const row = (id: string) => result.states.find(s => s.event_id === id)!
  expect(result.claims.turn.map(c => c.event_id)).toEqual(['new']); expect(result.claims.delivery).toEqual([])
  expect(row('old').current).toBe(false); expect(row('legacy').receipt_mode).toBe('notify_accepted'); expect(row('strict').receipt_mode).toBe('provider_verified')
  expect(row('handoff').receipt_mode).toBe('internal'); expect(row('unknown').detail).toMatchObject({ failure_code: null, reconciliation_mode: 'none', terminal: false })
  expect(row('failed').detail).toMatchObject({ failure_code: 'ENGINE_EXIT', retryable: true, terminal: false })
  expect(row('retry').detail).toMatchObject({ available_at: 'later', backoff_ms: 1 }); expect(row('dead').detail).toMatchObject({ reason_code: 'BUDGET', reason_summary: 'exhausted', attempt_count: 3, terminal: true })
  expect(row('rf').detail).toMatchObject({ failure_code: 'gone', permanent: true, terminal: true }); expect(result.unprojected_replies).toBe(1)
})
