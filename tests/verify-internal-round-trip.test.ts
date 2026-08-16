import { describe, expect, test } from 'bun:test'
import { verifyRoundTrip } from '../scripts/verify-internal-round-trip'

// A stub client rather than a database: these assertions are about the decision the
// verifier makes given a set of rows, and a live database would only make the same
// assertions slower and less exhaustive. The shape of the rows mirrors the real
// historical round trip on queue 162529, which the verifier passes 7/7 against the
// production database.
function stubClient(rows: { queue?: unknown[]; fragments?: unknown[]; effects?: unknown[] }) {
  return {
    async query(sql: string) {
      if (sql.includes('FROM message_queue')) return { rows: rows.queue ?? [] }
      if (sql.includes('FROM agent_messages')) return { rows: rows.fragments ?? [] }
      if (sql.includes('FROM outbound_queue')) return { rows: rows.effects ?? [{ total: '0', delivered: '0' }] }
      throw new Error(`unexpected query: ${sql}`)
    },
  // biome-ignore lint/suspicious/noExplicitAny: a stub standing in for pg.Client
  } as any
}

const REQUEST = {
  id: '162529',
  agent_id: 'devauditor',
  status: 'replied',
  message_id: 'ede5bdc1-bf5f-4aba-9dbe-e8bed68cb5c6',
  replied_with: 'fdc35738-d946-40d2-b151-0e7131d36806',
  channel_id: '1486096778485825717',
}

const FRAGMENT = {
  id: 'fdc35738-d946-40d2-b151-0e7131d36806',
  author_id: 'devauditor',
  channel_id: '1486096778485825717',
  reply_to: REQUEST.message_id,
}

const statusOf = (results: Awaited<ReturnType<typeof verifyRoundTrip>>, check: string) =>
  results.find((r) => r.check === check)?.status

describe('internal round trip: a complete round trip passes every check', () => {
  test('the historical shape passes', async () => {
    const results = await verifyRoundTrip(stubClient({ queue: [REQUEST], fragments: [FRAGMENT] }), '162529')
    expect(results.every((r) => r.status === 'PASS')).toBe(true)
    expect(results).toHaveLength(7)
  })
})

describe('internal round trip: each failure mode is caught separately', () => {
  test('a missing queue row stops immediately rather than reporting on nothing', async () => {
    const results = await verifyRoundTrip(stubClient({ queue: [] }), '999')
    expect(results).toHaveLength(1)
    expect(statusOf(results, 'request_exists')).toBe('FAIL')
  })

  test('a pending request is not a terminal state', async () => {
    const results = await verifyRoundTrip(
      stubClient({ queue: [{ ...REQUEST, status: 'pending' }], fragments: [FRAGMENT] }), '162529')
    expect(statusOf(results, 'terminal_state')).toBe('FAIL')
  })

  test('a terminal row with no recorded reply fails', async () => {
    const results = await verifyRoundTrip(
      stubClient({ queue: [{ ...REQUEST, replied_with: null }], fragments: [FRAGMENT] }), '162529')
    expect(statusOf(results, 'reply_recorded')).toBe('FAIL')
  })

  test('a reply that exists but is not bound by reply_to fails', async () => {
    const results = await verifyRoundTrip(stubClient({ queue: [REQUEST], fragments: [] }), '162529')
    expect(statusOf(results, 'reply_bound')).toBe('FAIL')
  })

  test('replied_with pointing outside the bound set fails', async () => {
    const results = await verifyRoundTrip(
      stubClient({ queue: [REQUEST], fragments: [{ ...FRAGMENT, id: 'some-other-message' }] }), '162529')
    expect(statusOf(results, 'reply_bound')).toBe('FAIL')
  })

  test('somebody answering on the recipient behalf fails authorship', async () => {
    const results = await verifyRoundTrip(
      stubClient({ queue: [REQUEST], fragments: [{ ...FRAGMENT, author_id: 'adf-lead' }] }), '162529')
    expect(statusOf(results, 'reply_authorship')).toBe('FAIL')
  })

  test('a reply on a different channel fails', async () => {
    const results = await verifyRoundTrip(
      stubClient({ queue: [REQUEST], fragments: [{ ...FRAGMENT, channel_id: '999' }] }), '162529')
    expect(statusOf(results, 'reply_channel')).toBe('FAIL')
  })

  test('an outbound row that reached a provider fails, and a merely queued one does not', async () => {
    const delivered = await verifyRoundTrip(
      stubClient({ queue: [REQUEST], fragments: [FRAGMENT], effects: [{ total: '1', delivered: '1' }] }), '162529')
    expect(statusOf(delivered, 'provider_effects_zero')).toBe('FAIL')

    const queuedOnly = await verifyRoundTrip(
      stubClient({ queue: [REQUEST], fragments: [FRAGMENT], effects: [{ total: '3', delivered: '0' }] }), '162529')
    expect(statusOf(queuedOnly, 'provider_effects_zero')).toBe('PASS')
  })
})

describe('internal round trip: multi-fragment replies', () => {
  test('all four fragments of the historical reply are accepted', async () => {
    const fragments = ['a', 'b', 'c'].map((suffix) => ({ ...FRAGMENT, id: `frag-${suffix}` }))
    const results = await verifyRoundTrip(
      stubClient({ queue: [REQUEST], fragments: [FRAGMENT, ...fragments] }), '162529')
    expect(results.every((r) => r.status === 'PASS')).toBe(true)
  })

  test('one foreign author among many fragments still fails', async () => {
    const results = await verifyRoundTrip(
      stubClient({ queue: [REQUEST], fragments: [FRAGMENT, { ...FRAGMENT, id: 'frag-b', author_id: 'aun' }] }), '162529')
    expect(statusOf(results, 'reply_authorship')).toBe('FAIL')
  })
})
