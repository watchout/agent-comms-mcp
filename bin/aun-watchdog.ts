#!/usr/bin/env bun
/**
 * Issue #278 (§E + §G-1) — agent-comms watchdog daemon.
 *
 * A long-running process that polls `agents.last_seen_at` and
 * restarts any bot whose heartbeat has lapsed past the crash
 * threshold. Replaces the ad-hoc tmux babysitting CTO / lead-ama
 * have been doing manually since #178.
 *
 * Detection (per spec):
 *   `agents.last_seen_at < NOW() - AUN_WATCHDOG_CRASH_THRESHOLD_SEC
 *    AND status != 'offline'`
 *
 * Recovery:
 *   `tmux send-keys` injects an Enter into the tmux session whose
 *   name comes from the DB bot profile (`agents.metadata.tmux_session`).
 *   The typical bot startup line is the daemon-style restart-bot.sh
 *   already mounted on Enter, so a single newline triggers it.
 *   When that fails (no tmux server / session missing), we fall
 *   back to spawning `scripts/restart-bot.sh <session>` directly.
 *
 * Safety knobs (Issue #278 §5 Open decisions, all overridable):
 *   AUN_WATCHDOG_POLL_SEC               default 30
 *   AUN_WATCHDOG_CRASH_THRESHOLD_SEC    default 300 (5 min)
 *   AUN_WATCHDOG_RATE_LIMIT_PER_HOUR    default 6  (per-bot cap)
 *   AUN_WATCHDOG_DRY_RUN=1              log only, no tmux / spawn
 *   AUN_WATCHDOG_REGISTRY_PATH          default scripts/bot-registry.txt
 *
 * Audit:
 *   Every restart attempt INSERTs an `audit_log` row with
 *   event_type='bot.auto_restart' (success or failure mode encoded
 *   in detail.outcome). Operators query this to spot flapping bots.
 *
 * Self-monitor (§G-1):
 *   The plist `infra/launchd/com.aun.watchdog.plist` is the OS
 *   supervisor for this script (KeepAlive=true). The watchdog does
 *   not supervise itself; if it crashes, launchd restarts it.
 */

import { Client } from 'pg'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DATABASE_URL = process.env.DATABASE_URL
const POLL_SEC = parseInt(process.env.AUN_WATCHDOG_POLL_SEC ?? '30', 10)
const CRASH_THRESHOLD_SEC = parseInt(process.env.AUN_WATCHDOG_CRASH_THRESHOLD_SEC ?? '300', 10)
const RATE_LIMIT_PER_HOUR = parseInt(process.env.AUN_WATCHDOG_RATE_LIMIT_PER_HOUR ?? '6', 10)
const DRY_RUN = process.env.AUN_WATCHDOG_DRY_RUN === '1'
const REGISTRY_PATH = process.env.AUN_WATCHDOG_REGISTRY_PATH ?? join(process.cwd(), 'scripts/bot-registry.txt')
const RESTART_SCRIPT = join(process.cwd(), 'scripts/restart-bot.sh')

interface CrashedAgent {
  agentId: string
  lastSeenAt: Date | null
  status: string | null
}

interface WatchdogSession {
  session: string
  projectDir: string
  port: string
  source: 'agents.profile' | 'bot-registry.compat'
}

interface RateLimitState {
  /** Per-agent restart timestamps (ms). Trimmed to last hour on each check. */
  history: Map<string, number[]>
}

const rateLimit: RateLimitState = { history: new Map() }

function logLine(level: string, msg: string): void {
  const ts = new Date().toISOString()
  process.stderr.write(`${ts} | ${level} | ${msg}\n`)
}

function loadRegistrySessions(): Map<string, WatchdogSession> {
  const m = new Map<string, WatchdogSession>()
  if (!existsSync(REGISTRY_PATH)) {
    logLine('warn', `bot-registry not found at ${REGISTRY_PATH}; tmux fallback only`)
    return m
  }
  try {
    const lines = readFileSync(REGISTRY_PATH, 'utf-8').split('\n')
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const [session, projectDir, agentId, port] = line.split('|')
      if (session && agentId) {
        m.set(agentId, {
          session,
          projectDir: projectDir ?? '',
          port: port ?? '',
          source: 'bot-registry.compat',
        })
      }
    }
  } catch (err) {
    logLine('warn', `bot-registry read failed: ${err}`)
  }
  return m
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function loadDbProfileSessions(client: Client): Promise<Map<string, WatchdogSession>> {
  const result = await client.query<{
    agent_id: string
    home_directory: string | null
    channel_port: number | string | null
    metadata: unknown
  }>(
    `SELECT agent_id, home_directory, channel_port, metadata
       FROM agents
      WHERE agent_type NOT IN ('human', 'system')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
        AND status IS DISTINCT FROM 'disabled'
      ORDER BY agent_id`,
  )
  const sessions = new Map<string, WatchdogSession>()
  for (const row of result.rows) {
    const metadata = parseMetadata(row.metadata)
    const session = typeof metadata.tmux_session === 'string' ? metadata.tmux_session.trim() : ''
    if (!session) continue
    sessions.set(row.agent_id, {
      session,
      projectDir: row.home_directory ?? '',
      port: row.channel_port === null || row.channel_port === undefined ? '' : String(row.channel_port),
      source: 'agents.profile',
    })
  }
  return sessions
}

async function findCrashedAgents(client: Client): Promise<CrashedAgent[]> {
  const r = await client.query<{ agent_id: string; last_seen_at: Date | null; status: string | null }>(
    `SELECT agent_id, last_seen_at, status
       FROM agents
      WHERE agent_type NOT IN ('human', 'system')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
        AND status IS DISTINCT FROM 'offline'
        AND status IS DISTINCT FROM 'observer'
        AND status IS DISTINCT FROM 'disabled'
        AND (
          last_seen_at IS NULL
          OR last_seen_at < now() - make_interval(secs => $1)
        )`,
    [CRASH_THRESHOLD_SEC],
  )
  return r.rows.map(row => ({ agentId: row.agent_id, lastSeenAt: row.last_seen_at, status: row.status }))
}

function isRateLimited(agentId: string): boolean {
  const now = Date.now()
  const hourAgo = now - 3600 * 1000
  const hist = rateLimit.history.get(agentId) ?? []
  const recent = hist.filter(t => t > hourAgo)
  rateLimit.history.set(agentId, recent)
  return recent.length >= RATE_LIMIT_PER_HOUR
}

function recordRestart(agentId: string): void {
  const hist = rateLimit.history.get(agentId) ?? []
  hist.push(Date.now())
  rateLimit.history.set(agentId, hist)
}

function attemptRestart(agentId: string, sessionName: string | null): { outcome: string; detail: string } {
  if (DRY_RUN) return { outcome: 'dry_run', detail: `would restart ${sessionName ?? agentId}` }
  if (!sessionName) return { outcome: 'no_session', detail: `agent ${agentId} not in bot-registry` }

  // Try tmux send-keys Enter first (the cheapest, lets the bot's tmux
  // pane resume itself). Fall back to a full restart-bot.sh spawn.
  const tmuxR = spawnSync('tmux', ['send-keys', '-t', sessionName, 'Enter'], { encoding: 'utf-8', timeout: 3000 })
  if (tmuxR.status === 0) {
    return { outcome: 'tmux_send_keys', detail: `Enter sent to tmux session ${sessionName}` }
  }

  if (!existsSync(RESTART_SCRIPT)) {
    return { outcome: 'restart_script_missing', detail: `${RESTART_SCRIPT} not found` }
  }
  const child = spawn('bash', [RESTART_SCRIPT, sessionName], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return { outcome: 'restart_script_spawned', detail: `bash ${RESTART_SCRIPT} ${sessionName} (pid=${child.pid ?? 'unknown'})` }
}

async function recordAuditLog(client: Client, agentId: string, sessionName: string | null, restart: { outcome: string; detail: string }, lastSeenAt: Date | null): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
       VALUES ('bot.auto_restart', $1, $2, $3::jsonb, 'default')`,
      [
        agentId,
        sessionName ?? null,
        JSON.stringify({
          outcome: restart.outcome,
          detail: restart.detail,
          last_seen_at: lastSeenAt ? lastSeenAt.toISOString() : null,
          crash_threshold_sec: CRASH_THRESHOLD_SEC,
          dry_run: DRY_RUN,
        }),
      ],
    )
  } catch (err) {
    logLine('warn', `audit_log insert failed for ${agentId}: ${err}`)
  }
}

async function tickOnce(client: Client, registry: Map<string, WatchdogSession>): Promise<void> {
  const crashed = await findCrashedAgents(client)
  if (crashed.length === 0) return
  for (const a of crashed) {
    if (isRateLimited(a.agentId)) {
      logLine('warn', `rate-limit hit for ${a.agentId} (>=${RATE_LIMIT_PER_HOUR}/hr); skipping`)
      continue
    }
    const reg = registry.get(a.agentId) ?? null
    const sessionName = reg?.session ?? null
    logLine('info', `crashed: ${a.agentId} last_seen_at=${a.lastSeenAt?.toISOString() ?? 'null'} status=${a.status ?? 'unknown'} session=${sessionName ?? 'no-profile'} source=${reg?.source ?? 'none'}`)
    const restart = attemptRestart(a.agentId, sessionName)
    logLine('info', `restart attempt for ${a.agentId}: outcome=${restart.outcome} detail=${restart.detail}`)
    if (restart.outcome !== 'dry_run' && restart.outcome !== 'rate_limited') recordRestart(a.agentId)
    await recordAuditLog(client, a.agentId, sessionName, restart, a.lastSeenAt)
  }
}

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    logLine('error', 'DATABASE_URL is required')
    process.exit(1)
  }
  logLine('info', `starting watchdog poll=${POLL_SEC}s crash_threshold=${CRASH_THRESHOLD_SEC}s rate_limit=${RATE_LIMIT_PER_HOUR}/hr dry_run=${DRY_RUN}`)
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()

  let stopping = false
  const stop = () => { stopping = true; logLine('info', 'received stop signal'); client.end().catch(() => {}); process.exit(0) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  let registry = await loadDbProfileSessions(client)
  if (registry.size > 0) {
    logLine('info', `loaded ${registry.size} watchdog sessions from agents.profile`)
  } else {
    registry = loadRegistrySessions()
    logLine('warn', `loaded ${registry.size} watchdog sessions from bot-registry compatibility fallback`)
  }

  while (!stopping) {
    try {
      await tickOnce(client, registry)
    } catch (err) {
      logLine('error', `tick failed: ${err}`)
    }
    await new Promise(r => setTimeout(r, POLL_SEC * 1000))
  }
}

// Test-only export: allow `import { findCrashedAgents, isRateLimited,
// recordRestart }` for unit fixtures without running the daemon loop.
export { findCrashedAgents, isRateLimited, recordRestart, rateLimit, loadRegistrySessions, loadDbProfileSessions }

if (import.meta.main) {
  main().catch(err => {
    logLine('error', `fatal: ${err}`)
    process.exit(1)
  })
}
