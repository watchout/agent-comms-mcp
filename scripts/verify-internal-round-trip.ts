/**
 * Deterministic acceptance for one internal queue round trip.
 *
 * Replaces an adjudicated review with a query. A round trip between two seats either
 * happened or it did not, and the database says which — there is nothing here for a
 * reviewer to have an opinion about.
 *
 * Origin: the A1/Cell80 "Sample B" acceptance. Establishing that one seat could send a
 * message to another and receive a bound reply consumed a frozen roadmap entry, a
 * per-attempt owner decision, an attempt budget, a maker-separated audit and several
 * hundred executor ticks. Every fact that mattered is in these six checks, and the
 * historical round trip on queue 162529 satisfies all of them.
 *
 * What stays with a human: whether the reply's *content* is correct. This asserts that
 * the transport did what it claims — terminal state, binding, authorship, channel, and
 * an absence of provider effects — and nothing about meaning.
 *
 * Usage:
 *   bun scripts/verify-internal-round-trip.ts --queue-id 162529 [--format json|text]
 *
 * Exit: 0 all checks pass, 1 at least one fails, 2 usage or connection failure.
 */

import { Client } from 'pg'
import { resolveDatabaseUrl } from './queue-cleanup'

type CheckStatus = 'PASS' | 'FAIL'

interface CheckResult {
  check: string
  status: CheckStatus
  detail: string
  evidence?: Record<string, unknown>
}

interface QueueRow {
  id: string
  agent_id: string
  status: string
  message_id: string
  replied_with: string | null
  channel_id: string | null
}

interface ReplyRow {
  id: string
  author_id: string
  channel_id: string | null
  reply_to: string | null
}

const TERMINAL_REPLIED = new Set(['replied', 'done'])

function usage(message: string): never {
  process.stderr.write(`${message}\nusage: verify-internal-round-trip.ts --queue-id <id> [--format json|text]\n`)
  process.exit(2)
}

function parseArgs(argv: string[]): { queueId: string; format: 'json' | 'text' } {
  let queueId = ''
  let format: 'json' | 'text' = 'text'
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--queue-id') {
      if (!value || value.startsWith('--')) usage('--queue-id requires a value')
      queueId = value
      i += 1
    } else if (arg === '--format') {
      if (value !== 'json' && value !== 'text') usage('--format must be json or text')
      format = value
      i += 1
    } else {
      usage(`unexpected argument: ${arg}`)
    }
  }
  if (!/^[0-9]+$/u.test(queueId)) usage('--queue-id must be a positive integer')
  return { queueId, format }
}

export async function verifyRoundTrip(client: Client, queueId: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const pass = (check: string, detail: string, evidence?: Record<string, unknown>) =>
    results.push({ check, status: 'PASS', detail, ...(evidence ? { evidence } : {}) })
  const fail = (check: string, detail: string, evidence?: Record<string, unknown>) =>
    results.push({ check, status: 'FAIL', detail, ...(evidence ? { evidence } : {}) })

  const queueResult = await client.query<QueueRow>(
    `SELECT id::text, agent_id, status, message_id, replied_with,
            -- payload is TEXT, not JSONB, so it has to be cast before it can be read
            (payload::jsonb)->>'channel_id' AS channel_id
       FROM message_queue
      WHERE id = $1::bigint`,
    [queueId],
  )
  const request = queueResult.rows[0]
  if (!request) {
    fail('request_exists', `no message_queue row with id ${queueId}`)
    return results
  }
  pass('request_exists', `queue ${queueId} addressed to ${request.agent_id}`, {
    recipient: request.agent_id,
    request_message_id: request.message_id,
  })

  // 1. terminal state
  if (TERMINAL_REPLIED.has(request.status)) {
    pass('terminal_state', `status is ${request.status}`)
  } else {
    fail('terminal_state', `status is ${request.status}, which is not a replied terminal state`)
  }

  // 2. the queue row points at a reply
  if (request.replied_with) {
    pass('reply_recorded', `replied_with is ${request.replied_with}`)
  } else {
    fail('reply_recorded', 'replied_with is null, so the queue row records no reply')
  }

  const replyResult = await client.query<ReplyRow>(
    `SELECT id::text, author_id, channel_id, reply_to::text
       FROM agent_messages
      WHERE reply_to::text = $1
      ORDER BY sequence ASC`,
    [request.message_id],
  )
  const fragments = replyResult.rows

  // 3. the reply is bound to this request, not merely adjacent to it
  if (fragments.length === 0) {
    fail('reply_bound', `no agent_messages row has reply_to = ${request.message_id}`)
  } else if (request.replied_with && !fragments.some((f) => f.id === request.replied_with)) {
    fail('reply_bound', 'replied_with does not appear among the messages bound to this request', {
      replied_with: request.replied_with,
      bound_ids: fragments.map((f) => f.id),
    })
  } else {
    pass('reply_bound', `${fragments.length} message(s) bound to the request by reply_to`)
  }

  // 4. the recipient answered, not somebody else on its behalf
  if (fragments.length > 0) {
    const foreign = fragments.filter((f) => f.author_id !== request.agent_id)
    if (foreign.length > 0) {
      fail('reply_authorship', `${foreign.length} bound message(s) were not authored by ${request.agent_id}`, {
        authors: [...new Set(foreign.map((f) => f.author_id))],
      })
    } else {
      pass('reply_authorship', `every bound message was authored by ${request.agent_id}`)
    }
  }

  // 5. the reply came back on the channel the request arrived on
  if (fragments.length > 0 && request.channel_id) {
    const wrongChannel = fragments.filter((f) => f.channel_id !== request.channel_id)
    if (wrongChannel.length > 0) {
      fail('reply_channel', `${wrongChannel.length} bound message(s) are on a different channel`, {
        expected: request.channel_id,
        observed: [...new Set(wrongChannel.map((f) => f.channel_id))],
      })
    } else {
      pass('reply_channel', `every bound message is on channel ${request.channel_id}`)
    }
  }

  // 6. provider effects. Rows queued but never delivered are not effects; a row carrying
  //    a provider message id, or marked sent, is one that reached the outside world.
  if (fragments.length > 0) {
    const effects = await client.query<{ total: string; delivered: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE discord_message_id IS NOT NULL OR status = 'sent')::text AS delivered
         FROM outbound_queue
        WHERE message_id = ANY($1::text[])`,
      [fragments.map((f) => f.id)],
    )
    const { total, delivered } = effects.rows[0] ?? { total: '0', delivered: '0' }
    if (Number(delivered) > 0) {
      fail('provider_effects_zero', `${delivered} outbound row(s) reached a provider`, { outbound_rows: total, delivered })
    } else {
      pass('provider_effects_zero', `no outbound row reached a provider (${total} queued, 0 delivered)`)
    }
  }

  return results
}

async function main(): Promise<void> {
  const { queueId, format } = parseArgs(process.argv.slice(2))
  const client = new Client({ connectionString: resolveDatabaseUrl() })
  try {
    await client.connect()
  } catch (error) {
    usage(`cannot connect to the database: ${(error as Error).message}`)
  }

  let results: CheckResult[]
  try {
    results = await verifyRoundTrip(client, queueId)
  } finally {
    await client.end()
  }

  const failing = results.filter((r) => r.status === 'FAIL')
  const verdict = failing.length === 0 ? 'PASS' : 'FAIL'

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({
      schema_version: 'internal-round-trip-acceptance/v1',
      queue_id: queueId,
      verdict,
      results,
    }, null, 2)}\n`)
  } else {
    process.stdout.write(`internal round trip — queue ${queueId}\n\n`)
    for (const result of results) {
      process.stdout.write(`  ${result.status.padEnd(4)} ${result.check}: ${result.detail}\n`)
    }
    process.stdout.write(`\nverdict: ${verdict} (${failing.length} failing)\n`)
    process.stdout.write('content correctness is not asserted here and remains a human judgement.\n')
  }
  process.exit(verdict === 'PASS' ? 0 : 1)
}

if (import.meta.main) {
  await main()
}
