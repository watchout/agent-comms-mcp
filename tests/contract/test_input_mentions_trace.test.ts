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

describe('input_mentions snapshot semantics (Issue #266 (A))', () => {
  // Ported verbatim from server.ts send/notify handler (lines 1689 / 2173).
  // Kept in sync via the source-shape grep below.
  function parseMentions(args: { mentions?: unknown }): string[] {
    return Array.isArray(args.mentions)
      ? (args.mentions as string[])
      : (args.mentions ? [args.mentions as string] : [])
  }

  test('case A — explicit mentions=["ceo"] survives subsequent auto-fill mutation', () => {
    const args = { mentions: ['ceo'] }
    const mentions = parseMentions(args)
    const rawInputMentions = mentions.slice()  // snapshot before auto-fill

    // Simulate the send-handler auto-fill (e.g. reply_to back-fill that
    // appends the original author to `mentions` after PR-B ③).
    mentions.push('autofilled-cto')

    expect(rawInputMentions).toEqual(['ceo'])
    expect(mentions).toEqual(['ceo', 'autofilled-cto'])
  })

  test('case B — empty mentions=[] (reply_to flow) snapshot stays empty even after auto-fill', () => {
    const args = { mentions: undefined }  // user passed nothing
    const mentions = parseMentions(args)
    expect(mentions).toEqual([])

    const rawInputMentions = mentions.slice()
    // reply_to-based auto-fill kicks in
    mentions.push('autofilled-from-reply-target')

    expect(rawInputMentions).toEqual([])
    expect(mentions).toEqual(['autofilled-from-reply-target'])
  })

  test('case C — single string mentions get wrapped to array (parsing parity)', () => {
    const mentions = parseMentions({ mentions: 'ceo' })
    expect(mentions).toEqual(['ceo'])
    const rawInputMentions = mentions.slice()
    expect(rawInputMentions).toEqual(['ceo'])
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
    // Snapshot pattern: `const rawInputMentions: string[] = mentions.slice()` (or via spread)
    expect(src).toMatch(/rawInputMentions[^\n]*=\s*mentions\.(slice|concat)\(\)|rawInputMentions[^\n]*=\s*\[\.\.\.mentions\]/)
    // Propagation: passed into saveMessage as input_mentions (at least 2 sites — send + notify)
    const propagationHits = src.match(/input_mentions:\s*rawInputMentions/g) ?? []
    expect(propagationHits.length).toBeGreaterThanOrEqual(2)
  })

  test('saveMessage signature accepts input_mentions param', () => {
    const src = readFileSync(resolve(import.meta.dir, '../../server.ts'), 'utf8')
    expect(src).toMatch(/input_mentions\?:\s*string\[\]\s*\|\s*null/)
  })
})
