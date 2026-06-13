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
 *   Spawn `scripts/restart-bot.sh <session>` directly. Restart script
 *   owns startup-safety preflight, DB profile lookup, orphan-port cleanup,
 *   tmux replacement, and Codex prompt handling. The watchdog must not send
 *   a blind Enter into an already-unhealthy TUI session.
 *
 * Safety knobs (Issue #278 §5 Open decisions, all overridable):
 *   AUN_WATCHDOG_POLL_SEC               default 30
 *   AUN_WATCHDOG_CRASH_THRESHOLD_SEC    default 300 (5 min)
 *   AUN_WATCHDOG_RATE_LIMIT_PER_HOUR    default 6  (per-bot cap)
 *   AUN_WATCHDOG_DRY_RUN=1              log only, no tmux / spawn
 *   DATABASE_URL                        required; agents table is profile SSOT
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
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DATABASE_URL = process.env.DATABASE_URL
const POLL_SEC = parseInt(process.env.AUN_WATCHDOG_POLL_SEC ?? '30', 10)
const CRASH_THRESHOLD_SEC = parseInt(process.env.AUN_WATCHDOG_CRASH_THRESHOLD_SEC ?? '300', 10)
const RATE_LIMIT_PER_HOUR = parseInt(process.env.AUN_WATCHDOG_RATE_LIMIT_PER_HOUR ?? '6', 10)
const DRY_RUN = process.env.AUN_WATCHDOG_DRY_RUN === '1'
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
  source: 'agents.profile'
}

interface RateLimitState {
  /** Per-agent restart timestamps (ms). Trimmed to last hour on each check. */
  history: Map<string, number[]>
}

interface RuntimeProfileIssue {
  agentId: string
  session: string
  reason: 'tmux_session_missing' | 'port_missing_expected_agent'
  detail: string
}

interface RuntimeLivenessChecks {
  hasTmuxSession(sessionName: string): boolean
  portHasExpectedAgent(port: string, agentId: string): boolean
}

const rateLimit: RateLimitState = { history: new Map() }

function logLine(level: string, msg: string): void {
  const ts = new Date().toISOString()
  process.stderr.write(`${ts} | ${level} | ${msg}\n`)
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function commandHasAgentId(command: string, agentId: string): boolean {
  const escapedAgentId = escapeRegExp(agentId)
  const agentIdAssignment = new RegExp(`(?:^|\\s)AGENT_ID=(?:"${escapedAgentId}"|'${escapedAgentId}'|${escapedAgentId})(?=\\s|$)`)
  return agentIdAssignment.test(command.trim())
}

function hasTmuxSession(sessionName: string): boolean {
  if (!sessionName) return false
  const r = spawnSync('tmux', ['has-session', '-t', sessionName], { encoding: 'utf-8', timeout: 3000 })
  return r.status === 0
}

function portHasExpectedAgent(port: string, agentId: string): boolean {
  if (!/^\d+$/.test(port)) return false
  const lsofR = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8', timeout: 3000 })
  if (lsofR.status !== 0 || !lsofR.stdout.trim()) return false

  for (const pid of lsofR.stdout.trim().split(/\s+/)) {
    const psR = spawnSync('ps', ['eww', '-p', pid, '-o', 'command='], { encoding: 'utf-8', timeout: 3000 })
    const command = psR.stdout ?? ''
    if (command.includes('bun') && command.includes('server.ts') && commandHasAgentId(command, agentId)) {
      return true
    }
  }
  return false
}

const runtimeLivenessChecks: RuntimeLivenessChecks = {
  hasTmuxSession,
  portHasExpectedAgent,
}

function findRuntimeProfileIssues(
  registry: Map<string, WatchdogSession>,
  checks: RuntimeLivenessChecks = runtimeLivenessChecks,
): RuntimeProfileIssue[] {
  const issues: RuntimeProfileIssue[] = []
  for (const [agentId, profile] of registry) {
    if (!profile.session) continue
    if (!checks.hasTmuxSession(profile.session)) {
      issues.push({
        agentId,
        session: profile.session,
        reason: 'tmux_session_missing',
        detail: `tmux session ${profile.session} is missing`,
      })
      continue
    }
    if (profile.port && !checks.portHasExpectedAgent(profile.port, agentId)) {
      issues.push({
        agentId,
        session: profile.session,
        reason: 'port_missing_expected_agent',
        detail: `port ${profile.port} has no bun server.ts with AGENT_ID=${agentId}`,
      })
    }
  }
  return issues
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
  if (!sessionName) return { outcome: 'no_session', detail: `agent ${agentId} has no tmux_session in DB profile` }

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

async function recordAuditLog(
  client: Client,
  agentId: string,
  sessionName: string | null,
  restart: { outcome: string; detail: string },
  lastSeenAt: Date | null,
  reason?: string,
): Promise<void> {
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
          reason,
        }),
      ],
    )
  } catch (err) {
    logLine('warn', `audit_log insert failed for ${agentId}: ${err}`)
  }
}

async function tickOnce(client: Client, registry: Map<string, WatchdogSession>): Promise<void> {
  // Phase 1: runtime profile checks (tmux session missing, port mismatch) — these
  // detect issues that bypass heartbeat-based detection (e.g. session died but DB
  // status is still 'idle' from the last heartbeat within threshold).
  const restarted = new Set<string>()
  for (const issue of findRuntimeProfileIssues(registry)) {
    if (isRateLimited(issue.agentId)) {
      logLine('warn', `rate-limit hit for ${issue.agentId} (>=${RATE_LIMIT_PER_HOUR}/hr); skipping`)
      continue
    }
    logLine('info', `runtime profile unhealthy: ${issue.agentId} reason=${issue.reason} detail=${issue.detail}`)
    const restart = attemptRestart(issue.agentId, issue.session)
    logLine('info', `restart attempt for ${issue.agentId}: outcome=${restart.outcome} detail=${restart.detail}`)
    if (restart.outcome !== 'dry_run' && restart.outcome !== 'rate_limited') recordRestart(issue.agentId)
    await recordAuditLog(client, issue.agentId, issue.session, restart, null, issue.reason)
    restarted.add(issue.agentId)
  }

  // Phase 2: heartbeat-based crash detection.
  const crashed = await findCrashedAgents(client)
  if (crashed.length === 0) return
  for (const a of crashed) {
    if (restarted.has(a.agentId)) continue
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

  const registry = await loadDbProfileSessions(client)
  if (registry.size > 0) {
    logLine('info', `loaded ${registry.size} watchdog sessions from agents.profile`)
  } else {
    logLine('warn', 'loaded 0 watchdog sessions from agents.profile; no fallback because agents table is SSOT')
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
export { commandHasAgentId, findCrashedAgents, findRuntimeProfileIssues, isRateLimited, recordRestart, rateLimit, loadDbProfileSessions }

if (import.meta.main) {
  main().catch(err => {
    logLine('error', `fatal: ${err}`)
    process.exit(1)
  })
}
