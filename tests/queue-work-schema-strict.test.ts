// Contract fixture for schemas/queue-work-result-v1.schema.json against the
// strict structured-output rule that the model API enforces at codex exec
// time (observed live in the CP80 canary, #846 2026-07-09):
//
//   every schema object that declares `properties` MUST supply `required`
//   as an array containing EVERY key in `properties`; optionality is
//   expressed via nullable types, never by omitting a key from `required`.
//
// The CP80 canary run failed with invalid_json_schema because
// properties.writeback listed 7 keys but required only 4 (evidence,
// idempotency_key, body_sha256 missing). This fixture pins the rule
// recursively so the schema can never regress into an API rejection again.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA_PATH = join(import.meta.dir, '..', 'schemas', 'queue-work-result-v1.schema.json')
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

function collectObjectNodes(node: unknown, path: string, out: Array<{ path: string; node: any }>): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  const n = node as any
  if (n.properties && typeof n.properties === 'object') {
    out.push({ path, node: n })
    for (const [key, child] of Object.entries(n.properties)) {
      collectObjectNodes(child, `${path}.properties.${key}`, out)
    }
  }
  if (n.items) collectObjectNodes(n.items, `${path}.items`, out)
  for (const combiner of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(n[combiner])) {
      n[combiner].forEach((child: unknown, i: number) =>
        collectObjectNodes(child, `${path}.${combiner}[${i}]`, out),
      )
    }
  }
}

describe('queue-work-result-v1 schema strict structured-output compliance', () => {
  const objectNodes: Array<{ path: string; node: any }> = []
  collectObjectNodes(schema, '$', objectNodes)

  test('schema has object nodes to check (sanity)', () => {
    expect(objectNodes.length).toBeGreaterThanOrEqual(2) // root + writeback
  })

  test('every object node lists ALL of its property keys in required', () => {
    for (const { path, node } of objectNodes) {
      const propertyKeys = Object.keys(node.properties).sort()
      const required = Array.isArray(node.required) ? [...node.required].sort() : null
      expect(required, `${path}: required must be an array (strict rule)`).not.toBeNull()
      expect(required, `${path}: required must include every key in properties`).toEqual(propertyKeys)
    }
  })

  test('writeback optional fields are expressed as nullable, not omitted from required', () => {
    const wb = schema.properties.writeback
    expect(wb.required).toContain('evidence')
    expect(wb.required).toContain('idempotency_key')
    expect(wb.required).toContain('body_sha256')
    expect(wb.properties.evidence.type).toEqual(['array', 'null'])
    expect(wb.properties.idempotency_key.type).toEqual(['string', 'null'])
    expect(wb.properties.body_sha256.type).toEqual(['string', 'null'])
  })
})

describe('runner-side validation accepts strict-mode (null-filled) results', () => {
  test('a writeback with explicit nulls for optional fields passes the queue-work validator', async () => {
    // strict mode makes the model emit every key, using null for absent
    // optional values — the TS validator must accept exactly that shape
    const { writebackLooksValid } = await import('../core/queue-work')
    expect(
      writebackLooksValid({
        mode: 'github_issue_comment',
        repo: 'watchout/agent-comms-mcp',
        issue_number: 846,
        body: 'status: ok',
        evidence: null,
        idempotency_key: null,
        body_sha256: null,
      }),
    ).toBe(true)
    // and malformed nulls still fail: body may never be null
    expect(
      writebackLooksValid({
        mode: 'github_issue_comment',
        repo: 'watchout/agent-comms-mcp',
        issue_number: 846,
        body: null,
        evidence: null,
        idempotency_key: null,
        body_sha256: null,
      }),
    ).toBe(false)
  })
})
