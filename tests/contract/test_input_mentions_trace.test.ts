import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Issue #266 (A) — input_mentions raw trace.
//
// PR #275 adds:
//   1. agent_messages.input_mentions TEXT[] column
//   2. send / notify MCP handlers persist the normalized recipient list, then
//      pass it through saveMessage.
//
// The value being pinned is "canonical agent_id mentions after normalization".
// Two angles are covered:
//
// (a) **Normalization semantics** — replicates the production pattern:
//     resolvePhase5(...) returns normalized/deduped mentions, then the handler
//     assigns that list to `rawInputMentions` for trace persistence.
//
// (b) **DB round-trip** (postgres only, gated on DATABASE_URL) — INSERTs
//     into agent_messages with input_mentions = NULL / [] / ['ceo'] and
//     SELECTs them back to confirm the column was added by migration and
//     stores TEXT[] verbatim.
//
// (c) **Source-shape grep** — fails fast if server.ts loses the
//     `rawInputMentions` snapshot or its propagation into saveMessage.

describe('input_mentions normalization semantics (Issue #266 (A); ADR-041 amendment 2026-05-27)', () => {
  function normalizedInputMentions(args: { mention?: string; mentions?: string[] }): string[] {
    const aliases: Record<string, string> = { cto: 'codex-cto' }
    const out: string[] = []
    for (const raw of [args.mention, ...(args.mentions ?? [])]) {
      if (!raw || raw.trim().length === 0) continue
      const normalized = aliases[raw.trim()] ?? raw.trim()
      if (!out.includes(normalized)) out.push(normalized)
    }
    return out
  }

  test('case A — explicit mention="ceo" persists as normalized recipient trace', () => {
    const rawInputMentions = normalizedInputMentions({ mention: 'ceo' })
    expect(rawInputMentions).toEqual(['ceo'])
  })

  test('case B — mentions[] dedupes and normalizes aliases', () => {
    const rawInputMentions = normalizedInputMentions({ mentions: ['ceo', 'cto', 'ceo'] })
    expect(rawInputMentions).toEqual(['ceo', 'codex-cto'])
  })

  test('case C — empty recipient inputs stay empty (matches INVALID_MENTION reject)', () => {
    const rawInputMentions = normalizedInputMentions({ mention: '', mentions: [] })
    expect(rawInputMentions).toEqual([])
  })
})

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('input_mentions DB round-trip (Issue #266 (A) migration)', () => {
  let client: Client
  const TEST_CHANNEL = `test-input-mentions-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM agent_messages WHERE channel_id = $1`, [TEST_CHANNEL])
  })

  afterAll(async () => {
    await client.query(`DELETE FROM agent_messages WHERE channel_id = $1`, [TEST_CHANNEL])
    await client.end()
  })

  async function insertWithMentions(input: string[] | null): Promise<string> {
    const id = randomUUID()
    await client.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, direction, input_mentions)
       VALUES ($1, $2, 'test', 'body', 'outbound', $3)`,
      [id, TEST_CHANNEL, input],
    )
    return id
  }

  async function selectMentions(id: string): Promise<string[] | null> {
    const r = await client.query<{ input_mentions: string[] | null }>(
      `SELECT input_mentions FROM agent_messages WHERE id = $1`,
      [id],
    )
    return r.rows[0]?.input_mentions ?? null
  }

  test('explicit ["ceo"] persists verbatim', async () => {
    const id = await insertWithMentions(['ceo'])
    expect(await selectMentions(id)).toEqual(['ceo'])
  })

  test('multi-element ["ceo", "cto"] persists verbatim', async () => {
    const id = await insertWithMentions(['ceo', 'cto'])
    expect(await selectMentions(id)).toEqual(['ceo', 'cto'])
  })

  test('NULL (saveMessage maps empty arr → null) round-trips as NULL', async () => {
    const id = await insertWithMentions(null)
    expect(await selectMentions(id)).toBeNull()
  })
})

describe('source-shape regression — server.ts retains the snapshot pattern', () => {
  // Production handlers persist the normalized phase5.mentions list as
  // input_mentions. Deleting either half silently breaks the trace.
  test('server.ts contains rawInputMentions snapshot + propagation', () => {
    const src = readFileSync(resolve(import.meta.dir, '../../server.ts'), 'utf8')
    const snapshotHits = src.match(/rawInputMentions\s*=\s*phase5\.mentions/g) ?? []
    expect(snapshotHits.length).toBeGreaterThanOrEqual(2)
    // Propagation: passed into saveMessage as input_mentions (send + notify)
    const propagationHits = src.match(/input_mentions:\s*rawInputMentions/g) ?? []
    expect(propagationHits.length).toBeGreaterThanOrEqual(2)
  })

  test('saveMessage signature accepts input_mentions param', () => {
    const src = readFileSync(resolve(import.meta.dir, '../../server.ts'), 'utf8')
    expect(src).toMatch(/input_mentions\?:\s*string\[\]\s*\|\s*null/)
  })
})
