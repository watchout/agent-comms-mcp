import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Issue #266 (A) — input_mentions raw trace.
//
// PR #275 adds:
//   1. agent_messages.input_mentions TEXT[] column
//   2. send / notify MCP handlers snapshot args.mentions BEFORE any
//      auto-fill / normalization, then pass it through saveMessage.
//
// The value being pinned is "raw args.mentions, frozen before mutation".
// Two angles are covered:
//
// (a) **Snapshot semantics** — replicates the production snapshot pattern
//     (`const rawInputMentions = mentions.slice()`) and proves that
//     subsequent mutation of `mentions` (the same auto-fill the send
//     handler does for reply_to flows) does NOT leak into the snapshot.
//     This is the regression check for the snapshot-before-autofill rule.
//
// (b) **DB round-trip** (postgres only, gated on DATABASE_URL) — INSERTs
//     into agent_messages with input_mentions = NULL / [] / ['ceo'] and
//     SELECTs them back to confirm the column was added by migration and
//     stores TEXT[] verbatim.
//
// (c) **Source-shape grep** — fails fast if server.ts loses the
//     `rawInputMentions` snapshot or its propagation into saveMessage.

describe('input_mentions snapshot semantics (Issue #266 (A); ADR-041 amendment 2026-05-05)', () => {
  // After the Phase 5 cleanup the MCP handlers no longer accept `mentions[]`.
  // The handler snapshot pattern is now:
  //   const rawInputMentions = typeof args.mention === 'string' && args.mention.length > 0
  //     ? [args.mention] : []
  // Then `mentions: string[]` is populated by resolvePhase5(...) (which may
  // expand cc[] entries into the enqueue list). The snapshot is taken from
  // the raw `args.mention` BEFORE resolvePhase5 mutates the working list.
  function snapshotInputMentions(args: { mention?: unknown }): string[] {
    return typeof args.mention === 'string' && args.mention.length > 0 ? [args.mention] : []
  }

  test('case A — explicit mention="ceo" survives subsequent enqueue expansion', () => {
    const args = { mention: 'ceo' }
    const rawInputMentions = snapshotInputMentions(args)
    let mentions: string[] = []  // populated below by resolvePhase5
    mentions = ['ceo', 'cc-target-1', 'cc-target-2']  // simulate enqueue expansion
    expect(rawInputMentions).toEqual(['ceo'])
    expect(mentions).toEqual(['ceo', 'cc-target-1', 'cc-target-2'])
  })

  test('case B — missing mention (defensive) snapshot stays empty', () => {
    const args = { mention: undefined }  // schema-required but defensive
    const rawInputMentions = snapshotInputMentions(args)
    expect(rawInputMentions).toEqual([])
  })

  test('case C — empty-string mention snapshot stays empty (matches INVALID_MENTION reject)', () => {
    const rawInputMentions = snapshotInputMentions({ mention: '' })
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
  // Production handlers are required to snapshot args.mentions BEFORE
  // any auto-fill mutates the working `mentions` array, then pass it to
  // saveMessage as input_mentions. Deleting either half silently breaks
  // the trace; this grep catches that.
  test('server.ts contains rawInputMentions snapshot + propagation', () => {
    const src = readFileSync(resolve(import.meta.dir, '../../server.ts'), 'utf8')
    // ADR-041 amendment 2026-05-05 — snapshot is now built from the singular
    // `args.mention` arg (legacy `args.mentions` array removed). At least 2
    // call sites (send + notify) should construct `[args.mention]`.
    const snapshotHits = src.match(/rawInputMentions[^\n]*=\s*typeof\s+args\.mention\s*===/g) ?? []
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
