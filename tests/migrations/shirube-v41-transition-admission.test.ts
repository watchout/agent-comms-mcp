import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const up = read('db/migrations/2026-07-30-shirube-v41-transition-admission.up.sql')
const down = read('db/migrations/2026-07-30-shirube-v41-transition-admission.down.sql')
const persistence = read('core/shirube-v41-transition-persistence.ts')
const controller = read('core/shirube-v41-transition-controller.ts')
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

describe('Shirube V4.1 transition admission migration', () => {
  test('is additive, transactional, default-off, and creates every durable boundary', () => {
    expect(up.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(up.trimEnd().endsWith('COMMIT;')).toBe(true)
    for (const table of [
      'shirube_v41_plan_states',
      'shirube_v41_controller_adapters',
      'shirube_v41_destination_registry',
      'shirube_v41_transition_receipts',
      'shirube_v41_result_consumptions',
      'shirube_v41_transition_outbox',
      'shirube_v41_queue_projections',
      'shirube_v41_receipt_consumptions',
    ]) expect(up).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    expect(up).not.toMatch(/ALTER\s+TABLE\s+message_queue/i)
    expect(up).not.toMatch(/INSERT\s+INTO\s+shirube_v41_controller_adapters/i)
    expect(up).not.toMatch(/CREATE\s+TRIGGER/i)
    expect(up).not.toMatch(/CREATE\s+SEQUENCE/i)
  })

  test('refuses destructive rollback while any durable evidence remains', () => {
    const guard = down.indexOf('SHIRUBE_V41_ROLLBACK_REFUSED_DURABLE_EVIDENCE_PRESENT')
    const firstDrop = down.indexOf('DROP TABLE')
    expect(guard).toBeGreaterThan(0)
    expect(firstDrop).toBeGreaterThan(guard)
    for (const table of [
      'shirube_v41_transition_receipts',
      'shirube_v41_result_consumptions',
      'shirube_v41_transition_outbox',
      'shirube_v41_queue_projections',
      'shirube_v41_receipt_consumptions',
    ]) expect(down.slice(0, firstDrop)).toContain(`SELECT 1 FROM ${table}`)
  })

  test('controller state, receipt, result, and outbox share one transaction and exact CAS', () => {
    expect(persistence).toContain('db.transaction(async (tx) =>')
    expect(persistence).toContain('FOR UPDATE')
    expect(persistence).toContain('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    expect(persistence).toContain('AND plan_digest = $13 AND generation = $14 AND state_digest = $15')
    expect(persistence).toContain('SET next_receipt_revision = next_receipt_revision + 1')
    expect(persistence).toContain('shirube_v41_transition_receipts')
    expect(persistence).toContain('shirube_v41_result_consumptions')
    expect(persistence).toContain('shirube_v41_transition_outbox')
    expect(controller.indexOf('persistReceipt')).toBeLessThan(controller.indexOf('compareAndSwapState'))
    expect(controller.indexOf('compareAndSwapState')).toBeLessThan(controller.indexOf('persistResultConsumption'))
    expect(controller.indexOf('persistResultConsumption')).toBeLessThan(controller.indexOf('insertControllerOutbox'))
  })

  test('AUN performs local-first replay and atomically writes one queue and one projection', () => {
    const local = controller.indexOf('loadLocalConsumption')
    const authoritative = controller.indexOf('loadAuthoritativeReceipt')
    expect(local).toBeGreaterThan(0)
    expect(authoritative).toBeGreaterThan(local)
    expect(persistence).toContain('ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL')
    expect(persistence).not.toContain('ON CONFLICT (message_id)')
    expect(persistence).toContain('shirube_v41_queue_projections')
    expect(persistence).toContain('shirube_v41_receipt_consumptions')
    expect(persistence).not.toMatch(/fetch\(|axios|https?:\/\//)
  })

  test('pins the exact C4 schema and the composed 33-case fixture', () => {
    const schema = readFileSync(resolve(root, 'schemas/shirube/transition-admission-receipt.v2.schema.json'))
    const cases = readFileSync(resolve(root, 'tests/fixtures/shirube-v41-transition-admission/cases.json'))
    expect(schema.byteLength).toBe(8293)
    expect(sha256(schema)).toBe('0f167547e1b5851478f774e962dd4bed812888710d64a1f33801c127aee0e446')
    expect(cases.byteLength).toBe(5411)
    expect(sha256(cases)).toBe('70d28a8aa7c2faee51917f0f7c7f798c9a590c0f593ac9df16964c5a55158441')
    expect(controller).toContain("SHIRUBE_V41_C4_HEAD = 'de0cdf18907dfce5b01bdc76b68dad03a5865888'")
    expect(controller).toContain("SHIRUBE_V41_C4_TREE = 'ec79706df937026fe83a9de033ee51476ee0fee9'")
  })
})
