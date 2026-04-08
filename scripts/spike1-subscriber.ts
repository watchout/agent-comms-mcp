#!/usr/bin/env bun
/**
 * Spike 1 subscriber — verifies pg_notify→subscriber path against shadow_messages.
 *
 * Two parallel paths:
 *   1. LISTEN shadow_inbox  → push notification on every shadow_messages INSERT
 *   2. Polling loop (3s)    → SELECT WHERE id NOT IN seen, fallback path
 *
 * For each row received, marks `received_via_listen_at` / `received_via_poll_at`
 * so we can later verify both paths fired and there were no drops.
 *
 * Stop with Ctrl-C or after `--duration <sec>`.
 *
 * Usage:
 *   bun run scripts/spike1-subscriber.ts [run_id] [duration_sec]
 *     run_id       : filter rows by spike_run_id (default: all)
 *     duration_sec : auto-exit after this many seconds (default: 30)
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

const runId = process.argv[2] ?? null
const durationSec = Number(process.argv[3] ?? '30')

const POLL_INTERVAL_MS = 3000
const seenViaListen = new Set<string>()
const seenViaPoll = new Set<string>()

async function main() {
  const listenClient = new Client({ connectionString: databaseUrl })
  const pollClient = new Client({ connectionString: databaseUrl })
  await listenClient.connect()
  await pollClient.connect()

  await listenClient.query('LISTEN shadow_inbox')
  console.log(`[subscriber] LISTEN shadow_inbox started (run_id filter: ${runId ?? 'none'})`)

  listenClient.on('notification', async (msg) => {
    if (msg.channel !== 'shadow_inbox' || !msg.payload) return
    try {
      const payload = JSON.parse(msg.payload) as {
        event: string; message_id: string; spike_run_id?: string
      }
      if (runId && payload.spike_run_id !== runId) return
      if (seenViaListen.has(payload.message_id)) return
      seenViaListen.add(payload.message_id)

      // Mark received timestamp + fetch row to confirm content reachable
      const r = await pollClient.query(
        `UPDATE shadow_messages
           SET received_via_listen_at = COALESCE(received_via_listen_at, now())
         WHERE id = $1
         RETURNING id, content, created_at, received_via_listen_at`,
        [payload.message_id],
      )
      if (r.rows.length === 0) {
        console.log(`[subscriber LISTEN] miss id=${payload.message_id} (row not found)`)
        return
      }
      const row = r.rows[0]
      const latencyMs = new Date(row.received_via_listen_at).getTime() - new Date(row.created_at).getTime()
      console.log(`[subscriber LISTEN] id=${row.id} latency=${latencyMs}ms content="${row.content.slice(0, 60)}"`)
    } catch (err) {
      console.error(`[subscriber LISTEN] error:`, err)
    }
  })

  // Polling loop (cursor-based)
  let lastCreatedAt = new Date(Date.now() - 1000) // start window 1s back
  const pollLoop = async () => {
    try {
      const params: any[] = [lastCreatedAt]
      let where = `created_at > $1`
      if (runId) {
        params.push(runId)
        where += ` AND spike_run_id = $2`
      }
      const r = await pollClient.query(
        `SELECT id, content, created_at FROM shadow_messages
         WHERE ${where}
         ORDER BY created_at ASC
         LIMIT 100`,
        params,
      )
      for (const row of r.rows) {
        if (seenViaPoll.has(row.id)) continue
        seenViaPoll.add(row.id)
        await pollClient.query(
          `UPDATE shadow_messages
             SET received_via_poll_at = COALESCE(received_via_poll_at, now())
           WHERE id = $1`,
          [row.id],
        )
        console.log(`[subscriber POLL ] id=${row.id} content="${row.content.slice(0, 60)}"`)
        if (new Date(row.created_at) > lastCreatedAt) {
          lastCreatedAt = new Date(row.created_at)
        }
      }
    } catch (err) {
      console.error(`[subscriber POLL ] error:`, err)
    }
  }

  const pollTimer = setInterval(pollLoop, POLL_INTERVAL_MS)
  // also run an immediate poll after a short delay to catch in-flight rows
  setTimeout(pollLoop, 500)

  // Auto-exit after duration
  setTimeout(async () => {
    clearInterval(pollTimer)
    console.log('---')
    console.log(`[subscriber] summary:`)
    console.log(`  via LISTEN: ${seenViaListen.size}`)
    console.log(`  via POLL  : ${seenViaPoll.size}`)
    const unionSize = new Set([...seenViaListen, ...seenViaPoll]).size
    console.log(`  unique total: ${unionSize}`)
    await listenClient.end()
    await pollClient.end()
    process.exit(0)
  }, durationSec * 1000)
}

main().catch(e => { console.error(e); process.exit(1) })
