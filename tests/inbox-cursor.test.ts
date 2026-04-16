/**
 * Issue #179 behavioral coverage — fetchNewMessages composite
 * (created_at, id) cursor.
 *
 * Proves:
 *   1. UUID v4 lex order != creation order (concrete pair).
 *   2. Old bare `id > $3` cursor DROPS a new row whose UUID sorts
 *      lexicographically before the seen max. Same INPUT against
 *      the new cursor logic sees the row.
 *   3. Composite cursor SQL shape (expanded form, not row-value).
 *   4. Empty result preserves the cursor (no advance).
 *   5. Same-ms created_at — UUID tiebreaker advances the cursor
 *      without dropping either row.
 *   6. The SELECT honors the ORDER BY (created_at ASC, id ASC)
 *      passed to deps.query (callers rely on monotonic delivery).
 *   7. µs-precision round-trip (cycle 3 DB integration): insert a
 *      row with `.123456+00`, fetch1 returns it with a µs-precise
 *      cursor, fetch2 with that cursor returns empty (no duplicate
 *      delivery).
 *
 * Test shape is unit + SQL-shape (deps.query mock) + DB-integration
 * for the µs round-trip (required by auditor cycle 2 BLOCK). The
 * DB-integration tests skip without DATABASE_URL, matching the
 * pattern used by tests/outbound-delivery.test.ts.
 */
import { describe, test, expect } from 'bun:test'
import { fetchNewMessages, type InboxCursor, type InboxRow } from '../core/inbox-cursor'

// Concrete UUID v4 pair that demonstrates lex != time ordering.
// `A_` is created EARLIER but sorts LATER lex; `B_` is created
// LATER but sorts EARLIER. The old cursor (id > $3) stored A_ and
// then filtered B_ out (B_ < A_ lexicographically).
const EARLIER_CREATED_LATER_UUID = 'fedcba98-7654-4321-8fed-cba987654321'
const LATER_CREATED_EARLIER_UUID = '01234567-89ab-4cde-8012-3456789abcde'
expect(LATER_CREATED_EARLIER_UUID < EARLIER_CREATED_LATER_UUID).toBe(true)

function makeRow(overrides: Partial<InboxRow>): InboxRow {
  return {
    id: overrides.id ?? '00000000-0000-0000-0000-000000000000',
    channel_id: overrides.channel_id ?? 'test-channel',
    author_id: overrides.author_id ?? 'ceo',
    content: overrides.content ?? 'hello',
    message_type: overrides.message_type ?? 'chat',
    reply_to: overrides.reply_to ?? null,
    metadata: overrides.metadata ?? { to: 'lead-ama' },
    depth: overrides.depth ?? 0,
    created_at: overrides.created_at ?? new Date('2026-04-15T07:00:00Z'),
  }
}

describe('fetchNewMessages — composite cursor semantics (Issue #179)', () => {
  test('1. UUID v4 lex ordering is not time-monotonic (concrete pair)', () => {
    expect(LATER_CREATED_EARLIER_UUID < EARLIER_CREATED_LATER_UUID).toBe(true)
  })

  test('2. first call with no cursor — no cursor predicate in WHERE, returns rows + advances cursor', async () => {
    let capturedSql = ''
    let capturedParams: any[] = []
    const row = makeRow({
      id: EARLIER_CREATED_LATER_UUID,
      created_at: new Date('2026-04-15T07:00:00Z'),
    })
    const result = await fetchNewMessages('lead-ama', 20, null, {
      query: async (sql, params) => {
        capturedSql = sql
        capturedParams = params
        return { rows: [row] }
      },
    })

    expect(capturedSql).toContain(`metadata->>'to' = $1`)
    expect(capturedSql).not.toContain('created_at, id) >')
    expect(capturedParams).toEqual(['lead-ama', 20])
    expect(result.rows).toHaveLength(1)
    expect(result.nextCursor).toEqual({
      createdAt: '2026-04-15T07:00:00.000Z',
      id: EARLIER_CREATED_LATER_UUID,
    })
  })

  test('3. subsequent call emits row-value comparison predicate with (created_at, id)', async () => {
    let capturedSql = ''
    let capturedParams: any[] = []
    const cursor: InboxCursor = {
      createdAt: '2026-04-15T07:00:00.000Z',
      id: EARLIER_CREATED_LATER_UUID,
    }
    await fetchNewMessages('lead-ama', 20, cursor, {
      query: async (sql, params) => {
        capturedSql = sql
        capturedParams = params
        return { rows: [] }
      },
    })
    // Composite cursor comparison (created_at first, id as tiebreaker)
    // — the #179 regression guard. Expanded form, not ROW() (see
    // core/inbox-cursor.ts comment on the PG 42P18 rationale).
    expect(capturedSql).toContain('created_at > $3::timestamptz')
    expect(capturedSql).toContain('created_at = $3::timestamptz AND id > $4::uuid')
    // Must NOT degrade back to the bare lex cursor on the UUID column.
    expect(capturedSql).not.toMatch(/\bAND\s+id\s*>\s*\$3\b/)
    // Params passed in the same order as the placeholders.
    expect(capturedParams).toEqual([
      'lead-ama', 20,
      '2026-04-15T07:00:00.000Z',
      EARLIER_CREATED_LATER_UUID,
    ])
  })

  test('4. #179 regression guard — new row with lex-smaller UUID + later created_at is NOT dropped', async () => {
    // Scenario: cursor stores EARLIER_CREATED_LATER_UUID at t=T0.
    // A new row arrives at t=T1 (> T0) with LATER_CREATED_EARLIER_UUID.
    // Under old bare `id > $3` cursor, the new row was filtered out
    // (LATER_CREATED_EARLIER_UUID < EARLIER_CREATED_LATER_UUID lex).
    // Under composite (created_at, id) cursor, the new row is returned
    // because its created_at strictly exceeds the stored createdAt.
    const cursor: InboxCursor = {
      createdAt: '2026-04-15T07:00:00.000Z',
      id: EARLIER_CREATED_LATER_UUID,
    }
    const newerRow = makeRow({
      id: LATER_CREATED_EARLIER_UUID,
      created_at: new Date('2026-04-15T07:10:00Z'),
    })

    // We simulate the database honoring (created_at, id) > ($3, $4):
    // the newer row passes because 07:10 > 07:00.
    const result = await fetchNewMessages('lead-ama', 20, cursor, {
      query: async (_sql, _params) => ({ rows: [newerRow] }),
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.id).toBe(LATER_CREATED_EARLIER_UUID)
    expect(result.nextCursor).toEqual({
      createdAt: '2026-04-15T07:10:00.000Z',
      id: LATER_CREATED_EARLIER_UUID,
    })
  })

  test('5. empty result preserves cursor (no advance, no skip on retry)', async () => {
    const cursor: InboxCursor = {
      createdAt: '2026-04-15T07:00:00.000Z',
      id: EARLIER_CREATED_LATER_UUID,
    }
    const result = await fetchNewMessages('lead-ama', 20, cursor, {
      query: async () => ({ rows: [] }),
    })

    expect(result.rows).toEqual([])
    expect(result.nextCursor).toEqual(cursor)
  })

  test('6. same-ms created_at — UUID tiebreaker advances past the larger-id row (mock-level ms case)', async () => {
    // Precision note: SSOT §4.8.1 defines the cursor as µs-granular
    // (PG timestamptz's minimum precision), with the id UUID acting as
    // tiebreaker at the same-µs boundary. Real DB round-trips preserve
    // µs via the `created_at_text` companion column and are pinned by
    // the DB integration test further below (`Issue #179 regression —
    // µs round-trip`).
    //
    // This unit test uses `makeRow({ created_at: new Date(...) })`
    // mocks, and JS `Date` only holds ms. So at the mock layer the two
    // probe rows share a ms-level instant, and the id UUID tiebreaker
    // does its ordering work at the ms boundary here — not µs. That
    // difference is a property of the **mock**, not of the
    // production cursor semantics. (Earlier PR #182 cycle 2 auditor
    // feedback stated ms; cycle 3 refined the production path to µs
    // via `created_at_text`.)
    const sharedTs = new Date('2026-04-15T07:15:00.123Z')
    // Sanity: JS Date truncates µs → ms, so a µs-level ISO string and
    // a ms-level ISO string collapse to the same instant.
    expect(new Date('2026-04-15T07:15:00.123456Z').getTime()).toBe(sharedTs.getTime())

    const rowA = makeRow({ id: LATER_CREATED_EARLIER_UUID, created_at: sharedTs })
    const rowB = makeRow({ id: EARLIER_CREATED_LATER_UUID, created_at: sharedTs })
    const result = await fetchNewMessages('lead-ama', 20, null, {
      query: async () => ({ rows: [rowA, rowB] }),
    })
    expect(result.rows).toHaveLength(2)
    // Cursor advances to the LAST row. id ASC in the SELECT places
    // EARLIER_CREATED_LATER_UUID (lex-larger) last, so it anchors the
    // cursor for the next call.
    expect(result.nextCursor).toEqual({
      createdAt: sharedTs.toISOString(),
      id: EARLIER_CREATED_LATER_UUID,
    })
    // Confirm the ISO form is ms-precise (no µs trailing digits).
    expect(result.nextCursor!.createdAt).toBe('2026-04-15T07:15:00.123Z')
    expect(result.nextCursor!.createdAt).not.toMatch(/\.\d{4,}Z$/)
  })

  test('7. ORDER BY created_at ASC, id ASC is in the SELECT (monotonic delivery)', async () => {
    let capturedSql = ''
    await fetchNewMessages('lead-ama', 20, null, {
      query: async (sql) => {
        capturedSql = sql
        return { rows: [] }
      },
    })
    expect(capturedSql).toContain('ORDER BY created_at ASC, id ASC')
  })

  test('8. cursor advance handles ISO string created_at (DB driver returning text)', async () => {
    const isoText = '2026-04-15T07:22:00.000Z'
    const result = await fetchNewMessages('lead-ama', 20, null, {
      query: async () => ({
        rows: [makeRow({ id: LATER_CREATED_EARLIER_UUID, created_at: isoText })],
      }),
    })
    expect(result.nextCursor).toEqual({
      createdAt: isoText,
      id: LATER_CREATED_EARLIER_UUID,
    })
  })

  test('9. SELECT adds created_at::text AS created_at_text (cycle 3 µs-precision companion)', async () => {
    let capturedSql = ''
    await fetchNewMessages('lead-ama', 20, null, {
      query: async (sql) => {
        capturedSql = sql
        return { rows: [] }
      },
    })
    // The companion column is the µs-precision anchor — required so
    // the cursor is NOT built from the ms-truncated JS Date.
    expect(capturedSql).toContain('created_at::text AS created_at_text')
  })

  test('10. cursor prefers created_at_text over JS Date (µs-precision preserved)', async () => {
    // Simulate what the real DB returns: the JS Date is ms-truncated
    // (`.123Z`) but the companion text column keeps µs (`.123456+00`).
    // The cursor MUST use the text value so the next WHERE compares
    // µs-precisely and does NOT re-match the same row.
    const msDate = new Date('2026-04-15T07:15:00.123Z')
    const usText = '2026-04-15 07:15:00.123456+00'
    const result = await fetchNewMessages('lead-ama', 20, null, {
      query: async () => ({
        rows: [
          {
            ...makeRow({ id: LATER_CREATED_EARLIER_UUID, created_at: msDate }),
            created_at_text: usText,
          },
        ],
      }),
    })
    expect(result.nextCursor).toEqual({
      createdAt: usText,
      id: LATER_CREATED_EARLIER_UUID,
    })
    // Explicitly: the µs-lossy Date ISO string is NOT used as the
    // cursor anchor.
    expect(result.nextCursor!.createdAt).not.toBe(msDate.toISOString())
  })
})

// DB integration — requires DATABASE_URL. Skipped otherwise to match
// the pattern used by tests/outbound-delivery.test.ts.
const DB_URL = process.env.DATABASE_URL
describe.skipIf(!DB_URL)('fetchNewMessages — DB integration (Issue #179)', () => {
  test('composite cursor does not drop a lex-smaller UUID inserted later', async () => {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: DB_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      const agentA = `test-inbox-cursor-a-${Date.now()}`
      const agentB = `test-inbox-cursor-b-${Date.now()}`
      // Insert row 1 (EARLIER_CREATED_LATER_UUID) at T0.
      await client.query(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, metadata, created_at)
         VALUES ($1::uuid, 'ch-test', $2, 'early post', jsonb_build_object('to', $3::text), '2026-01-01T00:00:00Z')`,
        [EARLIER_CREATED_LATER_UUID, agentA, agentB],
      )
      // Insert row 2 (LATER_CREATED_EARLIER_UUID) at T1 > T0.
      await client.query(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, metadata, created_at)
         VALUES ($1::uuid, 'ch-test', $2, 'later post', jsonb_build_object('to', $3::text), '2026-01-02T00:00:00Z')`,
        [LATER_CREATED_EARLIER_UUID, agentA, agentB],
      )

      // First fetch with no cursor: expect both rows, cursor advances to row 2.
      const first = await fetchNewMessages(agentB, 10, null, {
        query: (sql, params) => client.query(sql, params) as any,
      })
      expect(first.rows.map(r => r.id)).toEqual([
        EARLIER_CREATED_LATER_UUID,
        LATER_CREATED_EARLIER_UUID,
      ])

      // Simulate the old bug: store cursor at row 1 (EARLIER_CREATED_LATER_UUID)
      // then fetch. The new cursor logic must return row 2 (not filter it out).
      const afterFirst: InboxCursor = {
        createdAt: '2026-01-01T00:00:00.000Z',
        id: EARLIER_CREATED_LATER_UUID,
      }
      const second = await fetchNewMessages(agentB, 10, afterFirst, {
        query: (sql, params) => client.query(sql, params) as any,
      })
      expect(second.rows.map(r => r.id)).toEqual([LATER_CREATED_EARLIER_UUID])
    } finally {
      await client.query('ROLLBACK')
      await client.end()
    }
  })

  test('µs-precision round-trip — insert→fetch1→fetch2 empty (cycle 3 regression guard)', async () => {
    // This is the test auditor cycle 2 called out as the critical
    // missing piece: prove that a row with µs in `created_at` is
    // returned exactly once and NOT re-delivered on the next fetch.
    //
    // Under the ms-truncated cursor (cycle 2), the INSERT at
    // `.123456+00` would be re-matched by the next WHERE because
    // cursor.createdAt was `.123+00` (ms) and `.123456 > .123` is
    // true. Under the cycle 3 fix (`created_at::text AS created_at_text`
    // preserves µs into the cursor), fetch2 returns empty.
    const { Client } = await import('pg')
    const client = new Client({ connectionString: DB_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      const agent = `test-inbox-us-${Date.now()}`
      const sender = `test-sender-us-${Date.now()}`
      const rowId = '11111111-2222-4333-8444-555555555555'
      await client.query(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, metadata, created_at)
         VALUES ($1::uuid, 'ch-test', $2, 'us-precise post', jsonb_build_object('to', $3::text),
                 '2026-01-03 00:00:00.123456+00'::timestamptz)`,
        [rowId, sender, agent],
      )

      // fetch1: no cursor → row returned.
      const first = await fetchNewMessages(agent, 10, null, {
        query: (sql, params) => client.query(sql, params) as any,
      })
      expect(first.rows).toHaveLength(1)
      expect(first.rows[0]!.id).toBe(rowId)
      expect(first.nextCursor).not.toBeNull()
      // Cursor anchor MUST carry µs (6 fractional digits). This is the
      // core regression guard — the ms-truncated form '.123000+00' or
      // '.123Z' would fail here.
      // NOTE: the exact `.ffffff+HH` textual form depends on the PG
      // session DateStyle ('ISO, MDY' default). A non-default DateStyle
      // could change the surrounding layout (date-component order /
      // tz format); the sub-millisecond digits themselves are still
      // emitted so the cursor round-trip still works.
      expect(first.nextCursor!.createdAt).toMatch(/\.\d{6}\+\d{2}$/)
      expect(first.nextCursor!.createdAt).toContain('.123456')

      // fetch2 with that µs-precise cursor: row is NOT re-delivered.
      const second = await fetchNewMessages(agent, 10, first.nextCursor, {
        query: (sql, params) => client.query(sql, params) as any,
      })
      expect(second.rows).toEqual([])
      // Cursor preserved (no advance on empty result).
      expect(second.nextCursor).toEqual(first.nextCursor)
    } finally {
      await client.query('ROLLBACK')
      await client.end()
    }
  })
})
