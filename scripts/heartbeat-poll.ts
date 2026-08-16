#!/usr/bin/env bun
/**
 * Issue #277 (新規) — heartbeat broadcast.
 *
 * Independent infra process (NOT a registered agent) that wakes every
 * `HEARTBEAT_INTERVAL_SEC` seconds, queries postgres for every agent's
 * status / queue depth / claim age, formats a single observability line per
 * busy bot (and a brief summary for idle ones), and posts the lines to a
 * single Discord channel via `outbound_queue`.
 *
 * The script runs forever under a process supervisor (tmux / launchd / pm2);
 * SIGTERM exits cleanly without orphaning the postgres client.
 *
 * Forbidden (per Issue #277 §3):
 *   - LLM judgment for any field — every value is SQL or `git log` shell.
 *   - DM fan-out — channel post only.
 *   - Hard-coded working dir for `git log` — uses `agents.metadata->>'workdir'`
 *     if present, else falls back to `process.cwd()` (the script's own dir).
 *   - Registering itself as an `agents` row (heartbeat is infra, not an agent).
 */
import { Client } from 'pg'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  PROVIDER_EFFECTS_FORBIDDEN_CODE,
  PROVIDER_EFFECTS_FORBIDDEN_REASON,
  providerEffectsControlAuditEvidence,
  readProviderEffectsControl,
} from '../core/provider-effects-control'

const DATABASE_URL = process.env.DATABASE_URL
const CHANNEL_ID = process.env.HEARTBEAT_CHANNEL_ID ?? '1487368919613444156'
const INTERVAL_SEC = parseInt(process.env.HEARTBEAT_INTERVAL_SEC ?? '300', 10)
const WARN_SEC = parseInt(process.env.HEARTBEAT_WARN_THRESHOLD_SEC ?? '1800', 10)
const STUCK_SEC = parseInt(process.env.HEARTBEAT_STUCK_THRESHOLD_SEC ?? '7200', 10)
const SENDER_AGENT_ID = process.env.HEARTBEAT_SENDER_AGENT_ID ?? 'lead-ama'
const CEO_DISCORD_ID = process.env.CEO_DISCORD_ID ?? '1227059781265653783'

interface AgentSnapshot {
  agent_id: string
  status: string | null
  busy_since: Date | null
  current_message_id: string | null
  workdir: string | null
}

// Issue #278 (A) segment 3d — agents.current_message_id is gone. The
// "claim" column in the heartbeat line now sources from the most-recent
// active per-row claim on message_queue (claimed_by + status='read').
// LATERAL keeps the per-agent subquery cheap.
const QUERY = `
  SELECT a.agent_id,
         a.status,
         a.status_updated_at AS busy_since,
         claim.id::text AS current_message_id,
         a.metadata->>'workdir' AS workdir
    FROM agents a
    LEFT JOIN LATERAL (
      SELECT id FROM message_queue
       WHERE claimed_by = a.agent_id
         AND status = 'read'
       ORDER BY claimed_at DESC NULLS LAST
       LIMIT 1
    ) claim ON TRUE
   WHERE a.agent_type IS DISTINCT FROM 'system'
   ORDER BY a.agent_id
`

function formatHm(d: Date): string {
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function formatBusyAge(busySince: Date | null, now: Date): string | null {
  if (!busySince) return null
  const sec = Math.floor((now.getTime() - busySince.getTime()) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h${min % 60 > 0 ? `${min % 60}m` : ''}`
}

function gitHeadSubject(workdir: string | null): { branch: string; commit: string } {
  const cwd = workdir ?? process.cwd()
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', timeout: 2000 }).trim()
    const commit = execSync('git log -1 --format=%h:%s', { cwd, encoding: 'utf8', timeout: 2000 }).trim()
    return { branch: branch || '-', commit: commit || '-' }
  } catch {
    return { branch: '-', commit: '-' }
  }
}

export interface BuildLineOptions {
  warnSec?: number
  stuckSec?: number
}

export function buildLine(snap: AgentSnapshot, now: Date, opts: BuildLineOptions = {}): { line: string; mentionCeo: boolean } {
  const warnSec = opts.warnSec ?? WARN_SEC
  const stuckSec = opts.stuckSec ?? STUCK_SEC
  const hm = formatHm(now)
  const isBusy = snap.status === 'busy'
  const busyAge = formatBusyAge(snap.busy_since, now)
  const busyAgeSec = snap.busy_since ? Math.floor((now.getTime() - snap.busy_since.getTime()) / 1000) : 0
  let verdict = '✓'
  let mentionCeo = false
  if (isBusy) {
    if (busyAgeSec >= stuckSec) {
      verdict = '🚨 STUCK'
      mentionCeo = true
    } else if (busyAgeSec >= warnSec) {
      verdict = '⚠ WARN'
    } else {
      verdict = '·'
    }
  }
  const claim = snap.current_message_id ?? '-'
  const { branch, commit } = isBusy ? gitHeadSubject(snap.workdir) : { branch: '-', commit: '-' }
  const stateField = isBusy ? `busy ${busyAge ?? '?'}` : 'idle'
  const line = `[hb ${hm}] ${snap.agent_id} | ${stateField} | claim=${claim} | branch=${branch} | commit=${commit} | ${verdict}`
  return { line, mentionCeo }
}

export async function runOnce(client: Client, now: Date = new Date()): Promise<{
  lines: string[]
  stuckCount: number
  warnCount: number
  busyCount: number
}> {
  const result = await client.query<{
    agent_id: string
    status: string | null
    busy_since: Date | null
    current_message_id: string | null
    workdir: string | null
  }>(QUERY)
  const rows: AgentSnapshot[] = result.rows
  const lines: string[] = []
  let stuckCount = 0
  let warnCount = 0
  let busyCount = 0
  let mentionCeo = false
  for (const row of rows) {
    const { line, mentionCeo: rowMentionsCeo } = buildLine(row, now)
    lines.push(line)
    if (line.includes('🚨 STUCK')) stuckCount++
    if (line.includes('⚠ WARN')) warnCount++
    if (row.status === 'busy') busyCount++
    if (rowMentionsCeo) mentionCeo = true
  }
  if (mentionCeo) {
    lines.push(`<@${CEO_DISCORD_ID}> ↑ STUCK detected`)
  }
  return { lines, stuckCount, warnCount, busyCount }
}

export async function postToOutbound(
  client: Pick<Client, 'query'>,
  content: string,
): Promise<{ outboundQueued: boolean; outboundSkipReason: string | null }> {
  const providerEffectsControl = readProviderEffectsControl()
  if (!providerEffectsControl.allowsProviderEffects) {
    await client.query(
      `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'outbound.enqueue_skipped',
        SENDER_AGENT_ID,
        CHANNEL_ID,
        JSON.stringify({
          code: PROVIDER_EFFECTS_FORBIDDEN_CODE,
          surface: 'heartbeat-poll',
          provider_effects_control: providerEffectsControlAuditEvidence(providerEffectsControl),
          reason: PROVIDER_EFFECTS_FORBIDDEN_REASON,
        }),
        'default',
      ],
    )
    return {
      outboundQueued: false,
      outboundSkipReason: PROVIDER_EFFECTS_FORBIDDEN_REASON,
    }
  }

  const messageId = randomUUID()
  await client.query(
    `INSERT INTO outbound_queue
       (message_id, agent_id, consumer_agent_id, projection_identity_id,
        intended_projection_identity_id, projection_source, projection_fallback_reason,
        channel_external_id, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      messageId,
      SENDER_AGENT_ID,
      SENDER_AGENT_ID,
      SENDER_AGENT_ID,
      SENDER_AGENT_ID,
      'sender_native_projection',
      null,
      CHANNEL_ID,
      content,
    ],
  )
  return { outboundQueued: true, outboundSkipReason: null }
}

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    process.stderr.write('heartbeat: DATABASE_URL is required\n')
    process.exit(1)
  }
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stderr.write(
    `heartbeat: started — interval=${INTERVAL_SEC}s warn=${WARN_SEC}s stuck=${STUCK_SEC}s channel=${CHANNEL_ID} sender=${SENDER_AGENT_ID}\n`,
  )
  try {
    while (!stopping) {
      const start = Date.now()
      try {
        const { lines, stuckCount, warnCount, busyCount } = await runOnce(client)
        if (lines.length > 0) {
          const outbound = await postToOutbound(client, lines.join('\n'))
          if (!outbound.outboundQueued) {
            process.stderr.write(`heartbeat: provider projection skipped — ${outbound.outboundSkipReason}\n`)
          }
        }
        process.stderr.write(
          `heartbeat: cycle posted — busy=${busyCount} warn=${warnCount} stuck=${stuckCount} lines=${lines.length}\n`,
        )
      } catch (err) {
        process.stderr.write(`heartbeat: cycle failed (will retry next interval): ${err}\n`)
      }
      const elapsedMs = Date.now() - start
      const sleepMs = Math.max(0, INTERVAL_SEC * 1000 - elapsedMs)
      const tickMs = 1000
      let waited = 0
      while (waited < sleepMs && !stopping) {
        await new Promise((r) => setTimeout(r, Math.min(tickMs, sleepMs - waited)))
        waited += tickMs
      }
    }
  } finally {
    await client.end().catch(() => {})
    process.stderr.write('heartbeat: stopped\n')
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`heartbeat: fatal: ${err}\n`)
    process.exit(1)
  })
}
