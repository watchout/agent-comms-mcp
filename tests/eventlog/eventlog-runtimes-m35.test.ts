// V2 cutover M3.5 fixtures — engine adapters (codex exec / claude -p).
//
// Pins engine SYMMETRY: both adapters bind the same TurnRuntime seam,
// enforce the same strict v2_turn_result_v1 contract, and fail closed on
// every deviation (nonzero exit, wrapper error, malformed or fabricated
// output). No real API calls — the invoker seam injects canned processes.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { ensureEventLogSchema, receiveMessage } from '../../core/eventlog'
import { runSeatWorkerOnce } from '../../core/eventlog/worker'
import {
  buildTurnPrompt,
  claudeCodeRuntime,
  codexExecRuntime,
  parseTurnResult,
  runtimeForEngine,
  type HeadlessInvoker,
} from '../../core/eventlog/runtimes'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-m35-'))
  db = new SqliteAdapter(join(dir, 'v2.db'))
  await ensureEventLogSchema(db)
  await receiveMessage(db, {
    messageId: 'm1', seatId: 'kodama', conversationId: 'chan-1',
    payload: { channel_id: 'chan-1', author_id: 'ceo', content: '状況教えて' },
  })
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

function canned(result: { exitCode: number; stdout: string; stderr?: string }): HeadlessInvoker & { cmds: string[][] } {
  const invoker = {
    cmds: [] as string[][],
    async run(cmd: string[]) {
      invoker.cmds.push(cmd)
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' }
    },
  }
  return invoker
}

const GOOD = '{"ok":true,"outcome":"replied","reply":"了解です"}'

describe('strict result contract (shared by both engines)', () => {
  test('accepts exactly the contract shape; rejects everything else', () => {
    expect(parseTurnResult(GOOD)?.reply).toBe('了解です')
    expect(parseTurnResult('{"ok":true,"outcome":"no_reply","reply":null}')?.outcome).toBe('no_reply')
    // fail-closed cases
    expect(parseTurnResult('not json')).toBeNull()
    expect(parseTurnResult('{"ok":true,"outcome":"replied"}')).toBeNull() // missing key
    expect(parseTurnResult('{"ok":true,"outcome":"replied","reply":null}')).toBeNull() // replied without text
    expect(parseTurnResult('{"ok":true,"outcome":"exfiltrate","reply":"x"}')).toBeNull() // unknown outcome
    expect(parseTurnResult('{"ok":true,"outcome":"no_reply","reply":null,"extra":1}')).toBeNull() // extra key
    // audit 4930621767: ok:false is the model asserting failure — REJECTED
    // even with an otherwise perfect shape; it must never become a reply
    expect(parseTurnResult('{"ok":false,"outcome":"replied","reply":"偽の成功"}')).toBeNull()
    expect(parseTurnResult('{"ok":false,"outcome":"no_reply","reply":null}')).toBeNull()
  })
})

describe('codex exec adapter', () => {
  test('happy path: schema-constrained invocation → replied turn', async () => {
    const invoker = canned({ exitCode: 0, stdout: `thread started\n${GOOD}\n` })
    const runtime = codexExecRuntime({ db, invoker, schemaPath: '/tmp/schema.json' })
    const r = await runSeatWorkerOnce(db, { seatId: 'kodama', seatInstanceId: 'w1', runtime })
    expect(r.completed).toBe(1)
    expect(invoker.cmds[0]).toContain('--output-schema')
    expect(invoker.cmds[0][0]).toBe('codex')
  })

  test('nonzero exit → terminal failed, never a fabricated reply', async () => {
    const runtime = codexExecRuntime({ db, invoker: canned({ exitCode: 1, stdout: '', stderr: 'boom' }), schemaPath: '/tmp/s.json' })
    const r = await runSeatWorkerOnce(db, { seatId: 'kodama', seatInstanceId: 'w1', runtime })
    expect(r.failed).toBe(1)
    const replies = await db.query(`SELECT * FROM event_log WHERE event_type = 'reply.enqueued'`)
    expect(replies.length).toBe(0)
  })
})

describe('claude -p adapter', () => {
  test('happy path: wrapper JSON with contract result → replied turn', async () => {
    const wrapper = JSON.stringify({ type: 'result', is_error: false, result: GOOD })
    const invoker = canned({ exitCode: 0, stdout: wrapper })
    const runtime = claudeCodeRuntime({ db, invoker })
    const r = await runSeatWorkerOnce(db, { seatId: 'kodama', seatInstanceId: 'w1', runtime })
    expect(r.completed).toBe(1)
    expect(invoker.cmds[0][0]).toBe('claude')
    expect(invoker.cmds[0]).toContain('--output-format')
    const enq = await db.query<{ payload: string }>(`SELECT payload FROM event_log WHERE event_type = 'reply.enqueued'`)
    expect(JSON.parse(enq[0].payload).content).toBe('了解です')
    expect(JSON.parse(enq[0].payload).channel_external_id).toBe('chan-1')
  })

  test('wrapper is_error → failed; malformed inner result → failed (fail-closed)', async () => {
    const errWrapper = JSON.stringify({ type: 'result', is_error: true, result: 'API error' })
    let r = await runSeatWorkerOnce(db, {
      seatId: 'kodama', seatInstanceId: 'w1',
      runtime: claudeCodeRuntime({ db, invoker: canned({ exitCode: 0, stdout: errWrapper }) }),
    })
    expect(r.failed).toBe(1)

    await receiveMessage(db, { messageId: 'm2', seatId: 'kodama', conversationId: 'chan-1' })
    const badInner = JSON.stringify({ type: 'result', is_error: false, result: 'ここに返事を書きます' })
    r = await runSeatWorkerOnce(db, {
      seatId: 'kodama', seatInstanceId: 'w2',
      runtime: claudeCodeRuntime({ db, invoker: canned({ exitCode: 0, stdout: badInner }) }),
    })
    expect(r.failed).toBe(1)
  })
})

describe('engine symmetry', () => {
  test('runtimeForEngine selects by seat configuration, same seam both ways', async () => {
    const claudeInvoker = canned({ exitCode: 0, stdout: JSON.stringify({ is_error: false, result: GOOD }) })
    const viaClaude = runtimeForEngine('claude-code', { db, schemaPath: '/tmp/s.json', invoker: claudeInvoker })
    const r1 = await runSeatWorkerOnce(db, { seatId: 'kodama', seatInstanceId: 'w1', runtime: viaClaude })
    expect(r1.completed).toBe(1)
    expect(claudeInvoker.cmds[0][0]).toBe('claude')

    await receiveMessage(db, { messageId: 'm2', seatId: 'kodama', conversationId: 'chan-1' })
    const codexInvoker = canned({ exitCode: 0, stdout: GOOD })
    const viaCodex = runtimeForEngine('codex', { db, schemaPath: '/tmp/s.json', invoker: codexInvoker })
    const r2 = await runSeatWorkerOnce(db, { seatId: 'kodama', seatInstanceId: 'w2', runtime: viaCodex })
    expect(r2.completed).toBe(1)
    expect(codexInvoker.cmds[0][0]).toBe('codex')
  })

  test('prompt carries the inbound envelope for either engine', async () => {
    const prompt = buildTurnPrompt('kodama', { channel_id: 'chan-1', author_id: 'ceo', content: '状況教えて' })
    expect(prompt).toContain('状況教えて')
    expect(prompt).toContain('ceo')
    expect(prompt).toContain('"no_reply"')
  })
})

describe('ok:false fail-closed (audit 4930621767)', () => {
  test('an ok:false result terminal-closes as failed with ZERO replies enqueued — both engines', async () => {
    const okFalse = '{"ok":false,"outcome":"replied","reply":"偽の成功"}'
    // codex path
    let r = await runSeatWorkerOnce(db, {
      seatId: 'kodama', seatInstanceId: 'w1',
      runtime: codexExecRuntime({ db, invoker: canned({ exitCode: 0, stdout: okFalse }), schemaPath: '/tmp/s.json' }),
    })
    expect(r.failed).toBe(1)
    // claude path
    await receiveMessage(db, { messageId: 'm2', seatId: 'kodama', conversationId: 'chan-1' })
    r = await runSeatWorkerOnce(db, {
      seatId: 'kodama', seatInstanceId: 'w2',
      runtime: claudeCodeRuntime({ db, invoker: canned({ exitCode: 0, stdout: JSON.stringify({ is_error: false, result: okFalse }) }) }),
    })
    expect(r.failed).toBe(1)
    const replies = await db.query(`SELECT * FROM event_log WHERE event_type = 'reply.enqueued'`)
    expect(replies.length).toBe(0)
    const completions = await db.query<{ payload: string }>(
      `SELECT payload FROM event_log WHERE event_type = 'turn.completed'`,
    )
    expect(completions.length).toBe(2)
    for (const c of completions) expect(JSON.parse(c.payload).outcome).toBe('failed')
  })
})
