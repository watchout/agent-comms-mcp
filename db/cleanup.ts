#!/usr/bin/env bun
/**
 * Cleanup expired messages based on channel retention policy.
 * Run daily via cron: 0 4 * * * bun ~/Developer/agent-comms-mcp/db/cleanup.ts
 */
import { Client } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'

async function cleanup() {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()

  // Get channels with retention policy (retention_days IS NOT NULL)
  const { rows: channels } = await client.query(
    `SELECT channel_id, retention_days FROM channel_settings WHERE retention_days IS NOT NULL`
  )

  let totalDeleted = 0

  for (const ch of channels) {
    const result = await client.query(
      `DELETE FROM agent_messages
       WHERE channel_id = $1 AND created_at < now() - make_interval(days => $2)
       RETURNING id`,
      [ch.channel_id, ch.retention_days]
    )
    if (result.rowCount > 0) {
      console.log(`${ch.channel_id}: deleted ${result.rowCount} messages (>${ch.retention_days} days)`)
      totalDeleted += result.rowCount
    }
  }

  // Clean up rate_limits older than 1 day
  try {
    const rateLimitResult = await client.query(
      `DELETE FROM rate_limits WHERE window_start < now() - interval '1 day' RETURNING agent_id`
    )
    if (rateLimitResult.rowCount! > 0) {
      console.log(`rate_limits: deleted ${rateLimitResult.rowCount} old records`)
    }
  } catch {} // Table may not exist yet

  // Clean up loop_counters older than 1 day
  try {
    const loopResult = await client.query(
      `DELETE FROM loop_counters WHERE window_start < now() - interval '1 day' RETURNING agent_pair`
    )
    if (loopResult.rowCount! > 0) {
      console.log(`loop_counters: deleted ${loopResult.rowCount} old records`)
    }
  } catch {} // Table may not exist yet

  // Clean up duplicate_hashes older than 1 hour
  try {
    const dupResult = await client.query(
      `DELETE FROM duplicate_hashes WHERE created_at < now() - interval '1 hour' RETURNING hash`
    )
    if (dupResult.rowCount! > 0) {
      console.log(`duplicate_hashes: deleted ${dupResult.rowCount} old records`)
    }
  } catch {} // Table may not exist yet

  // Mark stale agents as offline (no heartbeat for 15+ minutes)
  try {
    const agentResult = await client.query(
      `UPDATE agents SET status = 'offline' WHERE status = 'online' AND last_seen_at < now() - interval '15 minutes' RETURNING agent_id`
    )
    if (agentResult.rowCount! > 0) {
      console.log(`agents: marked ${agentResult.rowCount} stale agents as offline`)
    }
  } catch {} // Table may not exist yet

  // Report table size
  const { rows: [size] } = await client.query(
    `SELECT pg_size_pretty(pg_total_relation_size('agent_messages')) AS size,
            (SELECT count(*) FROM agent_messages) AS total_rows`
  )
  console.log(`Table size: ${size.size}, total rows: ${size.total_rows}, deleted today: ${totalDeleted}`)

  await client.end()
}

cleanup().catch(e => { console.error(e); process.exit(1) })
