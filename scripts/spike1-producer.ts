#!/usr/bin/env bun
/**
 * Spike 1 producer — simulates a "shadow receiver" that:
 *   1. INSERTs a row into shadow_messages (NOT agent_messages)
 *   2. Fires pg_notify('shadow_inbox', {message_id, channel_id, author_id})
 *
 * This is the producer side of Spike 1's pg_notify→subscriber path verification.
 *
 * Usage:
 *   bun run scripts/spike1-producer.ts [run_id] [n]
 *     run_id : a tag used to group rows from one spike run (default: spike1-<unix>)
 *     n      : how many messages to inject (default: 1)
 */
import { Client } from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

let databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const configPath = join(dirname(new URL(import.meta.url).pathname), '..', 'config.json')
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    databaseUrl = config.database_url ?? databaseUrl
  } catch {}
}

const runId = process.argv[2] ?? `spike1-${Date.now()}`
const count = Number(process.argv[3] ?? '1')

async function main() {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  for (let i = 0; i < count; i++) {
    const content = `spike1 test message #${i + 1} run=${runId} t=${new Date().toISOString()}`
    const channelId = 'spike1-test-channel'
    const authorId = 'spike1-producer'

    const r = await client.query(
      `INSERT INTO shadow_messages
         (channel_id, author_id, content, message_type, metadata, source, spike_run_id)
       VALUES ($1, $2, $3, 'chat', $4::jsonb, 'spike1', $5)
       RETURNING id, created_at`,
      [channelId, authorId, content, JSON.stringify({ spike: true, idx: i + 1 }), runId],
    )
    const row = r.rows[0]

    const payload = JSON.stringify({
      event: 'shadow.message.created',
      message_id: row.id,
      channel_id: channelId,
      author_id: authorId,
      spike_run_id: runId,
    })

    await client.query(`SELECT pg_notify('shadow_inbox', $1)`, [payload])

    console.log(`[producer] inserted+notified id=${row.id} idx=${i + 1}/${count} run=${runId}`)
    if (i < count - 1) await new Promise(r => setTimeout(r, 200))
  }

  await client.end()
}

main().catch(e => { console.error(e); process.exit(1) })
