import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ACCEPTANCE, PROFILE_NAMES, SPECIMEN_IDS } from '../../benchmarks/aun-k0/profiles'

function json<T = any>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T
}

const eventSchema = json(new URL('../../schemas/aun-k0-event-vocabulary-v1.schema.json', import.meta.url))
const deliverySchema = json(new URL('../../schemas/aun-k0-delivery-vocabulary-v1.schema.json', import.meta.url))
const dbSchema = json(new URL('../../schemas/aun-k0-db-capabilities-v1.schema.json', import.meta.url))
const benchmarkSchema = json(new URL('../../schemas/aun-k0-benchmark-result-v1.schema.json', import.meta.url))
const eventVocabulary = json(new URL('../fixtures/aun-k0/event-vocabulary-v1.json', import.meta.url))
const deliveryVocabulary = json(new URL('../fixtures/aun-k0/delivery-vocabulary-v1.json', import.meta.url))
const postgres = json(new URL('../fixtures/aun-k0/db-capabilities-postgresql-v1.json', import.meta.url))
const sqlite = json(new URL('../fixtures/aun-k0/db-capabilities-sqlite-v1.json', import.meta.url))
const acceptance = json(new URL('../fixtures/aun-k0/acceptance-v1.json', import.meta.url))

describe('AUN K0 machine contracts', () => {
  test('all four JSON schemas are strict, parseable draft-2020-12 contracts', () => {
    for (const schema of [eventSchema, deliverySchema, dbSchema, benchmarkSchema]) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(schema.required.length).toBeGreaterThan(0)
    }
  })

  test('event vocabulary closes timeout, fencing, collision, and authority ambiguity', () => {
    expect(eventVocabulary.schema_version).toBe('aun-k0-event-vocabulary/v1')
    expect(eventVocabulary.authority).toBe('postgresql_event_log')
    expect(eventVocabulary.events.map((event: any) => event.event_type)).toEqual([
      'message.received',
      'turn.claimed',
      'turn.started',
      'turn.attempt_failed',
      'turn.retry_scheduled',
      'turn.blocked',
      'turn.dead_lettered',
      'turn.completed',
    ])
    expect(eventVocabulary.events.find((event: any) => event.event_type === 'turn.completed').writer_authority)
      .toBe('current_fencing_token_holder')
    expect(eventVocabulary.invariants).toContain('runtime_timeout_is_not_semantic_completion')
    expect(eventVocabulary.invariants).toContain('same_event_id_different_canonical_payload_is_collision')
  })

  test('delivery vocabulary distinguishes placement from provider receipt', () => {
    const byType = new Map(deliveryVocabulary.events.map((event: any) => [event.event_type, event]))
    expect(byType.get('reply.handoff_accepted').proof_tier).toBe('durable_queue_receipt')
    expect(byType.get('reply.handoff_accepted').terminal).toBe(false)
    expect(byType.get('reply.delivered').proof_tier).toBe('provider_receipt')
    expect(deliveryVocabulary.invariants).toContain('provider_without_receipt_never_emits_delivered')
    expect(deliveryVocabulary.guarantees.external_effect)
      .toBe('effectively_once_only_with_end_to_end_idempotency')
  })

  test('DbCapabilities names PostgreSQL authority and fails SQLite concurrency closed', () => {
    expect(postgres.database).toBe('postgresql')
    expect(postgres.production_authority).toBe(true)
    expect(postgres.capabilities.skip_locked).toBe(true)
    expect(postgres.capabilities.multi_worker_concurrency).toBe(true)

    expect(sqlite.database).toBe('sqlite')
    expect(sqlite.profile).toBe('unit_conformance')
    expect(sqlite.production_authority).toBe(false)
    expect(sqlite.capabilities.skip_locked).toBe(false)
    expect(sqlite.capabilities.multi_worker_concurrency).toBe(false)
    expect(sqlite.unsupported).toContain('multi_worker_concurrency')
    expect(sqlite.fail_closed).toBe(true)
  })

  test('all 15 owner acceptance IDs appear exactly once with no unknown profiles or unmapped predicates', () => {
    const expected = ACCEPTANCE.map(([id]) => id)
    const actual = acceptance.acceptance.map((entry: any) => entry.id)
    expect(actual).toEqual(expected)
    expect(new Set(actual).size).toBe(15)
    expect(acceptance.acceptance.every((entry: any) => entry.predicate.length > 0)).toBe(true)
    expect(acceptance.acceptance.every((entry: any) => entry.specimen_ids.length > 0)).toBe(true)
    expect(acceptance.acceptance.every((entry: any) => PROFILE_NAMES.includes(entry.profile))).toBe(true)
    const knownSpecimens = new Set(SPECIMEN_IDS)
    expect(acceptance.acceptance.flatMap((entry: any) => entry.specimen_ids)
      .every((id: string) => knownSpecimens.has(id as any))).toBe(true)
  })
})
