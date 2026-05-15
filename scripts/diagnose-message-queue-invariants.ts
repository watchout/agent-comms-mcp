#!/usr/bin/env bun
import { Client } from 'pg'
import { resolveDatabaseUrl } from './queue-cleanup'

interface InvariantQuery {
  name: string
  where: string
}

const INVARIANTS: InvariantQuery[] = [
  {
    name: 'replied_missing_reply_evidence',
    where: `status = 'replied'
         AND (replied_at IS NULL OR replied_with IS NULL)`,
  },
  {
    name: 'pending_with_claim_columns',
    where: `status = 'pending'
         AND (claimed_by IS NOT NULL OR claimed_at IS NOT NULL OR claim_expires_at IS NOT NULL)`,
  },
  {
    name: 'no_reply_terminal_missing_reason',
    where: `status IN ('skipped', 'failed')
         AND (failed_reason IS NULL OR done_at IS NULL)`,
  },
  {
    name: 'non_replied_with_reply_evidence',
    where: `status <> 'replied'
         AND (replied_at IS NOT NULL OR replied_with IS NOT NULL)`,
  },
]

export async function diagnoseMessageQueueInvariants(databaseUrl = resolveDatabaseUrl()) {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const reports = []
    for (const invariant of INVARIANTS) {
      const countSql = `SELECT count(*)::int AS n FROM message_queue WHERE ${invariant.where}`
      const sampleSql = `
        SELECT id, agent_id, message_id, status, replied_at, replied_with,
               failed_reason, done_at, claimed_by, claimed_at,
               claim_expires_at, created_at
          FROM message_queue
         WHERE ${invariant.where}
         ORDER BY id
         LIMIT 25`
      const [count, sample] = await Promise.all([
        client.query<{ n: number }>(countSql),
        client.query(sampleSql),
      ])
      reports.push({
        name: invariant.name,
        count: count.rows[0]?.n ?? 0,
        sample: sample.rows,
      })
    }
    return reports
  } finally {
    await client.end().catch(() => {})
  }
}

if (import.meta.main) {
  diagnoseMessageQueueInvariants()
    .then((reports) => {
      process.stdout.write(`${JSON.stringify({ ok: true, reports }, null, 2)}\n`)
    })
    .catch((err) => {
      process.stderr.write(`diagnose-message-queue-invariants failed: ${err?.message ?? err}\n`)
      process.exit(1)
    })
}
