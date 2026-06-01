#!/usr/bin/env bun
/**
 * agent-com CLI — Channel, agent, and status management + message I/O.
 *
 * Usage:
 *   agent-com channel create <id> --name "Name" --members cto,dev-a
 *   agent-com channel add-member <channel_id> <agent_id>
 *   agent-com channel remove-member <channel_id> <agent_id>
 *   agent-com channel members <channel_id>
 *   agent-com agent register <agent_id> --display-name "Dev A" --type dev --runtime claude-code
 *   agent-com status
 *
 * Issue #132 — message-queue-spec §4-6 CLI commands (MVP):
 *   agent-com next                                          — fetch one unread message (oldest first)
 *   agent-com send --content "..." --mention cto            — reply to last next-fetched message
 *   agent-com agents                                        — list registered agents (JSON)
 *
 * `next` and `send` track the in-flight reply target via a per-agent state file
 * at `/tmp/agent-com-{AGENT_ID}.current`. AGENT_ID env var is required for both.
 */

import type { Client } from 'pg'
import { truncateForDiscord } from '../core/truncate'
import { createDbAdapter, type DbAdapter } from '../core/db'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash, createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fetchReplyChain, parseReplyChainDepth } from '../core/reply-chain'
import { fanoutToRecipients } from '../core/send-fanout'
import { outboundProjectionSkipCode, outboundProjectionSkipReason, resolveOutboundProjectionDecision } from '../core/outbound-projection'
import { decorateProjectedContent } from '../core/projection-text-decorator'
import { diagnoseInboundQueueRow, diagnoseOutboundQueueRow } from '../core/delivery-diagnostics'
import { buildQueueDoctorReport, formatQueueDoctorText } from '../core/queue-doctor'
import { buildQueueNormalizationReport, formatQueueNormalizationText } from '../core/queue-normalization'
import { buildDirectoryReport, formatDirectoryText } from '../core/directory'
import { buildRuntimeInventoryReport, formatRuntimeInventoryText } from '../core/runtime-inventory'
import {
  buildRuntimeCleanupReport,
  executeRuntimeCleanup,
  formatRuntimeCleanupText,
  parseLsofTcpListeners,
} from '../core/runtime-cleanup'
import { buildInboundSmokeReport, formatInboundSmokeText } from '../core/inbound-smoke'
import { buildAunFleetReadinessReport, formatAunFleetReadinessText } from '../core/aun-fleet-readiness'
import { buildFullChannelSmokeReport, formatFullChannelSmokeText } from '../core/full-channel-smoke'
import { buildQueueWakeSmokeReport, formatQueueWakeSmokeText } from '../core/state-daemon-readiness'
import {
  buildChannelRegistrationReconcileReport,
  formatChannelRegistrationReconcileText,
} from '../core/channel-registration-reconcile'
import { getAgentDiscordUiId, getDiscordUiBindingForAgent } from '../core/ui-bindings'
import {
  deterministicWorkspaceId,
  heartbeatRuntimeInstance,
  inferRuntimeSessionName,
  inferWorkspaceName,
  parseRuntimePort,
} from '../core/runtime-heartbeat'
import { closeObsoletePendingQueueRows, reassignPendingQueueRows, reclaimExpiredQueueClaims } from '../core/queue-repair'
import { getChannelPolicy, refreshChannelPolicyDbSnapshot } from '../core/channel-policy'
import { createOutboundPolicyValidator } from '../core/routing'
import { allocateConversationRootInTransaction } from '../core/conversation-control-plane'
import {
  applyConversationControlPlaneAllocation,
  type ConversationControlPlaneApplyResult,
} from '../core/conversation-control-plane-apply'
import { resolveConversationControlPlaneGate } from '../core/conversation-control-plane-rollout'
import {
  buildOwnerHandoffDiagnostic,
  ownerHandoffDiagnosticCode,
  recordOwnerHandoffDiagnostic,
} from '../core/owner-handoff-routing'
import {
  acquireControlPlaneLease,
  heartbeatControlPlaneLease,
  releaseControlPlaneLease,
  verifyControlPlaneFence,
  type LeasePurpose,
  type LeaseScopeType,
} from '../core/control-plane-leases'
import { syncChannelPolicyConnectors, type BindingRole, type OrderingScope } from '../core/channel-connector-sync'
import { buildLiveTmuxProfileDoctorBlockers, parseTmuxListPanes } from '../core/tmux-runtime-inspector'
import { profileExclusionReason } from '../core/profile-classification'

// --- DB connection ---
// `getDatabaseUrl()` is retained for callers that still need the raw PG URL
// (e.g. passed into `persistInboundDelivery` which opens its own pg.Client for
// the atomic 7b+7d transaction). The CLI itself no longer instantiates a
// pg.Client directly — it goes through `createDbAdapter()` so SQLite mode
// (`AGENT_COM_DB=sqlite`) works without pg being reachable.
function getDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv) return fromEnv
  const configPath = join(dirname(new URL(import.meta.url).pathname), '..', 'config.json')
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (config.database_url) return config.database_url
    } catch {}
  }
  return 'postgresql://localhost/agent_comms'
}

/**
 * Phase C v2.1.0 "F": detect SQLite mode so pg-only helpers (pg_notify,
 * pg_try_advisory_lock) silently no-op instead of throwing "no such function"
 * when the CLI runs against SQLite. Mirrors `createDbAdapter()`'s detection.
 */
function isSqliteMode(): boolean {
  const explicit = process.env.AGENT_COM_DB
  if (explicit === 'sqlite') return true
  if (explicit === 'postgres' || explicit === 'postgresql') return false
  // No explicit AGENT_COM_DB: default to sqlite unless DATABASE_URL is set.
  return !process.env.DATABASE_URL
}

/**
 * Phase C v2.1.0 "F": return a `pg.Client`-shaped shim backed by the unified
 * `DbAdapter`. All existing CLI call sites use `.query(sql, params)` and
 * `.end()`, which we re-expose with matching shapes so the migration is a
 * single swap at this boundary. For SQLite mode the backing adapter is
 * `SqliteAdapter` (bun:sqlite, `AGENT_COM_SQLITE_PATH`); for postgres it is
 * `PgAdapter` (pg.Client, `DATABASE_URL`). pg-only queries (pg_notify /
 * pg_try_advisory_lock) will throw in SQLite mode — callers either gate on
 * `isSqliteMode()` or wrap in try/catch, which is how the existing CLI was
 * already written.
 */
async function getDb(): Promise<Client> {
  const adapter = createDbAdapter()
  const shim = {
    query: async (sql: string, params?: any[]) => {
      const rows = await adapter.query(sql, params)
      return { rows, rowCount: rows.length }
    },
    end: async (): Promise<void> => {
      await adapter.close()
    },
    // Raw adapter exposed for callers that need execute()/transaction() semantics.
    __adapter: adapter,
  } as unknown as Client & { __adapter: DbAdapter }
  return shim
}

// --- Helpers ---
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(argv[i])
    }
  }
  return { positional, flags }
}

function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  return !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

function hasFlag(flags: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key)
}

function parsePositiveIntFlag(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Error: --${name} must be a positive integer`)
    process.exit(2)
  }
  return parsed
}

function parseCsvFlag(value: string | undefined): string[] | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === 'none' || trimmed === 'null') return []
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
}

function parsePolicyArray(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === 'none' || trimmed === 'null') return null
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    }
  } catch {}
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseRepairDryRun(flags: Record<string, string>): boolean {
  const execute = flagEnabled(flags.execute)
  const dryRun = flagEnabled(flags['dry-run'])
  if (execute && dryRun) {
    console.error('Error: use either --execute or --dry-run, not both')
    process.exit(2)
  }
  if (hasFlag(flags, 'execute') && !execute) return true
  return !execute
}

async function auditLog(db: Client, eventType: string, agentId: string | null, target: string | null, detail: Record<string, unknown>) {
  await db.query(
    'INSERT INTO audit_log (event_type, agent_id, target, detail, org_id) VALUES ($1, $2, $3, $4, $5)',
    [eventType, agentId, target, JSON.stringify(detail), 'default']
  )
}

type ExplicitReplyQueueRow = {
  id: number | string
  agent_id: string
  message_id: string | null
  payload: string | null
  status: string
  claimed_by: string | null
  claim_expires_at: string | Date | null
  replied_with: string | null
}

type ClaimRenewalEvidence = {
  renewed: true
  mode: 'exact_queue_id_same_owner'
  reason: 'expired_same_owner_before_reply_close'
  queue_id: number | string
  message_id: string | null
  agent_id: string
  claimed_by: string
  prior_claim_expires_at: string | null
  new_claim_expires_at: string
  ttl_seconds: number
  audit_event_type: 'queue.claim_renewed'
  authorization: 'exact_queue_id_and_same_claim_owner'
  free_form_text_authorizes_renewal: false
}

const ACTIVE_REPLY_CLAIM_STATUSES = new Set(['received', 'in_progress'])
const TERMINAL_REPLY_CLOSE_STATUSES = new Set(['replied', 'done', 'skipped', 'failed'])
const MAX_CLAIM_RENEWAL_TTL_SEC = 15 * 60

function parseQueuePayloadLoose(payload: string | null): Record<string, any> {
  if (!payload) return {}
  try {
    const parsed = JSON.parse(payload)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeDateString(value: string | Date | null): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function dateMs(value: string | Date | null): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function claimRenewalTtlSeconds(): number {
  const raw = Number.parseInt(process.env.AGENT_COMMS_CLAIM_TTL_SEC ?? '60', 10)
  const ttl = Number.isFinite(raw) && raw > 0 ? raw : 60
  return Math.min(ttl, MAX_CLAIM_RENEWAL_TTL_SEC)
}

function replyToForQueueRow(row: ExplicitReplyQueueRow): string | null {
  const payload = parseQueuePayloadLoose(row.payload)
  return row.message_id ?? (typeof payload.message_id === 'string' ? payload.message_id : null)
}

async function renewSameOwnerClaimForReplyClose(
  db: Client,
  row: ExplicitReplyQueueRow,
  agentId: string,
): Promise<ClaimRenewalEvidence> {
  if (!ACTIVE_REPLY_CLAIM_STATUSES.has(row.status)) {
    throw new Error(`INVALID_STATE: queue_id=${row.id} status=${row.status}; expected received|in_progress`)
  }
  if (row.agent_id !== agentId || row.claimed_by !== agentId) {
    throw new Error(`NOT_CLAIM_OWNER: queue_id=${row.id} is not claimed by ${agentId}`)
  }
  const ttlSeconds = claimRenewalTtlSeconds()
  const newClaimExpiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
  const evidence: ClaimRenewalEvidence = {
    renewed: true,
    mode: 'exact_queue_id_same_owner',
    reason: 'expired_same_owner_before_reply_close',
    queue_id: row.id,
    message_id: replyToForQueueRow(row),
    agent_id: agentId,
    claimed_by: agentId,
    prior_claim_expires_at: normalizeDateString(row.claim_expires_at),
    new_claim_expires_at: newClaimExpiresAt,
    ttl_seconds: ttlSeconds,
    audit_event_type: 'queue.claim_renewed',
    authorization: 'exact_queue_id_and_same_claim_owner',
    free_form_text_authorizes_renewal: false,
  }
  await auditLog(db, 'queue.claim_renewed', agentId, String(row.id), {
    ...evidence,
    surface: 'cli.send.explicit_close',
  })
  const updated = await db.query(
    `UPDATE message_queue
        SET claim_expires_at = $1,
            claimed_at = COALESCE(claimed_at, now())
      WHERE id = $2
        AND agent_id = $3
        AND claimed_by = $3
        AND status IN ('received', 'in_progress')
      RETURNING id`,
    [newClaimExpiresAt, row.id, agentId],
  )
  if (updated.rows.length !== 1) {
    throw new Error(`RACE: queue_id=${row.id} changed before claim renewal`)
  }
  return evidence
}

async function loadReplyCloseReplay(
  db: Client,
  row: ExplicitReplyQueueRow,
  agentId: string,
): Promise<
  | { kind: 'idempotent'; response: Record<string, unknown> }
  | { kind: 'terminal'; response: Record<string, unknown> }
  | { kind: 'ambiguous'; response: Record<string, unknown> }
> {
  if (!row.replied_with) {
    if (row.status === 'replied') {
      return {
        kind: 'ambiguous',
        response: {
          code: 'RECONCILE_REQUIRED',
          detail: 'queue row is replied but missing replied_with evidence',
          queue_id: row.id,
          message_id: replyToForQueueRow(row),
          status: row.status,
        },
      }
    }
    return {
      kind: 'terminal',
      response: {
        code: 'ALREADY_CLOSED',
        detail: `queue row is already terminal (${row.status})`,
        queue_id: row.id,
        message_id: replyToForQueueRow(row),
        status: row.status,
        replied_with: null,
      },
    }
  }

  const replyRows = await db.query<{
    id: string
    channel_id: string | null
    author_id: string | null
    reply_to: string | null
  }>(
    `SELECT id, channel_id, author_id, reply_to
       FROM agent_messages
      WHERE id = $1
      LIMIT 1`,
    [row.replied_with],
  )
  const outboundRows = await db.query<{ id: number | string; status: string }>(
    `SELECT id, status
       FROM outbound_queue
      WHERE message_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 10`,
    [row.replied_with],
  )
  const reply = replyRows.rows[0] ?? null
  const originalMessageId = replyToForQueueRow(row)
  const replyMatchesQueue = !!reply
    && reply.author_id === agentId
    && (!originalMessageId || reply.reply_to === originalMessageId)

  if (row.status === 'replied' && replyMatchesQueue) {
    return {
      kind: 'idempotent',
      response: {
        ok: true,
        code: 'IDEMPOTENT_REPLY_CLOSE',
        idempotent: true,
        queue_id: row.id,
        message_id: originalMessageId,
        replied_with: row.replied_with,
        outbound_message_id: row.replied_with,
        work_closed: true,
        close_mode: 'idempotent',
        evidence: {
          queue_status: row.status,
          reply_message_present: true,
          outbound_queue_count: outboundRows.rows.length,
        },
      },
    }
  }

  return {
    kind: 'ambiguous',
    response: {
      code: 'RECONCILE_REQUIRED',
      detail: 'queue row has prior reply/outbound evidence that cannot be replayed safely',
      queue_id: row.id,
      message_id: originalMessageId,
      status: row.status,
      replied_with: row.replied_with,
      evidence: {
        reply_message_present: !!reply,
        reply_message_matches_queue: replyMatchesQueue,
        outbound_queue_count: outboundRows.rows.length,
      },
    },
  }
}

function getRawDbAdapter(db: Client): DbAdapter | null {
  return (db as Client & { __adapter?: DbAdapter }).__adapter ?? null
}

async function loadMessageConversationId(db: Client, messageId: string): Promise<string | null> {
  try {
    const row = await db.query<{ conversation_id: string | null }>(
      `SELECT conversation_id FROM agent_messages WHERE id = $1 LIMIT 1`,
      [messageId],
    )
    return row.rows[0]?.conversation_id ?? null
  } catch {
    return null
  }
}

function summarizeConversationControlPlaneResult(result: ConversationControlPlaneApplyResult): Record<string, unknown> {
  if (result.ok === false) {
    const summary: Record<string, unknown> = { ok: false }
    if ('action' in result) {
      summary.action = result.action
      summary.mode = result.gate.mode
      summary.audit_only = result.gate.audit_only
      summary.block_on_error = result.gate.block_on_error
    }
    if ('allocation_error' in result) {
      summary.error = result.allocation_error.error
      summary.allocation_error = result.allocation_error.error
      summary.allocation_error_detail = result.allocation_error.detail ?? null
    } else {
      summary.error = result.error
    }
    return summary
  }
  const summary: Record<string, unknown> = {
    ok: true,
    action: result.action,
    mode: result.gate.mode,
    audit_only: result.gate.audit_only,
    block_on_error: result.gate.block_on_error,
  }
  if (result.allocation) {
    summary.conversation_id = result.allocation.conversation_id
    summary.baton_id = result.allocation.baton_id
    summary.conversation_action = result.allocation.conversation_action
    summary.baton_action = result.allocation.baton_action
  }
  if (result.allocation_error) {
    summary.allocation_error = result.allocation_error.error
    summary.allocation_error_detail = result.allocation_error.detail ?? null
  }
  return summary
}

function conversationControlPlaneFailureError(result: ConversationControlPlaneApplyResult): string {
  if ('allocation_error' in result) return result.allocation_error.error
  if ('error' in result) return result.error
  return 'CONVERSATION_CONTROL_PLANE_UNKNOWN_ERROR'
}

function conversationControlPlaneFailureDetail(result: ConversationControlPlaneApplyResult): string | null {
  if ('allocation_error' in result) return result.allocation_error.detail ?? null
  return null
}

async function pgNotify(db: Client, channel: string, payload: Record<string, unknown>) {
  if (process.env.AGENT_COM_PG_NOTIFY === 'false') return
  if (isSqliteMode()) return  // SQLite has no pg_notify — silently skip
  try {
    await db.query(`SELECT pg_notify($1, $2)`, [channel, JSON.stringify(payload)])
  } catch (err) {
    process.stderr.write(`agent-com: pg_notify failed (non-fatal): ${err}\n`)
  }
}

type CliOutboundPolicyResult =
  | { ok: true; outbound_allowlist: string[] | null; policy_source: string }
  | {
      ok: false
      violations: string[]
      outbound_allowlist: string[] | null
      policy_source: string
      violated_policy: 'channel.outboundAllowlist'
    }

type CliOutboundPolicyViolation = Extract<CliOutboundPolicyResult, { ok: false }>

async function validateCliOutboundPolicy(
  db: Client,
  sender: string,
  channelId: string,
  recipients: string[],
): Promise<CliOutboundPolicyResult> {
  await refreshChannelPolicyDbSnapshot(db as any)
  const policy = getChannelPolicy(channelId)
  const sourceRows = await db.query(
    `SELECT policy_source FROM channel_routing_policy WHERE channel_id = $1`,
    [channelId],
  ).catch(() => ({ rows: [] as any[] }))
  const policySource = sourceRows.rows[0]?.policy_source ?? policy.policySource
  const result = createOutboundPolicyValidator().validate(sender, channelId, recipients)
  if (result.ok === true) {
    return {
      ok: true,
      outbound_allowlist: policy.outboundAllowlist,
      policy_source: policySource,
    }
  }
  return {
    ok: false,
    violations: result.violations,
    outbound_allowlist: policy.outboundAllowlist,
    policy_source: policySource,
    violated_policy: 'channel.outboundAllowlist',
  }
}

async function auditOutboundAclViolation(
  db: Client,
  operation: 'send' | 'notify',
  sender: string,
  channelId: string,
  recipients: string[],
  aclResult: CliOutboundPolicyViolation,
) {
  await auditLog(db, 'outbound.acl_violation', sender, channelId, {
    operation,
    sender,
    intended_recipients: recipients,
    channel_id: channelId,
    violated_policy: aclResult.violated_policy,
    outbound_allowlist: aclResult.outbound_allowlist,
    policy_source: aclResult.policy_source,
    violations: aclResult.violations,
  })
}

// --- Commands ---

async function channelCreate(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const id = positional[0]
  if (!id) { console.error('Usage: agent-com channel create <id> [--name "Name"] [--members cto,dev-a]'); process.exit(1) }

  const name = flags.name ?? id
  const members = flags.members ? flags.members.split(',').map(m => m.trim()) : []

  const db = await getDb()
  await db.query(
    `INSERT INTO channels (id, org_id, type, name, members, created_by, created_at, updated_at)
     VALUES ($1, 'default', 'channel', $2, $3, 'cli', now(), now())
     ON CONFLICT (id) DO UPDATE SET name = $2, members = $3, updated_at = now()`,
    [id, name, members]
  )
  await auditLog(db, 'channel.create', 'cli', id, { name, members })
  await pgNotify(db, 'agent_events', { event: 'channel.created', channel_id: id, created_by: 'cli' })
  console.log(`Channel '${id}' created (members: ${members.join(', ') || 'none'})`)
  await db.end()
}

async function channelAddMember(args: string[]) {
  const [channelId, agentId] = args
  if (!channelId || !agentId) { console.error('Usage: agent-com channel add-member <channel_id> <agent_id>'); process.exit(1) }

  const db = await getDb()
  const r = await db.query('SELECT members FROM channels WHERE id = $1', [channelId])
  if (r.rows.length === 0) { console.error(`Channel '${channelId}' not found`); await db.end(); process.exit(1) }

  const members: string[] = r.rows[0].members ?? []
  if (members.includes(agentId)) { console.log(`'${agentId}' is already a member of '${channelId}'`); await db.end(); return }

  members.push(agentId)
  await db.query('UPDATE channels SET members = $1, updated_at = now() WHERE id = $2', [members, channelId])
  await auditLog(db, 'channel.member_add', 'cli', channelId, { agent_id: agentId })
  await pgNotify(db, 'agent_events', { event: 'channel.member_add', channel_id: channelId, agent_id: agentId })
  console.log(`Added '${agentId}' to '${channelId}' (${members.length} members)`)
  await db.end()
}

async function channelRemoveMember(args: string[]) {
  const [channelId, agentId] = args
  if (!channelId || !agentId) { console.error('Usage: agent-com channel remove-member <channel_id> <agent_id>'); process.exit(1) }

  const db = await getDb()
  const r = await db.query('SELECT members FROM channels WHERE id = $1', [channelId])
  if (r.rows.length === 0) { console.error(`Channel '${channelId}' not found`); await db.end(); process.exit(1) }

  const members: string[] = (r.rows[0].members ?? []).filter((m: string) => m !== agentId)
  await db.query('UPDATE channels SET members = $1, updated_at = now() WHERE id = $2', [members, channelId])
  await auditLog(db, 'channel.member_remove', 'cli', channelId, { agent_id: agentId })
  await pgNotify(db, 'agent_events', { event: 'channel.member_remove', channel_id: channelId, agent_id: agentId })
  console.log(`Removed '${agentId}' from '${channelId}' (${members.length} members)`)
  await db.end()
}

async function channelMembers(args: string[]) {
  const [channelId] = args
  if (!channelId) { console.error('Usage: agent-com channel members <channel_id>'); process.exit(1) }

  const db = await getDb()
  const r = await db.query('SELECT id, name, members FROM channels WHERE id = $1', [channelId])
  if (r.rows.length === 0) { console.error(`Channel '${channelId}' not found`); await db.end(); process.exit(1) }

  const ch = r.rows[0]
  const members: string[] = ch.members ?? []
  console.log(`Channel: ${ch.id} (${ch.name ?? 'unnamed'})`)
  console.log(`Members (${members.length}):`)
  for (const m of members) console.log(`  - ${m}`)
  await db.end()
}

async function channelReconcile(args: string[]) {
  const { flags } = parseArgs(args)
  const dryRun = parseRepairDryRun(flags)
  const format = flags.format ?? 'json'
  const windowHours = parsePositiveIntFlag(flags['window-hours'], 168, 'window-hours')
  const db = await getDb()
  try {
    const report = await buildChannelRegistrationReconcileReport((db as any).__adapter, {
      provider: flags.provider ?? 'discord',
      windowHours,
      externalChannelId: flags.channel ?? flags['external-channel-id'] ?? null,
      adapterOwnerAgentId: flags['adapter-owner'] ?? null,
      primaryAgentId: flags.primary === 'none' ? null : (flags.primary ?? null),
      members: parseCsvFlag(flags.members) ?? [],
      dryRun,
      confirmPlanHash: flags.confirm ?? null,
      sqlDialect: isSqliteMode() ? 'sqlite' : 'postgres',
    })
    if (format === 'text') {
      process.stdout.write(formatChannelRegistrationReconcileText(report))
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
    if (!report.ok) process.exitCode = 2
  } finally {
    await db.end()
  }
}

function botRoutingConfigPath(): string {
  if (process.env.AGENT_COM_BOT_ROUTING_PATH) return process.env.AGENT_COM_BOT_ROUTING_PATH
  const repoRoot = new URL('..', import.meta.url).pathname
  return join(repoRoot, 'config', 'bot-routing.json')
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseDbStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1).split(',').map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean)
  }
  const parsed = parsePolicyArray(trimmed)
  return parsed ?? []
}

type BootstrapAgent = {
  agent_id: string
  agent_type: string
  runtime: string
  status: string
  metadata: Record<string, unknown>
}

function isReadyProjectionOwner(agent: BootstrapAgent | undefined): boolean {
  if (!agent || agent.agent_type === 'human') return false
  if (!['idle', 'online', 'busy'].includes(agent.status)) return false
  const discordId = agent.metadata.discord_id
  return typeof discordId === 'string' && discordId.trim().length > 0
}

function ownerFromAdapterMetadata(raw: unknown): string | null {
  const metadata = parseJsonObject(raw)
  const value = metadata.consumer_agent_id
    ?? metadata.adapter_owner
    ?? metadata.adapterOwner
    ?? metadata.owner_agent_id
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isMissingColumnError(err: unknown, column: string): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return new RegExp(column, 'i').test(message) && /(no such column|column .* does not exist|does not exist)/i.test(message)
}

function chooseBootstrapOwner(row: any, members: string[], agents: Map<string, BootstrapAgent>): string | null {
  const metadataOwner = ownerFromAdapterMetadata(row.adapter_metadata)
  if (metadataOwner && isReadyProjectionOwner(agents.get(metadataOwner))) return metadataOwner

  const channelName = String(row.name ?? '').toLowerCase()
  const preferredByChannel = [
    [/audit|approval/, 'auditor'],
    [/ceo-vice|executive/, 'vice'],
  ] as Array<[RegExp, string]>
  for (const [pattern, agentId] of preferredByChannel) {
    if (pattern.test(channelName) && members.includes(agentId) && isReadyProjectionOwner(agents.get(agentId))) {
      return agentId
    }
  }

  const candidates = members
    .map((agentId, index) => ({ agentId, index, agent: agents.get(agentId) }))
    .filter((item) => isReadyProjectionOwner(item.agent))
    .map((item) => {
      let score = 0
      if (item.agentId.endsWith('-dev')) score += 50
      if (item.agentId.includes('lead')) score += 45
      if (item.agent?.runtime === 'TUI') score += 10
      if (item.agentId.startsWith('codex-')) score -= 20
      if (item.agentId === 'auditor') score += 5
      return { ...item, score }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)

  return candidates[0]?.agentId ?? null
}

async function buildDirectoryBootstrapPolicies(db: Client, flags: Record<string, string>) {
  const includeDm = flagEnabled(flags['include-dm'])
  const overwrite = flagEnabled(flags.overwrite)
  const extraAllowlist = parseCsvFlag(flags['extra-allowlist']) ?? []
  let agentRows
  try {
    agentRows = await db.query(
      `SELECT agent_id, agent_type, runtime, status, metadata
         FROM agents
        ORDER BY agent_id`,
    )
  } catch (err) {
    if (!isMissingColumnError(err, 'runtime')) throw err
    agentRows = await db.query(
      `SELECT agent_id, agent_type, cli_type AS runtime, status, metadata
         FROM agents
        ORDER BY agent_id`,
    )
  }
  const agents = new Map<string, BootstrapAgent>(
    agentRows.rows.map((row: any) => [
      String(row.agent_id),
      {
        agent_id: String(row.agent_id),
        agent_type: String(row.agent_type ?? ''),
        runtime: String(row.runtime ?? ''),
        status: String(row.status ?? ''),
        metadata: parseJsonObject(row.metadata),
      },
    ]),
  )
  const existing = await db.query(`SELECT channel_id FROM channel_routing_policy`)
  const existingPolicyChannels = new Set(existing.rows.map((row: any) => String(row.channel_id)))
  const channelRows = await db.query(
    `SELECT c.id, c.name, c.type, c.members, ca.metadata AS adapter_metadata
       FROM channels c
       JOIN channel_adapters ca
         ON ca.channel_id = c.id
        AND ca.platform = 'discord'
      ORDER BY c.name, c.id`,
  )

  const policies: Array<{
    channel_id: string
    channel_name: string | null
    primary_agent_id: string
    adapter_owner_agent_id: string
    outbound_allowlist: string[]
    native_role_outbound_owners: Record<string, unknown>
    native_projection_identities: Record<string, unknown>
    policy_source: string
  }> = []
  const skipped: Array<{ channel_id: string; channel_name: string | null; reason: string }> = []

  for (const row of channelRows.rows) {
    const channelId = String(row.id)
    const channelName = row.name ? String(row.name) : null
    if (!includeDm && String(row.type ?? '') === 'dm') {
      skipped.push({ channel_id: channelId, channel_name: channelName, reason: 'dm_skipped' })
      continue
    }
    if (!overwrite && existingPolicyChannels.has(channelId)) {
      skipped.push({ channel_id: channelId, channel_name: channelName, reason: 'policy_exists' })
      continue
    }
    const members = parseDbStringArray(row.members)
    const owner = chooseBootstrapOwner(row, members, agents)
    if (!owner) {
      skipped.push({ channel_id: channelId, channel_name: channelName, reason: 'no_ready_discord_bot_member' })
      continue
    }
    const outboundAllowlist = [...new Set([...members, ...extraAllowlist].filter(Boolean))]
    policies.push({
      channel_id: channelId,
      channel_name: channelName,
      primary_agent_id: owner,
      adapter_owner_agent_id: owner,
      outbound_allowlist: outboundAllowlist,
      native_role_outbound_owners: {},
      native_projection_identities: {},
      policy_source: 'directory_bootstrap',
    })
  }

  return { policies, skipped, overwrite, include_dm: includeDm, extra_allowlist: extraAllowlist }
}

async function assertPolicyAgentsExist(db: Client, agentIds: string[]) {
  const ids = [...new Set(agentIds.filter(Boolean))]
  if (ids.length === 0) return
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await db.query(`SELECT agent_id FROM agents WHERE agent_id IN (${placeholders})`, ids)
  const found = new Set(rows.rows.map((row: any) => String(row.agent_id)))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new Error(`unknown policy agent_id(s): ${missing.join(', ')}`)
  }
}

async function loadKnownAgentIds(db: Client): Promise<string[]> {
  const rows = await db.query(`SELECT agent_id FROM agents ORDER BY agent_id`)
  return rows.rows.map((row: any) => String(row.agent_id))
}

async function assertPolicyChannelsExist(db: Client, channelIds: string[]) {
  const ids = [...new Set(channelIds.filter(Boolean))]
  if (ids.length === 0) return
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await db.query(`SELECT id FROM channels WHERE id IN (${placeholders})`, ids)
  const found = new Set(rows.rows.map((row: any) => String(row.id)))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new Error(`unknown policy channel_id(s): ${missing.join(', ')}`)
  }
}

function normalizePolicyRowForOutput(row: any) {
  return {
    channel_id: row.channel_id,
    primary_agent_id: row.primary_agent_id ?? null,
    adapter_owner_agent_id: row.adapter_owner_agent_id ?? null,
    outbound_allowlist: parsePolicyArray(row.outbound_allowlist),
    native_role_outbound_owners: parseJsonObject(row.native_role_outbound_owners),
    native_projection_identities: parseJsonObject(row.native_projection_identities),
    policy_source: row.policy_source,
    updated_at: row.updated_at,
  }
}

async function upsertChannelPolicy(db: Client, policy: {
  channel_id: string
  primary_agent_id: string | null
  adapter_owner_agent_id: string | null
  outbound_allowlist: string[] | null
  native_role_outbound_owners: Record<string, unknown>
  native_projection_identities: Record<string, unknown>
  policy_source: string
}) {
  await db.query(
    `INSERT INTO channel_routing_policy (
       channel_id,
       primary_agent_id,
       adapter_owner_agent_id,
       outbound_allowlist,
       native_role_outbound_owners,
       native_projection_identities,
       policy_source,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (channel_id) DO UPDATE SET
       primary_agent_id = EXCLUDED.primary_agent_id,
       adapter_owner_agent_id = EXCLUDED.adapter_owner_agent_id,
       outbound_allowlist = EXCLUDED.outbound_allowlist,
       native_role_outbound_owners = EXCLUDED.native_role_outbound_owners,
       native_projection_identities = EXCLUDED.native_projection_identities,
       policy_source = EXCLUDED.policy_source,
       updated_at = now()`,
    [
      policy.channel_id,
      policy.primary_agent_id,
      policy.adapter_owner_agent_id,
      policy.outbound_allowlist === null ? null : JSON.stringify(policy.outbound_allowlist),
      JSON.stringify(policy.native_role_outbound_owners),
      JSON.stringify(policy.native_projection_identities),
      policy.policy_source,
    ],
  )
}

async function channelPolicy(args: string[]) {
  const [action, ...rest] = args
  const { positional, flags } = parseArgs(rest)
  const format = flags.format ?? 'text'
  const db = await getDb()
  try {
    if (action === 'list') {
      const rows = await db.query(
        `SELECT channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist,
                native_role_outbound_owners, native_projection_identities, policy_source, updated_at
           FROM channel_routing_policy
          ORDER BY channel_id`,
      )
      const policies = rows.rows.map(normalizePolicyRowForOutput)
      if (format === 'json') {
        process.stdout.write(`${JSON.stringify({ ok: true, policies }, null, 2)}\n`)
        return
      }
      console.log(`Channel policies (${policies.length}):`)
      for (const row of policies) {
        console.log(`  ${row.channel_id}: primary=${row.primary_agent_id ?? '-'} adapter=${row.adapter_owner_agent_id ?? '-'} allowlist=${JSON.stringify(row.outbound_allowlist ?? null)} source=${row.policy_source}`)
      }
      return
    }

    if (action === 'import-json') {
      const dryRun = parseRepairDryRun(flags)
      const path = flags.path ?? botRoutingConfigPath()
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
        channels?: Record<string, {
          primary?: string | null
          adapterOwner?: string | null
          outboundAllowlist?: string[]
          nativeRoleOutboundOwners?: Record<string, unknown>
          nativeProjectionIdentities?: Record<string, unknown>
        }>
      }
      const policies = Object.entries(parsed.channels ?? {}).map(([channelId, entry]) => ({
        channel_id: channelId,
        primary_agent_id: entry.primary ?? null,
        adapter_owner_agent_id: entry.adapterOwner ?? null,
        outbound_allowlist: Array.isArray(entry.outboundAllowlist) ? entry.outboundAllowlist : null,
        native_role_outbound_owners: parseJsonObject(entry.nativeRoleOutboundOwners),
          native_projection_identities: parseJsonObject(entry.nativeProjectionIdentities),
          policy_source: 'json_import',
        }))
      await assertPolicyChannelsExist(db, policies.map((policy) => policy.channel_id))
      for (const policy of policies) {
        await assertPolicyAgentsExist(db, [
          policy.primary_agent_id ?? '',
          policy.adapter_owner_agent_id ?? '',
          ...(policy.outbound_allowlist ?? []),
          ...Object.values(policy.native_role_outbound_owners).filter((v): v is string => typeof v === 'string'),
          ...Object.values(policy.native_projection_identities).filter((v): v is string => typeof v === 'string'),
        ])
      }
      if (!dryRun) {
        for (const policy of policies) await upsertChannelPolicy(db, policy)
        await auditLog(db, 'channel.policy_import_json', 'cli', null, { path, count: policies.length })
        await refreshChannelPolicyDbSnapshot(db as any)
      }
      process.stdout.write(`${JSON.stringify({ ok: true, dry_run: dryRun, count: policies.length, policies }, null, 2)}\n`)
      return
    }

    if (action === 'bootstrap') {
      const dryRun = parseRepairDryRun(flags)
      const bootstrap = await buildDirectoryBootstrapPolicies(db, flags)
      await assertPolicyChannelsExist(db, bootstrap.policies.map((policy) => policy.channel_id))
      for (const policy of bootstrap.policies) {
        await assertPolicyAgentsExist(db, [
          policy.primary_agent_id,
          policy.adapter_owner_agent_id,
          ...policy.outbound_allowlist,
        ])
      }
      if (!dryRun) {
        for (const policy of bootstrap.policies) {
          await upsertChannelPolicy(db, {
            channel_id: policy.channel_id,
            primary_agent_id: policy.primary_agent_id,
            adapter_owner_agent_id: policy.adapter_owner_agent_id,
            outbound_allowlist: policy.outbound_allowlist,
            native_role_outbound_owners: policy.native_role_outbound_owners,
            native_projection_identities: policy.native_projection_identities,
            policy_source: policy.policy_source,
          })
        }
        await auditLog(db, 'channel.policy_bootstrap_directory', 'cli', null, {
          count: bootstrap.policies.length,
          skipped_count: bootstrap.skipped.length,
          overwrite: bootstrap.overwrite,
          include_dm: bootstrap.include_dm,
          extra_allowlist: bootstrap.extra_allowlist,
        })
        await refreshChannelPolicyDbSnapshot(db as any)
      }
      process.stdout.write(`${JSON.stringify({
        ok: true,
        dry_run: dryRun,
        count: bootstrap.policies.length,
        skipped_count: bootstrap.skipped.length,
        policies: bootstrap.policies,
        skipped: bootstrap.skipped,
      }, null, 2)}\n`)
      return
    }

    if (action === 'sync-connectors') {
      const dryRun = parseRepairDryRun(flags)
      const maxConcurrency = parsePositiveIntFlag(flags['max-concurrency'], 1, 'max-concurrency')
      const report = await syncChannelPolicyConnectors((db as any).__adapter, {
        dryRun,
        channel: flags.channel ?? null,
        provider: flags.provider ?? 'discord',
        bindingRole: (flags['binding-role'] ?? 'outbound') as BindingRole,
        orderingScope: (flags['ordering-scope'] ?? 'thread') as OrderingScope,
        maxConcurrency,
      })
      if (!dryRun) {
        await auditLog(db, 'channel.policy_sync_connectors', 'cli', flags.channel ?? null, {
          provider: report.provider,
          binding_role: report.binding_role,
          planned_count: report.planned.length,
          skipped_count: report.skipped.length,
          created_connectors: report.created_connectors,
          created_bindings: report.created_bindings,
        })
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    if (action === 'set') {
      const channelId = positional[0]
      if (!channelId) {
        console.error('Usage: agent-com channel policy set <channel_id> [--primary <agent|none>] [--adapter-owner <agent|none>] [--allowlist <a,b|none>] [--execute|--dry-run]')
        process.exit(1)
      }
      const dryRun = parseRepairDryRun(flags)
      const existing = await db.query(
        `SELECT channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist,
                native_role_outbound_owners, native_projection_identities
           FROM channel_routing_policy
          WHERE channel_id = $1`,
        [channelId],
      )
      const current = existing.rows[0] ?? {}
      const allowlistFlag = parseCsvFlag(flags.allowlist)
      const policy = {
        channel_id: channelId,
        primary_agent_id: flags.primary === undefined ? current.primary_agent_id ?? null : (flags.primary === 'none' ? null : flags.primary),
        adapter_owner_agent_id: flags['adapter-owner'] === undefined ? current.adapter_owner_agent_id ?? null : (flags['adapter-owner'] === 'none' ? null : flags['adapter-owner']),
        outbound_allowlist: flags.allowlist === undefined
          ? parsePolicyArray(current.outbound_allowlist)
          : (allowlistFlag && allowlistFlag.length > 0 ? allowlistFlag : null),
        native_role_outbound_owners: parseJsonObject(current.native_role_outbound_owners),
        native_projection_identities: parseJsonObject(current.native_projection_identities),
        policy_source: 'cli',
      }
      await assertPolicyChannelsExist(db, [channelId])
      await assertPolicyAgentsExist(db, [
        policy.primary_agent_id ?? '',
        policy.adapter_owner_agent_id ?? '',
        ...(policy.outbound_allowlist ?? []),
      ])
      if (!dryRun) {
        await upsertChannelPolicy(db, policy)
        await auditLog(db, 'channel.policy_set', 'cli', channelId, policy)
        await refreshChannelPolicyDbSnapshot(db as any)
      }
      process.stdout.write(`${JSON.stringify({ ok: true, dry_run: dryRun, policy }, null, 2)}\n`)
      return
    }

    console.error('Usage: agent-com channel policy <list|import-json|bootstrap|sync-connectors|set> ...')
    process.exit(1)
  } finally {
    await db.end()
  }
}

async function agentRegister(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const agentId = positional[0]
  if (!agentId) {
    console.error('Usage: agent-com agent register <agent_id> [--display-name "Name"] [--type dev] [--runtime claude-code] [--home-directory <path>] [--channel-port <port>] [--tmux-session <name>] [--runtime-engine <engine>] [--token-source-ref <ref>] [--expected-provider discord] [--expected-provider-subject <id>]')
    process.exit(1)
  }

  const profile = buildBotProfileInput(agentId, flags, {
    displayName: flags['display-name'] ?? agentId,
    agentType: flags.type ?? 'dev',
    runtime: flags.runtime ?? 'claude-code',
  })

  const db = await getDb()
  try {
    const row = await upsertBotProfile(db, profile, 'agent.register')
    await auditLog(db, 'agent.register', 'cli', agentId, {
      display_name: row.display_name,
      agent_type: row.agent_type,
      runtime: row.runtime,
      home_directory: row.home_directory,
      channel_port: row.channel_port,
      tmux_session: botProfileForOutput(row).tmux_session,
      runtime_engine_preference: row.runtime_engine_preference,
      provider_token_source_ref: row.provider_token_source_ref ? '(set)' : null,
      expected_provider_identity: parseJsonObject(row.expected_provider_identity),
      profile_enabled: row.profile_enabled,
      profile_revision: row.profile_revision,
    })
    await pgNotify(db, 'agent_events', { event: 'agent.register', agent_id: agentId })
    console.log(`Agent '${agentId}' registered (${row.display_name}, ${row.agent_type}/${row.runtime}, profile_revision=${row.profile_revision})`)
  } finally {
    await db.end()
  }
}

type BotProfileInput = {
  agentId: string
  uiId?: number | null
  uiHandle?: string | null
  displayName?: string | null
  agentType?: string | null
  runtime?: string | null
  homeDirectory?: string | null
  channelPort?: number | null
  tmuxSession?: string | null
  runtimeEnginePreference?: string | null
  providerTokenSourceRef?: string | null
  expectedProviderIdentity?: Record<string, unknown> | null
  profileEnabled?: boolean | null
}

type BotProfileProjection = {
  agent_id: string
  profile_revision: number
  dry_run?: boolean
  blockers: Array<Record<string, unknown>>
  actions: Array<Record<string, unknown>>
  deferred: Array<Record<string, unknown>>
}

function normalizeNullableText(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === 'none' || trimmed === 'null') return null
  return trimmed
}

function normalizeHomeDirectory(raw: string | undefined): string | null | undefined {
  const value = normalizeNullableText(raw)
  if (value === undefined || value === null) return value
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return resolve(expanded)
}

function parseOptionalBoolean(raw: string | undefined, name: string): boolean | null | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'enabled', 'enable'].includes(value)) return true
  if (['false', '0', 'no', 'disabled', 'disable'].includes(value)) return false
  if (['none', 'null'].includes(value)) return null
  throw new Error(`${name} must be true or false`)
}

function parseOptionalPort(raw: string | undefined, name: string): number | null | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === '' || value === 'none' || value === 'null') return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535`)
  }
  return port
}

function parseOptionalUiId(raw: string | undefined, name: string): number | null | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === '' || value === 'none' || value === 'null') return null
  const uiId = Number(value)
  if (!Number.isSafeInteger(uiId) || uiId <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return uiId
}

function looksLikeRawSecret(value: string): boolean {
  const trimmed = value.trim()
  if (/^(bot|bearer)\s+/i.test(trimmed)) return true
  if (trimmed.length > 50 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) return true
  return false
}

function buildExpectedProviderIdentity(flags: Record<string, string>): Record<string, unknown> | null | undefined {
  const provider = normalizeNullableText(flags['expected-provider'])
  const subject = normalizeNullableText(flags['expected-provider-subject'] ?? flags['expected-provider-id'])
  const kind = normalizeNullableText(flags['expected-provider-kind'])
  if (provider === undefined && subject === undefined && kind === undefined) return undefined
  if (provider === null || subject === null) return null
  if (!provider || !subject) {
    throw new Error('--expected-provider and --expected-provider-subject must be provided together')
  }
  return {
    provider,
    subject_id: subject,
    ...(kind ? { identity_kind: kind } : {}),
    source: 'bot_profile',
  }
}

function buildBotProfileInput(
  agentId: string,
  flags: Record<string, string>,
  defaults: Partial<BotProfileInput> = {},
): BotProfileInput {
  const tokenSource = normalizeNullableText(flags['token-source-ref'] ?? flags['provider-token-source-ref'])
  if (typeof tokenSource === 'string' && looksLikeRawSecret(tokenSource)) {
    throw new Error('provider token source must be a non-secret reference, not a raw token')
  }
  const uiId = parseOptionalUiId(flags['ui-id'], '--ui-id')
  const uiHandle = normalizeNullableText(flags['ui-handle'] ?? flags.handle)
  const displayName = normalizeNullableText(flags['display-name'])
  const agentType = normalizeNullableText(flags.type)
  const runtime = normalizeNullableText(flags.runtime)
  const homeDirectory = normalizeHomeDirectory(flags['home-directory'] ?? flags.home)
  const channelPort = parseOptionalPort(flags['channel-port'] ?? flags.port, '--channel-port')
  const tmuxSession = normalizeNullableText(flags['tmux-session'] ?? flags.session)
  const runtimeEnginePreference = normalizeNullableText(flags['runtime-engine'] ?? flags['runtime-engine-preference'])
  const expectedProviderIdentity = buildExpectedProviderIdentity(flags)
  const profileEnabled = parseOptionalBoolean(flags.enabled, '--enabled')
  return {
    agentId,
    uiId: uiId !== undefined ? uiId : defaults.uiId,
    uiHandle: uiHandle !== undefined ? uiHandle : defaults.uiHandle,
    displayName: displayName !== undefined ? displayName : defaults.displayName,
    agentType: agentType !== undefined ? agentType : defaults.agentType,
    runtime: runtime !== undefined ? runtime : defaults.runtime,
    homeDirectory: homeDirectory !== undefined ? homeDirectory : defaults.homeDirectory,
    channelPort: channelPort !== undefined ? channelPort : defaults.channelPort,
    tmuxSession: tmuxSession !== undefined ? tmuxSession : defaults.tmuxSession,
    runtimeEnginePreference: runtimeEnginePreference !== undefined ? runtimeEnginePreference : defaults.runtimeEnginePreference,
    providerTokenSourceRef: tokenSource !== undefined ? tokenSource : defaults.providerTokenSourceRef,
    expectedProviderIdentity: expectedProviderIdentity !== undefined ? expectedProviderIdentity : defaults.expectedProviderIdentity,
    profileEnabled: profileEnabled !== undefined ? profileEnabled : defaults.profileEnabled,
  }
}

async function upsertBotProfile(db: Client, input: BotProfileInput, source: string): Promise<any> {
  const expectedIdentityJson = input.expectedProviderIdentity === null
    ? null
    : JSON.stringify(input.expectedProviderIdentity ?? {})
  const enabled = input.profileEnabled
  const hasUiId = input.uiId !== undefined && input.uiId !== null
  const hasUiHandle = input.uiHandle !== undefined
  const hasDisplayName = input.displayName !== undefined
  const hasAgentType = input.agentType !== undefined
  const hasRuntime = input.runtime !== undefined
  const hasHomeDirectory = input.homeDirectory !== undefined
  const hasChannelPort = input.channelPort !== undefined
  const hasTmuxSession = input.tmuxSession !== undefined
  const hasRuntimeEnginePreference = input.runtimeEnginePreference !== undefined
  const hasProviderTokenSourceRef = input.providerTokenSourceRef !== undefined
  const hasExpectedProviderIdentity = input.expectedProviderIdentity !== undefined
  const hasProfileEnabled = input.profileEnabled !== undefined && input.profileEnabled !== null
  const existing = await db.query(
    `SELECT metadata FROM agents WHERE agent_id = $1`,
    [input.agentId],
  ).catch(() => ({ rows: [] as any[] }))
  const existingMetadata = parseJsonObject(existing.rows[0]?.metadata)
  let metadataForWrite: string | null = null
  if (hasTmuxSession) {
    const metadata = { ...existingMetadata }
    if (input.tmuxSession === null) delete metadata.tmux_session
    else metadata.tmux_session = input.tmuxSession
    metadataForWrite = JSON.stringify(metadata)
  }
  const defaultUiHandle = typeof existingMetadata.replaces === 'string' && existingMetadata.replaces.trim()
    ? existingMetadata.replaces.trim()
    : input.agentId
  const implicitUiIdSql = isSqliteMode()
    ? '(SELECT COALESCE(MAX(ui_id), 0) + 1 FROM agents)'
    : "nextval('agent_ui_id_seq')"
  const result = await db.query(
    `INSERT INTO agents (
       agent_id, org_id, display_name, agent_type, runtime, status, registered_at,
       metadata, ui_id, ui_handle, channel_port, home_directory, runtime_engine_preference, provider_token_source_ref,
       expected_provider_identity, profile_enabled, profile_revision,
       profile_source, profile_updated_at, disabled_at
     )
     VALUES (
       $1, 'default',
       CASE WHEN $11 THEN COALESCE($2, $1) ELSE $1 END,
       CASE WHEN $12 THEN COALESCE($3, 'dev') ELSE 'dev' END,
       CASE WHEN $13 THEN COALESCE($4, 'unknown') ELSE 'unknown' END,
       CASE WHEN $18 AND $9 = false THEN 'disabled' ELSE 'offline' END, now(),
       CASE WHEN $20 THEN COALESCE($19::jsonb, '{}'::jsonb) ELSE '{}'::jsonb END,
       CASE WHEN $24 THEN $23::bigint ELSE ${implicitUiIdSql} END,
       CASE WHEN $26 THEN $25 ELSE $27 END,
       CASE WHEN $22 THEN $21::int ELSE NULL END,
       CASE WHEN $14 THEN $5 ELSE NULL END,
       CASE WHEN $15 THEN $6 ELSE NULL END,
       CASE WHEN $16 THEN $7 ELSE NULL END,
       CASE WHEN $17 THEN COALESCE($8::jsonb, '{}'::jsonb) ELSE '{}'::jsonb END,
       CASE WHEN $18 THEN COALESCE($9, true) ELSE true END,
       1, $10, now(), CASE WHEN $18 AND $9 = false THEN now() ELSE NULL END
     )
     ON CONFLICT (agent_id) DO UPDATE SET
       display_name = CASE WHEN $11 THEN COALESCE($2, agents.agent_id) ELSE agents.display_name END,
       agent_type = CASE WHEN $12 THEN COALESCE($3, agents.agent_type) ELSE agents.agent_type END,
       runtime = CASE WHEN $13 THEN COALESCE($4, agents.runtime) ELSE agents.runtime END,
       metadata = CASE WHEN $20 THEN COALESCE($19::jsonb, '{}'::jsonb) ELSE agents.metadata END,
       ui_id = CASE WHEN $24 THEN $23::bigint ELSE COALESCE(agents.ui_id, ${implicitUiIdSql}) END,
       ui_handle = CASE WHEN $26 THEN $25 ELSE COALESCE(NULLIF(agents.ui_handle, ''), $27) END,
       channel_port = CASE WHEN $22 THEN $21::int ELSE agents.channel_port END,
       home_directory = CASE WHEN $14 THEN $5 ELSE agents.home_directory END,
       runtime_engine_preference = CASE WHEN $15 THEN $6 ELSE agents.runtime_engine_preference END,
       provider_token_source_ref = CASE WHEN $16 THEN $7 ELSE agents.provider_token_source_ref END,
       expected_provider_identity = CASE WHEN $17 THEN COALESCE($8::jsonb, '{}'::jsonb) ELSE agents.expected_provider_identity END,
       profile_enabled = CASE WHEN $18 THEN COALESCE($9, agents.profile_enabled) ELSE agents.profile_enabled END,
       disabled_at = CASE
         WHEN $18 AND $9 = false THEN COALESCE(agents.disabled_at, now())
         WHEN $18 AND $9 = true THEN NULL
         ELSE agents.disabled_at
       END,
       status = CASE
         WHEN $18 AND $9 = false THEN 'disabled'
         WHEN $18 AND $9 = true AND agents.status = 'disabled' THEN 'offline'
         ELSE agents.status
       END,
       profile_revision = COALESCE(agents.profile_revision, 1) + 1,
       profile_source = $10,
       profile_updated_at = now()
     RETURNING agent_id, display_name, agent_type, runtime, status,
       metadata, ui_id, ui_handle, channel_port, home_directory, runtime_engine_preference, provider_token_source_ref,
       expected_provider_identity, profile_enabled, profile_revision,
       profile_source, profile_updated_at`,
    [
      input.agentId,
      input.displayName,
      input.agentType,
      input.runtime,
      input.homeDirectory,
      input.runtimeEnginePreference,
      input.providerTokenSourceRef,
      expectedIdentityJson,
      enabled,
      source,
      hasDisplayName,
      hasAgentType,
      hasRuntime,
      hasHomeDirectory,
      hasRuntimeEnginePreference,
      hasProviderTokenSourceRef,
      hasExpectedProviderIdentity,
      hasProfileEnabled,
      metadataForWrite,
      hasTmuxSession,
      input.channelPort,
      hasChannelPort,
      input.uiId,
      hasUiId,
      input.uiHandle,
      hasUiHandle,
      defaultUiHandle,
    ],
  )
  if (hasUiId) {
    await db.query(
      `SELECT setval(
         'agent_ui_id_seq',
         GREATEST((SELECT COALESCE(MAX(ui_id), 0) FROM agents), 1),
         (SELECT COALESCE(MAX(ui_id), 0) FROM agents) > 0
       )`,
    ).catch(() => ({ rows: [] as any[] }))
  }
  return result.rows[0]
}

function botProfileForOutput(row: any): Record<string, unknown> {
  const metadata = parseJsonObject(row.metadata)
  return {
    agent_id: row.agent_id,
    ui_id: row.ui_id === null || row.ui_id === undefined ? null : Number(row.ui_id),
    ui_handle: row.ui_handle ?? null,
    display_name: row.display_name,
    agent_type: row.agent_type,
    runtime: row.runtime,
    status: row.status,
    home_directory: row.home_directory ?? null,
    channel_port: row.channel_port ?? null,
    tmux_session: typeof metadata.tmux_session === 'string' && metadata.tmux_session.trim()
      ? metadata.tmux_session.trim()
      : null,
    runtime_engine_preference: row.runtime_engine_preference ?? null,
    provider_token_source_ref: row.provider_token_source_ref ?? null,
    expected_provider_identity: parseJsonObject(row.expected_provider_identity),
    profile_enabled: row.profile_enabled === true || row.profile_enabled === 1 || row.profile_enabled === '1',
    profile_revision: Number(row.profile_revision ?? 1),
    profile_source: row.profile_source ?? 'legacy',
    profile_updated_at: row.profile_updated_at ?? null,
  }
}

async function selectBotProfile(db: Client, agentId: string): Promise<any | null> {
  const result = await db.query(
    `SELECT agent_id, display_name, agent_type, runtime, status,
            metadata, ui_id, ui_handle, channel_port, home_directory, runtime_engine_preference, provider_token_source_ref,
            expected_provider_identity, profile_enabled, profile_revision,
            profile_source, profile_updated_at
       FROM agents
      WHERE agent_id = $1`,
    [agentId],
  )
  return result.rows[0] ?? null
}

function profileEnabled(row: any): boolean {
  return row.profile_enabled === true || row.profile_enabled === 1 || row.profile_enabled === '1'
}

function expectedProviderIdentity(row: any): Record<string, unknown> {
  return parseJsonObject(row.expected_provider_identity)
}

function expectedProvider(row: any): string | null {
  const identity = expectedProviderIdentity(row)
  const provider = identity.provider
  return typeof provider === 'string' && provider.trim() ? provider.trim() : null
}

function expectedProviderSubjectId(row: any): string | null {
  const identity = expectedProviderIdentity(row)
  const value = identity.subject_id ?? identity.provider_subject_id ?? identity.ui_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function buildProfileProjection(row: any): BotProfileProjection {
  const agentId = String(row.agent_id)
  const orgId = String(row.org_id ?? 'default')
  const metadata = parseJsonObject(row.metadata)
  const homeDirectory = typeof row.home_directory === 'string' && row.home_directory.trim()
    ? row.home_directory.trim()
    : null
  const uiId = Number(row.ui_id)
  const uiHandle = typeof row.ui_handle === 'string' && row.ui_handle.trim()
    ? row.ui_handle.trim()
    : null
  const revision = Number(row.profile_revision ?? 1)
  const projection: BotProfileProjection = {
    agent_id: agentId,
    profile_revision: revision,
    blockers: [],
    actions: [],
    deferred: [],
  }

  if (!profileEnabled(row)) {
    projection.blockers.push({ code: 'profile_disabled' })
    return projection
  }
  if (!Number.isSafeInteger(uiId) || uiId <= 0) {
    projection.blockers.push({ code: 'missing_ui_id' })
  }
  if (!uiHandle) {
    projection.blockers.push({ code: 'missing_ui_handle' })
  }
  const replacedAlias = typeof metadata.replaces === 'string' && metadata.replaces.trim()
    ? metadata.replaces.trim()
    : null
  if (replacedAlias && replacedAlias !== agentId) {
    projection.actions.push({
      table: 'agent_aliases',
      action: 'upsert',
      alias: replacedAlias,
      canonical_agent_id: agentId,
      new_work_allowed: false,
      reason: 'bot profile replacement alias',
      source: 'bot_profile_projector',
      profile_revision: revision,
    })
  }
  if (!homeDirectory) {
    projection.blockers.push({ code: 'missing_home_directory' })
  } else {
    const workspaceId = deterministicWorkspaceId(orgId, homeDirectory)
    projection.actions.push({
      table: 'agent_workspaces',
      action: 'upsert',
      workspace_id: workspaceId,
      org_id: orgId,
      local_path: homeDirectory,
      name: inferWorkspaceName(homeDirectory, agentId),
      source: 'bot_profile_projector',
      profile_revision: revision,
    })
    projection.actions.push({
      table: 'agent_workspace_bindings',
      action: 'upsert',
      agent_id: agentId,
      workspace_id: workspaceId,
      binding_role: 'primary',
      source: 'bot_profile_projector',
      profile_revision: revision,
    })
    projection.actions.push({
      table: 'agent_runtime_instances',
      action: 'link_active_workspace',
      agent_id: agentId,
      workspace_id: workspaceId,
      source: 'bot_profile_projector',
      profile_revision: revision,
    })
  }

  const provider = expectedProvider(row)
  const providerSubjectId = expectedProviderSubjectId(row)
  const tokenSourceRef = typeof row.provider_token_source_ref === 'string' && row.provider_token_source_ref.trim()
    ? row.provider_token_source_ref.trim()
    : null
  if (provider && tokenSourceRef) {
    projection.actions.push({
      table: 'connector_instances',
      action: 'upsert',
      agent_id: agentId,
      provider,
      connector_uri: `${provider}://agents/${agentId}`,
      status: 'registered',
      source: 'bot_profile_projector',
      profile_revision: revision,
    })
    projection.actions.push({
      table: 'connector_credentials',
      action: 'upsert',
      agent_id: agentId,
      provider,
      connector_uri: `${provider}://agents/${agentId}`,
      secret_ref: tokenSourceRef,
      status: 'registered',
      source: 'bot_profile_projector',
      profile_revision: revision,
    })
    if (providerSubjectId) {
      projection.actions.push({
        table: 'agent_provider_identities',
        action: 'upsert',
        agent_id: agentId,
        provider,
        provider_subject_id: providerSubjectId,
        provider_handle: typeof row.ui_handle === 'string' && row.ui_handle.trim() ? row.ui_handle.trim() : null,
        status: 'expected',
        source: 'bot_profile_projector',
        profile_revision: revision,
      })
      projection.actions.push({
        table: 'agent_ui_bindings',
        action: 'upsert',
        agent_id: agentId,
        ui_type: provider,
        ui_id: providerSubjectId,
        ui_handle: typeof row.ui_handle === 'string' && row.ui_handle.trim() ? row.ui_handle.trim() : null,
        ui_token_ref: tokenSourceRef,
        surface_role: 'primary',
        status: 'registered',
        source: 'bot_profile_projector',
        profile_revision: revision,
      })
    } else {
      projection.deferred.push({
        table: 'agent_provider_identities',
        reason: 'expected provider identity is missing subject_id',
        expected_provider_identity: expectedProviderIdentity(row),
      })
    }
    projection.deferred.push({
      table: 'provider_identity_verification',
      reason: 'provider identity verification requires provider discovery',
      expected_provider_identity: expectedProviderIdentity(row),
    })
    projection.deferred.push({
      table: 'provider_channel_access',
      reason: 'channel access requires provider discovery and must not be manually configured per channel',
    })
  } else if (provider || tokenSourceRef) {
    projection.deferred.push({
      table: 'connector_instances',
      reason: 'connector evidence requires both expected provider identity and token source reference',
      has_provider: Boolean(provider),
      has_token_source_ref: Boolean(tokenSourceRef),
    })
  }

  return projection
}

async function selectProjectableProfiles(db: Client, agentId: string | null): Promise<any[]> {
  if (agentId) {
    const result = await db.query(
      `SELECT agent_id, org_id, display_name, agent_type, runtime, status,
              metadata, ui_id, ui_handle, home_directory, runtime_engine_preference, provider_token_source_ref,
              expected_provider_identity, profile_enabled, profile_revision,
              profile_source, profile_updated_at
         FROM agents
        WHERE agent_id = $1`,
      [agentId],
    )
    return result.rows
  }
  const result = await db.query(
    `SELECT agent_id, org_id, display_name, agent_type, runtime, status,
            metadata, ui_id, ui_handle, home_directory, runtime_engine_preference, provider_token_source_ref,
            expected_provider_identity, profile_enabled, profile_revision,
            profile_source, profile_updated_at
       FROM agents
      WHERE agent_type <> 'human'
        AND COALESCE(profile_enabled, true) = true
      ORDER BY agent_id`,
  )
  return result.rows
}

function actionForTable(projection: BotProfileProjection, table: string): Record<string, unknown> | null {
  return projection.actions.find((action) => action.table === table) ?? null
}

async function applyProfileProjection(db: Client, row: any, projection: BotProfileProjection): Promise<void> {
  if (projection.blockers.length > 0) return
  const aliasAction = actionForTable(projection, 'agent_aliases')
  if (aliasAction) {
    await db.query(
      `INSERT INTO agent_aliases
         (alias, canonical_agent_id, new_work_allowed, reason, updated_at)
       VALUES
         ($1, $2, $3, $4, now())
       ON CONFLICT (alias) DO UPDATE SET
         canonical_agent_id = excluded.canonical_agent_id,
         new_work_allowed = excluded.new_work_allowed,
         reason = excluded.reason,
         updated_at = now()`,
      [
        aliasAction.alias,
        aliasAction.canonical_agent_id,
        aliasAction.new_work_allowed,
        aliasAction.reason,
      ],
    )
  }
  const workspaceAction = actionForTable(projection, 'agent_workspaces')
  if (workspaceAction) {
    const metadata = JSON.stringify({
      source: 'bot_profile_projector',
      agent_id: projection.agent_id,
      profile_revision: projection.profile_revision,
    })
    const existing = await db.query(
      `SELECT workspace_id
         FROM agent_workspaces
        WHERE org_id = $1
          AND local_path = $2
        LIMIT 1`,
      [workspaceAction.org_id, workspaceAction.local_path],
    )
    if (existing.rows[0]?.workspace_id) {
      await db.query(
        `UPDATE agent_workspaces
            SET name = $2,
                workspace_type = 'local_path',
                metadata = COALESCE($3::jsonb, '{}'::jsonb),
                updated_at = now()
          WHERE workspace_id = $1`,
        [existing.rows[0].workspace_id, workspaceAction.name, metadata],
      )
      workspaceAction.workspace_id = existing.rows[0].workspace_id
    } else {
      await db.query(
        `INSERT INTO agent_workspaces
           (workspace_id, org_id, name, workspace_type, local_path, metadata, updated_at)
         VALUES
           ($1, $2, $3, 'local_path', $4, COALESCE($5::jsonb, '{}'::jsonb), now())`,
        [
          workspaceAction.workspace_id,
          workspaceAction.org_id,
          workspaceAction.name,
          workspaceAction.local_path,
          metadata,
        ],
      )
    }
  }

  const bindingAction = actionForTable(projection, 'agent_workspace_bindings')
  if (bindingAction) {
    const workspaceId = workspaceAction?.workspace_id ?? bindingAction.workspace_id
    await db.query(
      `INSERT INTO agent_workspace_bindings
         (agent_id, workspace_id, binding_role, active, updated_at)
       VALUES
         ($1, $2, $3, true, now())
       ON CONFLICT (agent_id, workspace_id, binding_role) DO UPDATE SET
         active = true,
         updated_at = now()`,
      [projection.agent_id, workspaceId, bindingAction.binding_role],
    )
  }

  const runtimeAction = actionForTable(projection, 'agent_runtime_instances')
  if (runtimeAction) {
    const workspaceId = workspaceAction?.workspace_id ?? runtimeAction.workspace_id
    await db.query(
      `UPDATE agent_runtime_instances
          SET workspace_id = $2
        WHERE agent_id = $1
          AND status IN ('running', 'active')
          AND workspace_id IS NULL`,
      [projection.agent_id, workspaceId],
    )
  }

  const connectorAction = actionForTable(projection, 'connector_instances')
  let connectorInstanceId: string | null = null
  if (connectorAction) {
    const metadata = JSON.stringify({
      source: 'bot_profile_projector',
      agent_id: projection.agent_id,
      profile_revision: projection.profile_revision,
      expected_provider_identity: expectedProviderIdentity(row),
      token_source_ref_set: Boolean(row.provider_token_source_ref),
    })
    const capabilities = JSON.stringify({ roles: ['profile_projection'], source: 'bot_profile_projector' })
    const existing = await db.query(
      `SELECT connector_instance_id, status
         FROM connector_instances
        WHERE provider = $1
          AND connector_uri = $2
        LIMIT 1`,
      [connectorAction.provider, connectorAction.connector_uri],
    )
    if (existing.rows[0]?.connector_instance_id) {
      await db.query(
        `UPDATE connector_instances
            SET agent_id = $2,
                connector_kind = 'chat_adapter',
                transport = $3,
                status = CASE
                  WHEN status = 'disabled' THEN status
                  WHEN status = 'active' THEN status
                  ELSE 'registered'
                END,
                trust_status = CASE
                  WHEN trust_status IN ('revoked', 'disabled') THEN trust_status
                  ELSE 'local'
                END,
                capabilities = COALESCE($4::jsonb, '{}'::jsonb),
                metadata = COALESCE($5::jsonb, '{}'::jsonb),
                updated_at = now()
          WHERE connector_instance_id = $1`,
        [
          existing.rows[0].connector_instance_id,
          projection.agent_id,
          `${connectorAction.provider}_gateway`,
          capabilities,
          metadata,
        ],
      )
    } else {
      await db.query(
        `INSERT INTO connector_instances
           (agent_id, provider, connector_kind, transport, connector_uri,
            status, trust_status, capabilities, metadata, updated_at)
         VALUES
           ($1, $2, 'chat_adapter', $3, $4,
            'registered', 'local', COALESCE($5::jsonb, '{}'::jsonb), COALESCE($6::jsonb, '{}'::jsonb), now())`,
        [
          projection.agent_id,
          connectorAction.provider,
          `${connectorAction.provider}_gateway`,
          connectorAction.connector_uri,
          capabilities,
          metadata,
        ],
      )
    }
    const connectorRow = await db.query(
      `SELECT connector_instance_id
         FROM connector_instances
        WHERE provider = $1
          AND connector_uri = $2
        LIMIT 1`,
      [connectorAction.provider, connectorAction.connector_uri],
    )
    connectorInstanceId = connectorRow.rows[0]?.connector_instance_id ?? null
  }

  const credentialAction = actionForTable(projection, 'connector_credentials')
  let credentialId: string | null = null
  if (credentialAction && connectorInstanceId) {
    const metadata = JSON.stringify({
      source: 'bot_profile_projector',
      agent_id: projection.agent_id,
      profile_revision: projection.profile_revision,
      token_source_ref_set: true,
    })
    const existing = await db.query(
      `SELECT credential_id, status
         FROM connector_credentials
        WHERE provider = $1
          AND secret_ref = $2
        LIMIT 1`,
      [credentialAction.provider, credentialAction.secret_ref],
    )
    if (existing.rows[0]?.credential_id) {
      credentialId = existing.rows[0].credential_id
      await db.query(
        `UPDATE connector_credentials
            SET agent_id = $2,
                connector_instance_id = $3,
                credential_kind = 'bot_token',
                status = CASE
                  WHEN status IN ('disabled', 'revoked') THEN status
                  ELSE 'registered'
                END,
                trust_status = CASE
                  WHEN trust_status IN ('disabled', 'revoked') THEN trust_status
                  ELSE 'local'
                END,
                source = 'bot_profile_projector',
                evidence_revision = $4,
                metadata = COALESCE($5::jsonb, '{}'::jsonb),
                updated_at = now()
          WHERE credential_id = $1`,
        [
          credentialId,
          projection.agent_id,
          connectorInstanceId,
          projection.profile_revision,
          metadata,
        ],
      )
    } else {
      await db.query(
        `INSERT INTO connector_credentials
           (provider, agent_id, connector_instance_id, credential_kind, secret_ref,
            status, trust_status, source, evidence_revision, metadata, updated_at)
         VALUES
           ($1, $2, $3, 'bot_token', $4,
            'registered', 'local', 'bot_profile_projector', $5, COALESCE($6::jsonb, '{}'::jsonb), now())`,
        [
          credentialAction.provider,
          projection.agent_id,
          connectorInstanceId,
          credentialAction.secret_ref,
          projection.profile_revision,
          metadata,
        ],
      )
    }
    const credentialRow = await db.query(
      `SELECT credential_id
         FROM connector_credentials
        WHERE provider = $1
          AND secret_ref = $2
        LIMIT 1`,
      [credentialAction.provider, credentialAction.secret_ref],
    )
    credentialId = credentialRow.rows[0]?.credential_id ?? credentialId
  }

  const identityAction = actionForTable(projection, 'agent_provider_identities')
  let providerIdentityId: string | null = null
  if (identityAction) {
    const metadata = JSON.stringify({
      source: 'bot_profile_projector',
      agent_id: projection.agent_id,
      profile_revision: projection.profile_revision,
      expected_provider_identity: expectedProviderIdentity(row),
    })
    const existing = await db.query(
      `SELECT provider_identity_id, status
         FROM agent_provider_identities
        WHERE provider = $1
          AND provider_subject_id = $2
        LIMIT 1`,
      [identityAction.provider, identityAction.provider_subject_id],
    )
    if (existing.rows[0]?.provider_identity_id) {
      providerIdentityId = existing.rows[0].provider_identity_id
      await db.query(
        `UPDATE agent_provider_identities
            SET agent_id = $2,
                provider_handle = $3,
                identity_kind = 'bot',
                status = CASE
                  WHEN status IN ('disabled', 'revoked') THEN status
                  ELSE 'expected'
                END,
                trust_status = CASE
                  WHEN trust_status IN ('disabled', 'revoked') THEN trust_status
                  ELSE 'unverified'
                END,
                source = 'bot_profile_projector',
                evidence_revision = $4,
                metadata = COALESCE($5::jsonb, '{}'::jsonb),
                updated_at = now()
          WHERE provider_identity_id = $1`,
        [
          providerIdentityId,
          projection.agent_id,
          identityAction.provider_handle,
          projection.profile_revision,
          metadata,
        ],
      )
    } else {
      await db.query(
        `INSERT INTO agent_provider_identities
           (agent_id, provider, provider_subject_id, provider_handle, identity_kind,
            status, trust_status, source, evidence_revision, metadata, updated_at)
         VALUES
           ($1, $2, $3, $4, 'bot',
            'expected', 'unverified', 'bot_profile_projector', $5, COALESCE($6::jsonb, '{}'::jsonb), now())`,
        [
          projection.agent_id,
          identityAction.provider,
          identityAction.provider_subject_id,
          identityAction.provider_handle,
          projection.profile_revision,
          metadata,
        ],
      )
    }
    const identityRow = await db.query(
      `SELECT provider_identity_id
         FROM agent_provider_identities
        WHERE provider = $1
          AND provider_subject_id = $2
        LIMIT 1`,
      [identityAction.provider, identityAction.provider_subject_id],
    )
    providerIdentityId = identityRow.rows[0]?.provider_identity_id ?? providerIdentityId
  }

  const uiBindingAction = actionForTable(projection, 'agent_ui_bindings')
  if (uiBindingAction) {
    const metadata = JSON.stringify({
      source: 'bot_profile_projector',
      agent_id: projection.agent_id,
      profile_revision: projection.profile_revision,
    })
    const existing = await db.query(
      `SELECT binding_id, status
         FROM agent_ui_bindings
        WHERE agent_id = $1
          AND ui_type = $2
          AND surface_role = $3
        LIMIT 1`,
      [projection.agent_id, uiBindingAction.ui_type, uiBindingAction.surface_role],
    )
    if (existing.rows[0]?.binding_id) {
      await db.query(
        `UPDATE agent_ui_bindings
            SET ui_id = $2,
                ui_handle = $3,
                ui_token_ref = $4,
                connector_instance_id = $5,
                credential_id = $6,
                provider_identity_id = $7,
                status = CASE
                  WHEN status IN ('disabled', 'revoked') THEN status
                  ELSE 'registered'
                END,
                trust_status = CASE
                  WHEN trust_status IN ('disabled', 'revoked') THEN trust_status
                  ELSE 'unverified'
                END,
                evidence_revision = $8,
                metadata = COALESCE($9::jsonb, '{}'::jsonb),
                updated_at = now()
          WHERE binding_id = $1`,
        [
          existing.rows[0].binding_id,
          uiBindingAction.ui_id,
          uiBindingAction.ui_handle,
          uiBindingAction.ui_token_ref,
          connectorInstanceId,
          credentialId,
          providerIdentityId,
          projection.profile_revision,
          metadata,
        ],
      )
    } else {
      await db.query(
        `INSERT INTO agent_ui_bindings
           (agent_id, ui_type, ui_id, ui_handle, ui_token_ref, connector_instance_id,
            credential_id, provider_identity_id, surface_role, status, trust_status,
            evidence_revision, metadata, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6,
            $7, $8, $9, 'registered', 'unverified',
            $10, COALESCE($11::jsonb, '{}'::jsonb), now())`,
        [
          projection.agent_id,
          uiBindingAction.ui_type,
          uiBindingAction.ui_id,
          uiBindingAction.ui_handle,
          uiBindingAction.ui_token_ref,
          connectorInstanceId,
          credentialId,
          providerIdentityId,
          uiBindingAction.surface_role,
          projection.profile_revision,
          metadata,
        ],
      )
    }
  }

  await auditLog(db, 'agent.profile_project', 'cli', projection.agent_id, {
    profile_revision: projection.profile_revision,
    actions: projection.actions,
    deferred: projection.deferred,
  })
}

async function agentProfile(args: string[]) {
  const [action, ...rest] = args
  const { positional, flags } = parseArgs(rest)
  const db = await getDb()
  try {
    if (action === 'get') {
      const agentId = positional[0] ?? flags['agent-id']
      if (!agentId) {
        console.error('Usage: agent-com agent profile get <agent_id>')
        process.exit(2)
      }
      const row = await selectBotProfile(db, agentId)
      if (!row) {
        console.error(`Error [AGENT_NOT_FOUND]: ${agentId}`)
        process.exit(1)
      }
      process.stdout.write(`${JSON.stringify({ ok: true, profile: botProfileForOutput(row) }, null, 2)}\n`)
      return
    }

    if (action === 'set') {
      const agentId = positional[0] ?? flags['agent-id']
      if (!agentId) {
        console.error('Usage: agent-com agent profile set <agent_id> [--home-directory <path>] [--channel-port <port>] [--tmux-session <name>] [--runtime-engine <engine>] [--token-source-ref <ref>] [--expected-provider <provider>] [--expected-provider-subject <id>] [--enabled true|false] [--execute|--dry-run]')
        process.exit(2)
      }
      const input = buildBotProfileInput(agentId, flags)
      const dryRun = parseRepairDryRun(flags)
      const before = await selectBotProfile(db, agentId)
      const preview = {
        agent_id: agentId,
        changes: {
          ui_id: input.uiId,
          ui_handle: input.uiHandle,
          display_name: input.displayName,
          agent_type: input.agentType,
          runtime: input.runtime,
          home_directory: input.homeDirectory,
          channel_port: input.channelPort,
          tmux_session: input.tmuxSession,
          runtime_engine_preference: input.runtimeEnginePreference,
          provider_token_source_ref: input.providerTokenSourceRef ? '(set)' : input.providerTokenSourceRef,
          expected_provider_identity: input.expectedProviderIdentity,
          profile_enabled: input.profileEnabled,
        },
      }
      if (dryRun) {
        process.stdout.write(`${JSON.stringify({ ok: true, dry_run: true, before: before ? botProfileForOutput(before) : null, preview }, null, 2)}\n`)
        return
      }
      const row = await upsertBotProfile(db, input, 'agent.profile.set')
      await auditLog(db, 'agent.profile_set', 'cli', agentId, {
        before: before ? botProfileForOutput(before) : null,
        after: botProfileForOutput(row),
      })
      process.stdout.write(`${JSON.stringify({ ok: true, dry_run: false, profile: botProfileForOutput(row) }, null, 2)}\n`)
      return
    }

    if (action === 'project') {
      const all = flags.all === 'true' || flags.all === '1' || flags.all === ''
      const agentId = positional[0] ?? flags['agent-id'] ?? null
      if (!agentId && !all) {
        console.error('Usage: agent-com agent profile project <agent_id>|--all [--execute|--dry-run]')
        process.exit(2)
      }
      const dryRun = parseRepairDryRun(flags)
      const rows = await selectProjectableProfiles(db, agentId)
      if (agentId && rows.length === 0) {
        console.error(`Error [AGENT_NOT_FOUND]: ${agentId}`)
        process.exit(1)
      }
      const projections = rows.map((row) => buildProfileProjection(row))
      if (!dryRun) {
        for (let index = 0; index < rows.length; index += 1) {
          await applyProfileProjection(db, rows[index], projections[index])
        }
      }
      process.stdout.write(`${JSON.stringify({
        ok: projections.every((projection) => projection.blockers.length === 0),
        dry_run: dryRun,
        projected_agents: projections.length,
        projections,
      }, null, 2)}\n`)
      return
    }

    if (action === 'doctor') {
      const strict = flags.strict === 'true' || flags.strict === '1' || flags.strict === ''
      const liveTmux = flags['live-tmux'] === 'true' || flags['live-tmux'] === '1' || flags['live-tmux'] === ''
      const includeDisabledProfiles = hasFlag(flags, 'include-disabled') && flagEnabled(flags['include-disabled'])
      const includeTestProfiles = hasFlag(flags, 'include-test') && flagEnabled(flags['include-test'])
      const rows = await db.query(
        `SELECT agent_id, display_name, agent_type, runtime, status, metadata,
                ui_id, ui_handle, home_directory, channel_port, runtime_engine_preference,
                provider_token_source_ref, expected_provider_identity, profile_enabled, disabled_at
           FROM agents
          WHERE agent_type <> 'human'
          ORDER BY agent_id`,
      )
      const activeRows = rows.rows.filter((row: any) => profileExclusionReason(row, {
        includeDisabledProfiles,
        includeTestProfiles,
      }) === null)
      const blockers: Array<Record<string, unknown>> = []
      const homeByPath = new Map<string, string[]>()
      const portOwners = new Map<number, string[]>()
      const sessionOwners = new Map<string, string[]>()
      const uiIdOwners = new Map<number, string[]>()
      const uiHandleOwners = new Map<string, { ui_handle: string; agents: string[] }>()
      const expectedAliases: Array<{ alias: string; canonical_agent_id: string }> = []
      for (const row of activeRows) {
        const agentId = String(row.agent_id)
        const metadata = parseJsonObject(row.metadata)
        const uiId = Number(row.ui_id)
        if (!Number.isSafeInteger(uiId) || uiId <= 0) {
          blockers.push({ agent_id: agentId, code: 'missing_ui_id' })
        } else {
          const agents = uiIdOwners.get(uiId) ?? []
          agents.push(agentId)
          uiIdOwners.set(uiId, agents)
        }
        const uiHandle = typeof row.ui_handle === 'string' && row.ui_handle.trim()
          ? row.ui_handle.trim()
          : ''
        if (!uiHandle) {
          blockers.push({ agent_id: agentId, code: 'missing_ui_handle' })
        } else {
          const key = uiHandle.toLowerCase()
          const current = uiHandleOwners.get(key) ?? { ui_handle: uiHandle, agents: [] }
          current.agents.push(agentId)
          uiHandleOwners.set(key, current)
        }
        const replacedAlias = typeof metadata.replaces === 'string' && metadata.replaces.trim()
          ? metadata.replaces.trim()
          : ''
        if (replacedAlias && replacedAlias !== agentId) {
          expectedAliases.push({ alias: replacedAlias, canonical_agent_id: agentId })
        }
        const home = typeof row.home_directory === 'string' ? row.home_directory : ''
        if (!home) blockers.push({ agent_id: agentId, code: 'missing_home_directory' })
        else {
          const agents = homeByPath.get(home) ?? []
          agents.push(agentId)
          homeByPath.set(home, agents)
        }
        const port = Number(row.channel_port)
        if (!Number.isInteger(port) || port <= 0) {
          blockers.push({ agent_id: agentId, code: 'missing_channel_port' })
        } else {
          const agents = portOwners.get(port) ?? []
          agents.push(agentId)
          portOwners.set(port, agents)
        }
        const tmuxSession = typeof metadata.tmux_session === 'string' && metadata.tmux_session.trim()
          ? metadata.tmux_session.trim()
          : ''
        const supervisorType = typeof metadata.supervisor_type === 'string' && metadata.supervisor_type.trim()
          ? metadata.supervisor_type.trim().toLowerCase()
          : 'tmux'
        if (supervisorType === 'tmux' && !tmuxSession) {
          blockers.push({ agent_id: agentId, code: 'missing_tmux_session' })
        } else if (tmuxSession) {
          const agents = sessionOwners.get(tmuxSession) ?? []
          agents.push(agentId)
          sessionOwners.set(tmuxSession, agents)
        }
        const runtimeEngine = typeof row.runtime_engine_preference === 'string' && row.runtime_engine_preference.trim()
          ? row.runtime_engine_preference.trim()
          : ''
        if (!runtimeEngine) blockers.push({ agent_id: agentId, code: 'missing_runtime_engine_preference' })
        const hasTokenSource = typeof row.provider_token_source_ref === 'string' && row.provider_token_source_ref.trim()
        const provider = expectedProvider(row)
        if (hasTokenSource && !provider) blockers.push({ agent_id: agentId, code: 'missing_expected_provider_identity' })
        if (provider && !hasTokenSource) blockers.push({ agent_id: agentId, code: 'missing_provider_token_source_ref', provider })
        if (typeof row.provider_token_source_ref === 'string' && looksLikeRawSecret(row.provider_token_source_ref)) {
          blockers.push({ agent_id: agentId, code: 'raw_secret_like_token_source_ref' })
        }
      }
      for (const [home_directory, agents] of homeByPath.entries()) {
        if (agents.length > 1) blockers.push({ code: 'duplicate_home_directory', home_directory, agents })
      }
      for (const [channel_port, agents] of portOwners.entries()) {
        if (agents.length > 1) blockers.push({ code: 'duplicate_channel_port', channel_port, agents })
      }
      for (const [tmux_session, agents] of sessionOwners.entries()) {
        if (agents.length > 1) blockers.push({ code: 'duplicate_tmux_session', tmux_session, agents })
      }
      for (const [ui_id, agents] of uiIdOwners.entries()) {
        if (agents.length > 1) blockers.push({ code: 'duplicate_ui_id', ui_id, agents })
      }
      for (const current of uiHandleOwners.values()) {
        if (current.agents.length > 1) blockers.push({ code: 'duplicate_ui_handle', ui_handle: current.ui_handle, agents: current.agents })
      }
      const tokenRefs = new Map<string, string[]>()
      for (const row of activeRows) {
        if (typeof row.provider_token_source_ref !== 'string' || !row.provider_token_source_ref.trim()) continue
        const agents = tokenRefs.get(row.provider_token_source_ref) ?? []
        agents.push(String(row.agent_id))
        tokenRefs.set(row.provider_token_source_ref, agents)
      }
      for (const [provider_token_source_ref, agents] of tokenRefs.entries()) {
        if (agents.length > 1) blockers.push({ code: 'duplicate_provider_token_source_ref', provider_token_source_ref, agents })
      }
      for (const expected of expectedAliases) {
        const aliasRows = await db.query(
          `SELECT canonical_agent_id, new_work_allowed
             FROM agent_aliases
            WHERE alias = $1`,
          [expected.alias],
        )
        const aliasRow = aliasRows.rows[0]
        if (!aliasRow || aliasRow.canonical_agent_id !== expected.canonical_agent_id) {
          blockers.push({
            agent_id: expected.canonical_agent_id,
            code: 'missing_replacement_alias',
            alias: expected.alias,
            canonical_agent_id: expected.canonical_agent_id,
          })
        }
      }
      if (liveTmux) {
        try {
          const tmuxOutput = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_current_path}'], {
            encoding: 'utf8',
          })
          const processOutput = execFileSync('ps', ['axww', '-o', 'pid=,ppid=,command='], {
            encoding: 'utf8',
          })
          blockers.push(...buildLiveTmuxProfileDoctorBlockers({
            tmuxOutput,
            processOutput,
            expectations: activeRows.map((row: any) => {
              const metadata = parseJsonObject(row.metadata)
              const tmuxSession = typeof metadata.tmux_session === 'string' && metadata.tmux_session.trim()
                ? metadata.tmux_session.trim()
                : null
              return { agent_id: String(row.agent_id), tmux_session: tmuxSession }
            }),
          }))
        } catch (err) {
          blockers.push({
            code: 'live_tmux_inspection_unavailable',
            error: (err as Error).message,
          })
        }
      }
      if (strict) {
        const activeAgentIds = new Set(activeRows.map((row: any) => String(row.agent_id)))
        const workspaceRows = await db.query(
          `SELECT a.agent_id, a.home_directory, b.workspace_id
             FROM agents a
             LEFT JOIN agent_workspaces w
               ON w.org_id = COALESCE(a.org_id, 'default')
              AND w.local_path = a.home_directory
             LEFT JOIN agent_workspace_bindings b
               ON b.agent_id = a.agent_id
              AND b.workspace_id = w.workspace_id
              AND b.binding_role = 'primary'
              AND b.active = true
            WHERE a.agent_type <> 'human'
              ${includeDisabledProfiles ? '' : 'AND COALESCE(a.profile_enabled, true) = true AND a.disabled_at IS NULL'}
              AND a.home_directory IS NOT NULL`,
        )
        for (const row of workspaceRows.rows) {
          if (!activeAgentIds.has(String(row.agent_id))) continue
          if (!row.workspace_id) {
            blockers.push({
              agent_id: row.agent_id,
              code: 'missing_profile_projected_workspace_binding',
              home_directory: row.home_directory,
            })
          }
        }
        const runtimeRows = await db.query(
          `SELECT runtime_instance_id, agent_id
             FROM agent_runtime_instances
            WHERE status IN ('running', 'active')
              AND workspace_id IS NULL
            ORDER BY agent_id, started_at DESC`,
        ).catch(() => ({ rows: [] as any[] }))
        for (const row of runtimeRows.rows) {
          if (!activeAgentIds.has(String(row.agent_id))) continue
          blockers.push({
            agent_id: row.agent_id,
            runtime_instance_id: row.runtime_instance_id,
            code: 'runtime_missing_workspace_profile_linkage',
          })
        }
        const connectorRows = await db.query(
          `SELECT connector_instance_id, agent_id, provider, connector_uri, metadata
             FROM connector_instances
            WHERE status IN ('registered', 'active', 'standby')
            ORDER BY agent_id, provider, connector_uri`,
        ).catch(() => ({ rows: [] as any[] }))
        for (const row of connectorRows.rows) {
          if (!activeAgentIds.has(String(row.agent_id))) continue
          const metadata = parseJsonObject(row.metadata)
          if (metadata.source !== 'bot_profile_projector' && metadata.source !== 'runtime_heartbeat') {
            blockers.push({
              agent_id: row.agent_id,
              connector_instance_id: row.connector_instance_id,
              provider: row.provider,
              connector_uri: row.connector_uri,
              code: 'connector_missing_profile_source_evidence',
            })
          }
        }
        const activeConnectorEndpointRows = await db.query(
          `SELECT ci.connector_instance_id,
                  ci.agent_id,
                  ci.provider,
                  ci.connector_uri,
                  ci.runtime_instance_id,
                  cpl.lease_id,
                  cpl.expires_at
             FROM connector_instances ci
             JOIN agents a ON a.agent_id = ci.agent_id
             LEFT JOIN control_plane_leases cpl
               ON cpl.lease_scope_type = 'runtime_instance'
              AND cpl.lease_scope_id = ci.runtime_instance_id::text
              AND cpl.status = 'active'
              AND cpl.expires_at > now()
            WHERE ci.status = 'active'
              AND a.agent_type <> 'human'
              ${includeDisabledProfiles ? '' : 'AND COALESCE(a.profile_enabled, true) = true AND a.disabled_at IS NULL'}
            ORDER BY ci.agent_id, ci.provider, ci.connector_uri`,
        ).catch(() => ({ rows: [] as any[] }))
        for (const row of activeConnectorEndpointRows.rows) {
          const agent = activeRows.find((candidate: any) => String(candidate.agent_id) === String(row.agent_id))
          if (!agent) continue
          if (!row.runtime_instance_id) {
            blockers.push({
              agent_id: row.agent_id,
              connector_instance_id: row.connector_instance_id,
              provider: row.provider,
              connector_uri: row.connector_uri,
              code: 'active_connector_missing_runtime_instance',
            })
          } else if (!row.lease_id) {
            blockers.push({
              agent_id: row.agent_id,
              connector_instance_id: row.connector_instance_id,
              provider: row.provider,
              connector_uri: row.connector_uri,
              runtime_instance_id: row.runtime_instance_id,
              code: 'active_connector_missing_endpoint_lease',
            })
          }
        }
      }
      process.stdout.write(`${JSON.stringify({
        ok: blockers.length === 0,
        strict,
        live_tmux: liveTmux,
        include_disabled_profiles: includeDisabledProfiles,
        include_test_profiles: includeTestProfiles,
        checked_agents: activeRows.length,
        excluded_agents: rows.rows.length - activeRows.length,
        blockers,
      }, null, 2)}\n`)
      if (blockers.length > 0) process.exitCode = 1
      return
    }

    console.error('Usage: agent-com agent profile <get|set|project|doctor> ...')
    process.exit(2)
  } finally {
    await db.end()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #132 — message-queue-spec §4-6 commands (MVP: next / send / agents)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve agent_id from --agent-id flag (if present in args) or AGENT_ID env.
 * ARC codex audit (PR#139): spec contracts use `--agent-id <id>` on the CLI,
 * so both sources must be checked.
 */
function resolveAgentId(args: string[], command: string): string {
  const idx = args.indexOf('--agent-id')
  if (idx !== -1 && args[idx + 1]) return assertExpectedAgentId(args[idx + 1], command)
  return requireAgentId(command)
}

/**
 * Resolve the runtime AGENT_ID from env var only. Use resolveAgentId() when
 * the command also accepts --agent-id flags.
 */
function requireAgentId(command: string): string {
  const id = process.env.AGENT_ID
  if (!id) {
    console.error(`Error: AGENT_ID env var or --agent-id flag is required for 'agent-com ${command}'`)
    process.exit(2)
  }
  return assertExpectedAgentId(id, command)
}

function assertExpectedAgentId(id: string, command: string): string {
  const expected = process.env.AGENT_COM_EXPECTED_AGENT_ID
  if (expected && id !== expected) {
    console.error(
      `Error [AGENT_ID_MISMATCH]: agent-com ${command} resolved agent_id=${id}, expected ${expected}. ` +
        `Set AGENT_ID=${expected} or remove AGENT_COM_EXPECTED_AGENT_ID for this process.`,
    )
    process.exit(2)
  }
  return id
}

// Issue #130 Phase 4: inboxDir, listSignals, currentStatePath (filesystem
// signal helpers) were removed. Delivery is fully queue-based — `nextMessage`
// reads from message_queue, `sendMessage` reads agents.current_message_id.
// The legacy /tmp/agent-com-$AGENT_ID.current state file and the
// $AGENT_COMMS_STATE_DIR/inbox/{agent}/*.signal files are no longer used.

// ─────────────────────────────────────────────────────────────────────────────
// HMAC auth metadata (mirrors server.ts:createAuthMetadata L665-671)
// ─────────────────────────────────────────────────────────────────────────────
//
// ARC codex audit (2026-04-10): the CLI INSERT must carry the same
// metadata.auth shape as the MCP send tool, otherwise downstream verifiers
// (validateIncomingAuth) will tag CLI-originated rows as [UNVERIFIED] and
// receivers in `enforce` mode will drop them.
//
// We avoid pulling in the whole config loader: the secret resolution mirrors
// server.ts:loadSecret L635-646 (env var → secret_file fallback), and we read
// the auth mode from $AGENT_COMMS_AUTH_MODE / $AGENT_COMMS_SECRET. If neither
// is set, the helper returns undefined and the INSERT proceeds without auth
// metadata (matching server.ts behavior when config.auth.mode === 'off').
function loadAuthSecret(): string | null {
  const envSecret = process.env.AGENT_COMMS_SECRET
  if (envSecret) return envSecret
  const secretFile = process.env.AGENT_COMMS_SECRET_FILE
  if (secretFile) {
    try {
      return readFileSync(secretFile.replace(/^~/, homedir()), 'utf-8').trim()
    } catch {
      return null
    }
  }
  return null
}

function buildAuthMetadata(agentId: string, channel: string, content: string): Record<string, unknown> | undefined {
  const mode = process.env.AGENT_COMMS_AUTH_MODE ?? 'off'
  if (mode === 'off') return undefined
  const secret = loadAuthSecret()
  if (!secret) return undefined
  const timestamp = Math.floor(Date.now() / 1000)
  const contentHash = createHash('sha256').update(content).digest('hex')
  const payload = `${agentId}:${timestamp}:${channel}:${contentHash}`
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  return { auth: { signature, timestamp } }
}

// Issue #129 Phase 3: deliverToDiscord (Phase 1.5 direct REST helper) was
// removed. Outbound delivery is now an outbound_queue INSERT inside
// sendMessage, with the receiver-side consumer
// (server.ts:startOutboundConsumer) doing the actual Discord post on a
// 1-second tick.

/**
 * `agent-com next` — pop one pending message_queue row and stamp it as the
 * agent's current_message_id (Issue #128 Phase 2 / message-queue-spec §4.1).
 *
 * Internal flow (spec §4.1 step list, mapped to this implementation):
 *   1. If agents.current_message_id is set → implicit-skip the prior row
 *      (UPDATE message_queue SET status='skipped' WHERE id=current
 *       AND status='received'). Legacy implicit-skip handling is retained
 *       only for old callers; the normal receive vocabulary is
 *       pending -> received -> replied/done.
 *   2. SELECT the oldest pending row (priority DESC, created_at ASC).
 *   3. UPDATE status='received', read_at=NOW(), agents.current_message_id=row.id.
 *   4. Hydrate channel/content from message_queue.payload (the receiver
 *      already enriched it on INSERT) — no second query into agent_messages
 *      is required for the canonical fields.
 *   5. Emit JSON with §4.1 shape (waiting count, content, channel_id, ...).
 *
 * Output (stdout, single JSON object):
 *   { waiting: 0 }                                                — empty
 *   { waiting: <N>, queue_id, message_id, channel_id, thread_id, from,
 *     content, message_type, source, mode: 'queue' | 'signal' }
 */
async function nextMessage() {
  const agentId = requireAgentId('next')
  const db = await getDb()
  try {
    // Issue #278 (A) segment 3d — per-row claim path. Mirrors the MCP
    // server next handler post-segment-3c: orphan recovery is structural
    // via the claim-TTL sweeper (core/claim-ttl.ts), so the legacy
    // priorId / agents.current_message_id read+lock is gone. Two
    // concurrent `agent-com next` calls now both succeed in parallel,
    // each grabbing a distinct message_queue row via FOR UPDATE SKIP
    // LOCKED — the §A multi in-flight contract.
    let row: { id: string | number; message_id: string | null; payload: string; priority: number; created_at: Date } | null = null
    await db.query('BEGIN')
    try {
      // Step 1: pop the oldest pending row with an exclusive lock so a
      // concurrent next() never picks the same row.
      const pop = await db.query(
        `SELECT id, message_id, payload, priority, created_at
         FROM message_queue
         WHERE status = 'pending' AND agent_id = $1
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [agentId],
      )

      if (pop.rows.length === 0) {
        await db.query('COMMIT')
      } else {
        // Step 2: mark the popped row 'received' + stamp the per-row claim
        // (claimed_by / claimed_at / claim_expires_at) inside the same
        // txn. The TTL window (default 30s, env AGENT_COMMS_CLAIM_TTL_SEC)
        // bounds how long an orphaned claim can linger before the
        // sweeper flips it to IMPLICIT_ABANDON.
        const popped = pop.rows[0]
        const claimTtlSec = parseInt(process.env.AGENT_COMMS_CLAIM_TTL_SEC ?? '30', 10)
        // claim_expires_at is computed in JS rather than via
        // `now() + ($N || ' seconds')::interval` so this UPDATE works
        // identically in PG and SQLite modes (the latter is exercised
        // by the CLI test suite). Both backends accept an ISO-8601
        // timestamp parameter.
        const claimExpiresAt = new Date(Date.now() + claimTtlSec * 1000).toISOString()
        await db.query(
          `UPDATE message_queue
              SET status = 'received',
                  read_at = now(),
                  claimed_by = $1,
                  claimed_at = now(),
                  claim_expires_at = $2
            WHERE id = $3`,
          [agentId, claimExpiresAt, popped.id],
        )
        // spec §4.1 step 4 — mark agent busy. Issue #278 cycle 1
        // (auditor BLOCK 1): EXISTS-derive over the open-claim set so
        // multi in-flight stays visible on agents.status.
        await db.query(
          `UPDATE agents SET
             status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
             status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
             status_updated_at = now()
           WHERE agent_id = $1`,
          [agentId],
        )
        await db.query('COMMIT')
        row = popped
      }
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      throw err
    }

    if (row === null) {
      // Issue #130 Phase 4: Mixed Mode signal fallback removed. The queue
      // is the sole source. If it's empty, report waiting: 0.
      process.stdout.write(JSON.stringify({ waiting: 0 }) + '\n')
      return
    }

    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(row.payload)
    } catch (err) {
      console.error(`Error: failed to parse message_queue payload for id=${row.id}: ${err}`)
      process.exit(1)
    }

    // Remaining count for the response.
    const waitingRow = await db.query(
      `SELECT count(*)::int AS n FROM message_queue
       WHERE agent_id = $1 AND status = 'pending'`,
      [agentId],
    )
    const waiting: number = waitingRow.rows[0]?.n ?? 0

    // §18.1 Reply Chain Context — seed is the current message
    // (spec `$current_message_id`). Non-fatal on query failure.
    const currentMessageId = (row.message_id as string | null) ?? (payload.message_id as string | null | undefined) ?? null
    let replyChain: Awaited<ReturnType<typeof fetchReplyChain>> = []
    // Issue #257 — light by default. CLI opt-back is via env var only
    // (`AGENT_COM_REPLY_CHAIN_MODE=full`) for legacy shell scripts; MCP path
    // uses `next({full: true})` arg. The asymmetry is intentional.
    const replyChainMode: 'light' | 'full' =
      (process.env.AGENT_COM_REPLY_CHAIN_MODE === 'full') ? 'full' : 'light'
    if (currentMessageId) {
      const depth = parseReplyChainDepth(process.env.AGENT_COM_REPLY_CHAIN_DEPTH)
      try {
        replyChain = await fetchReplyChain(currentMessageId, depth, {
          async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
            const r = await db.query(sql, params)
            return r.rows as T[]
          },
        } as any, replyChainMode)
      } catch (err) {
        process.stderr.write(`agent-com: fetchReplyChain failed (non-fatal): ${err}\n`)
      }
    }

    // Spec §4.1 output shape — channel_id / content / etc come from the
    // payload the receiver enriched on INSERT.
    process.stdout.write(JSON.stringify({
      waiting,
      mode: 'queue',
      queue_id: row.id,
      message_id: row.message_id ?? payload.message_id ?? null,
      channel_id: payload.channel_id,
      thread_id: payload.thread_id ?? null,
      from: payload.author_id,
      from_name: payload.author_name ?? null,
      content: payload.content,
      message_type: payload.message_type ?? 'chat',
      source: payload.source ?? null,
      created_at: row.created_at,
      reply_chain: replyChain,
    }) + '\n')
  } finally {
    await db.end()
  }
}

// Issue #130 Phase 4: nextMessageFromSignal (Mixed-Mode legacy fallback) was
// removed. The queue (message_queue table) is the sole message source.

/**
 * `agent-com send` — reply to the message captured by the most recent `next`
 * (Issue #128 Phase 2 / message-queue-spec §4.2).
 *
 * Internal flow (spec §4.2):
 *   1. Resolve in-flight target. Prefer agents.current_message_id (the new
 *      Phase 2 path). Fall back to /tmp state file (legacy / Mixed Mode §21).
 *   2. Validate mentions, channel membership.
 *   3. INSERT reply into agent_messages with reply_to = original message_id,
 *      thread_id from the queue payload.
 *   4. pg_notify per recipient (per PR#133 fan-out fix).
 *   5. UPDATE message_queue: status='replied', replied_at=NOW(),
 *      replied_with=<new id>. Clear agents.current_message_id.
 *   6. Outbound Discord delivery (per PR#133 ARC fix).
 *   7. On Discord failure, leave the queue row in 'replied' but report
 *      ok:false + db_saved:true so the operator can retry the outbound side.
 *
 * Flags:
 *   --content "<text>"        required
 *   --mention <agent>         canonical active owner
 *   --mentions <agent>        legacy single-owner alias
 *   --cc a,b / --fyi c        observer-only; no queue rows
 *   --message-type chat|...   default: chat
 *   --queue-id <id>           optional durable close target
 *   --message-id <uuid>       optional cross-check for --queue-id
 *   --no-close                ACK/progress reply: do not terminal-close work
 *   --close                   explicit final close intent (default-compatible)
 *
 * MVP scope (Phase 2): this is a thin INSERT + pg_notify path. The full
 * server.ts send handler (rate limit / dup check / message split / channel-
 * server push / SSE fallback) is intentionally NOT duplicated here — the
 * receiver picks up the row via pg_notify + message_queue and runs its own
 * routing. Phase 3 will extract a shared core module that both paths import.
 */
async function sendMessage(args: string[]) {
  const agentId = requireAgentId('send')
  const { flags } = parseArgs(args)
  let content = flags.content
  const mentionRaw = flags.mention
  const mentionsRaw = flags.mentions
  const mentionsInput = mentionsRaw !== undefined ? (parseCsvFlag(mentionsRaw) ?? []) : undefined
  const ccInput = parseCsvFlag(flags.cc) ?? []
  const fyiInput = parseCsvFlag(flags.fyi) ?? []
  const messageType = flags['message-type'] ?? 'chat'
  const queueIdRaw = flags['queue-id']
  const messageIdRaw = flags['message-id']
  const noClose = flagEnabled(flags['no-close'])
  const closeRequested = flagEnabled(flags.close)

  if (!content) {
    console.error('Error: --content is required')
    process.exit(2)
  }
  if (noClose && closeRequested) {
    console.error('Error: --no-close and --close are mutually exclusive')
    process.exit(2)
  }
  let mentions: string[] = []
  let ccObservers: string[] = []
  let fyiObservers: string[] = []

  // Phase 5 — best-effort client-side warning (server/DB path is canonical).
  // The authoritative resolver below runs after reply_to resolves a channel.
  try {
    const { resolvePhase5 } = await import('../core/routing/server-integration')
    const phase5Warn = resolvePhase5({
      sender: agentId,
      channel_id: '',
      mention: mentionRaw,
      mentions: mentionsInput,
      cc: ccInput,
      fyi: fyiInput,
      content,
      isKnownAgent: () => true,
    })
    if (phase5Warn && phase5Warn.ok) {
      for (const w of phase5Warn.warnings) {
        process.stderr.write(`agent-com: phase5 warning: ${w}\n`)
      }
    }
  } catch {}

  // ARC codex audit follow-up (PR#134) + Issue #278 (A) segment 3d:
  // wrap the entire DB-touching flow in BEGIN/COMMIT. The lock has
  // moved from the agents row to the per-row claim row on
  // message_queue, so independent claims (multi in-flight) proceed in
  // parallel; concurrent `agent-com send` calls targeting the SAME
  // claim still serialise on the message_queue row lock — the second
  // caller blocks, wakes to status='replied', misses the predicate,
  // and exits with INVALID_REPLY_TO instead of double-replying.
  //
  // Side effects to note:
  //   - The Discord HTTP call happens INSIDE the transaction (lead-ama's
  //     prescribed shape). The lock is held for the duration of the HTTP
  //     request. This is a deliberate trade-off for the simpler concurrency
  //     model; Phase 3 (outbound_queue) will move outbound delivery off the
  //     critical path.
  //   - process.exit() bypasses `finally` blocks, so the inner code MUST
  //     throw `CliSendExit` instead of calling process.exit() directly.
  //     The outer wrapper catches the exit class, runs ROLLBACK if needed,
  //     closes the db handle, and only then calls process.exit().
  class CliSendExit extends Error {
    constructor(public code: number) {
      super('cli send exit')
    }
  }

  function writeFailureJson(
    code: string,
    detail: string,
    extra: Record<string, unknown> = {},
    exitCode = 1,
  ): never {
    process.stdout.write(JSON.stringify({ ok: false, code, detail, ...extra }) + '\n')
    process.stderr.write(`Error [${code}]: ${detail}\n`)
    throw new CliSendExit(exitCode)
  }

  const db = await getDb()
  let exitCode = 0
  let committed = false
  try {
    await db.query('BEGIN')
    try {
      // ─────────────────────────────────────────────────────────────────
      // Step 1: resolve the in-flight target via the per-row claim
      // ─────────────────────────────────────────────────────────────────
      // FOR UPDATE on the message_queue claim row blocks any other
      // session that wakes for the same claim. The first caller wins;
      // the second blocks here until the first commits, then sees the
      // row in status='replied' and exits with INVALID_REPLY_TO.
      // Independent claims (multi in-flight) are unaffected — this
      // lock is per-row, not on the agents row.
      // Issue #130 Phase 4: target resolution is queue-only. The Mixed-Mode
      // signal fallback (Phase 2-3) has been removed.
      type Target = {
        reply_to: string         // agent_messages.id of the original
        channel_id: string
        thread_id: string | null
        queue_id: number | string // message_queue.id
      }
      let target: Target | null = null
      const explicitClose = !!queueIdRaw || !!messageIdRaw
      let claimRenewalEvidence: ClaimRenewalEvidence | null = null

      if (explicitClose) {
        let qres
        if (queueIdRaw) {
          const queueId = Number(queueIdRaw)
          if (!Number.isInteger(queueId) || queueId < 1) {
            writeFailureJson('QUEUE_NOT_FOUND', `invalid queue_id: ${queueIdRaw}`, { queue_id: queueIdRaw })
          }
          qres = await db.query(
            `SELECT id, agent_id, message_id, payload, status, claimed_by, claim_expires_at, replied_with
               FROM message_queue
              WHERE id = $1
              FOR UPDATE`,
            [queueId],
          )
        } else {
          qres = await db.query(
            `SELECT id, agent_id, message_id, payload, status, claimed_by, claim_expires_at, replied_with
               FROM message_queue
              WHERE agent_id = $1 AND message_id = $2
              ORDER BY created_at DESC
              LIMIT 1
              FOR UPDATE`,
            [agentId, messageIdRaw],
          )
        }

        if (qres.rows.length === 0) {
          writeFailureJson('QUEUE_NOT_FOUND', 'no message_queue row matches the explicit reply target', {
            queue_id: queueIdRaw ?? null,
            message_id: messageIdRaw ?? null,
          })
        }

        const qrow = qres.rows[0] as ExplicitReplyQueueRow
        if (messageIdRaw && qrow.message_id !== messageIdRaw) {
          writeFailureJson('QUEUE_MESSAGE_MISMATCH', 'queue_id and message_id identify different messages', {
            queue_id: qrow.id,
            expected_message_id: qrow.message_id,
            supplied_message_id: messageIdRaw,
          })
        }
        if (qrow.agent_id !== agentId) {
          writeFailureJson('NOT_MENTIONED', `queue row is addressed to ${qrow.agent_id}, not ${agentId}`, {
            queue_id: qrow.id,
            message_id: qrow.message_id,
          })
        }
        if (qrow.replied_with || TERMINAL_REPLY_CLOSE_STATUSES.has(qrow.status)) {
          const replay = await loadReplyCloseReplay(db, qrow, agentId)
          if (replay.kind === 'idempotent') {
            await db.query('COMMIT')
            committed = true
            process.stdout.write(JSON.stringify(replay.response) + '\n')
            return
          }
          const response = replay.response
          writeFailureJson(
            String(response.code),
            String(response.detail ?? `queue row is already terminal (${qrow.status})`),
            response,
          )
        }
        if (ACTIVE_REPLY_CLAIM_STATUSES.has(qrow.status) && qrow.claimed_by && qrow.claimed_by !== agentId) {
          writeFailureJson('NOT_CLAIM_OWNER', `queue row is actively claimed by ${qrow.claimed_by}`, {
            queue_id: qrow.id,
            message_id: qrow.message_id,
            claimed_by: qrow.claimed_by,
          })
        }
        if (
          ACTIVE_REPLY_CLAIM_STATUSES.has(qrow.status) &&
          qrow.claimed_by === agentId &&
          (dateMs(qrow.claim_expires_at) === null || dateMs(qrow.claim_expires_at)! <= Date.now())
        ) {
          if (!queueIdRaw) {
            writeFailureJson('QUEUE_ID_REQUIRED_FOR_RENEWAL', 'expired same-owner claim renewal requires explicit --queue-id', {
              queue_id: null,
              message_id: qrow.message_id,
              status: qrow.status,
              claimed_by: qrow.claimed_by,
              claim_expires_at: normalizeDateString(qrow.claim_expires_at),
            }, 2)
          }
          claimRenewalEvidence = await renewSameOwnerClaimForReplyClose(db, qrow, agentId)
          qrow.claim_expires_at = claimRenewalEvidence.new_claim_expires_at
        }
        if (!ACTIVE_REPLY_CLAIM_STATUSES.has(qrow.status)) {
          writeFailureJson('INVALID_STATE', `queue row status=${qrow.status}; expected received|in_progress for explicit close`, {
            queue_id: qrow.id,
            message_id: qrow.message_id,
            status: qrow.status,
            claimed_by: qrow.claimed_by,
          })
        }
        if (qrow.claimed_by !== agentId) {
          writeFailureJson('NOT_CLAIM_OWNER', `queue row is not actively claimed by ${agentId}`, {
            queue_id: qrow.id,
            message_id: qrow.message_id,
            status: qrow.status,
            claimed_by: qrow.claimed_by,
          })
        }

        const payload = parseQueuePayloadLoose(qrow.payload)
        const replyTo = qrow.message_id ?? payload.message_id
        const channelId = payload.channel_id
        if (!replyTo || !channelId) {
          writeFailureJson('QUEUE_NOT_FOUND', 'queue row is missing message_id or channel_id metadata', {
            queue_id: qrow.id,
            message_id: qrow.message_id ?? null,
          })
        }
        target = {
          reply_to: replyTo,
          channel_id: channelId,
          thread_id: payload.thread_id ?? null,
          queue_id: qrow.id,
        }
      }

      // Issue #278 (A) segment 3d — per-row claim lookup. Replaces the
      // legacy SELECT current_message_id FROM agents path. The CLI does
      // not take a --reply-to flag, so we resolve "the in-flight message"
      // as the most recent active claim owned by this agent: the row
      // with claimed_by=$agentId AND status='received' ORDER BY claimed_at
      // DESC LIMIT 1. FOR UPDATE on that row serialises any concurrent
      // `agent-com send` for the same claim — the second caller wakes
      // to status='replied' on the locked row, the predicate misses,
      // and it exits with INVALID_REPLY_TO instead of double-replying.
      // Independent claims (multi in-flight) are unaffected because the
      // lock is per-row, not on the agents row.
      if (!explicitClose) {
        const claimRow = await db.query(
          `SELECT id, message_id, payload FROM message_queue
              WHERE claimed_by = $1 AND status = 'received'
              ORDER BY claimed_at DESC NULLS LAST
              LIMIT 1
              FOR UPDATE`,
          [agentId],
        )
        if (claimRow.rows.length > 0) {
          const qrow = claimRow.rows[0]
          let payload: Record<string, any> = {}
          try { payload = JSON.parse(qrow.payload) } catch {}
          target = {
            reply_to: qrow.message_id ?? payload.message_id,
            channel_id: payload.channel_id,
            thread_id: payload.thread_id ?? null,
            queue_id: qrow.id,
          }
        }
      }

      if (target === null) {
        // Issue #278 §1 error taxonomy: NO_CURRENT_MESSAGE retired in
        // favour of INVALID_REPLY_TO. The CLI hits this branch when the
        // agent has no active claim — either `next` was never called,
        // the claim TTL expired and the sweeper flipped it to
        // IMPLICIT_ABANDON, or a concurrent `send` already replied.
        process.stdout.write(JSON.stringify({
          ok: false,
          code: 'RECLAIM_REQUIRED',
          reason: 'CLAIM_EXPIRED',
          legacy_code: 'INVALID_REPLY_TO',
          detail: `no active received claim for ${agentId}; retry with explicit --queue-id/--message-id durable close`,
        }) + '\n')
        console.error(`Error [INVALID_REPLY_TO]: no in-flight claim for ${agentId} — run 'agent-com next' first or the claim may have expired`)
        throw new CliSendExit(1)
      }

      const threadId: string | null = target.thread_id
      const channelId: string = target.channel_id
      const replyTo: string = target.reply_to
      // Membership check — bot can only reply in channels it belongs to.
      const ch = await db.query('SELECT members FROM channels WHERE id = $1', [channelId])
      if (ch.rows.length === 0) {
        if (explicitClose) {
          writeFailureJson('NOT_CHANNEL_MEMBER', `channel ${channelId} not found`, {
            queue_id: target.queue_id,
            message_id: replyTo,
            channel_id: channelId,
          })
        } else {
          console.error(`Error: channel ${channelId} not found`)
          throw new CliSendExit(1)
        }
      }
      const members: string[] = ch.rows[0].members ?? []
      if (!members.includes(agentId)) {
        if (explicitClose) {
          writeFailureJson('NOT_CHANNEL_MEMBER', `${agentId} is not a member of channel ${channelId}`, {
            queue_id: target.queue_id,
            message_id: replyTo,
            channel_id: channelId,
          })
        } else {
          console.error(`Error: ${agentId} is not a member of channel ${channelId}`)
          throw new CliSendExit(1)
        }
      }

      {
        const { resolvePhase5 } = await import('../core/routing/server-integration')
        const knownAgents = await loadKnownAgentIds(db)
        await refreshChannelPolicyDbSnapshot(db)
        const phase5 = resolvePhase5({
          sender: agentId,
          channel_id: channelId,
          mention: mentionRaw,
          mentions: mentionsInput,
          cc: ccInput,
          fyi: fyiInput,
          content,
          isKnownAgent: (id: string) => knownAgents.includes(id),
        })
        if (!phase5 || !phase5.ok) {
          const code = phase5?.ok === false ? phase5.error : 'INVALID_MENTION'
          const detail = code === 'UNKNOWN_AGENT'
            ? `mention agent_id "${phase5 && !phase5.ok ? phase5.detail : ''}" not found in agents registry`
            : code === 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED'
              ? 'send/notify supports exactly one active owner. Use --mention for the owner and --cc/--fyi for observers.'
              : code === 'OUTBOUND_ACL_VIOLATION'
                ? `sender ${agentId} or recipients ${(phase5 && !phase5.ok ? phase5.violations ?? [] : []).join(',')} violate channel.outboundAllowlist; allowlist=${JSON.stringify(getChannelPolicy(channelId).outboundAllowlist)} policy_source=${getChannelPolicy(channelId).policySource}`
                : 'mention/mentions must contain exactly one non-empty agent_id'
          if (code === 'OUTBOUND_ACL_VIOLATION' && phase5 && !phase5.ok) {
            await db.query('ROLLBACK').catch(() => {})
            committed = true
            await auditOutboundAclViolation(db, 'send', agentId, channelId, phase5.intended_recipients ?? [], {
              ok: false,
              violations: phase5.violations ?? [],
              violated_policy: 'channel.outboundAllowlist',
              outbound_allowlist: getChannelPolicy(channelId).outboundAllowlist,
              policy_source: getChannelPolicy(channelId).policySource,
            }).catch((err) => process.stderr.write(`agent-com: outbound ACL audit failed (non-fatal): ${err}\n`))
          }
          if (explicitClose) {
            writeFailureJson(code, detail, {
              queue_id: target.queue_id,
              message_id: replyTo,
              channel_id: channelId,
              intended_recipients: phase5 && !phase5.ok ? phase5.intended_recipients ?? undefined : undefined,
              violations: phase5 && !phase5.ok ? phase5.violations ?? undefined : undefined,
            }, code === 'INVALID_MENTION' || code === 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED' ? 2 : 1)
          }
          console.error(`Error [${code}]: ${detail}`)
          throw new CliSendExit(code === 'INVALID_MENTION' || code === 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED' ? 2 : 1)
        }
        content = phase5.content
        mentions = phase5.mentions
        ccObservers = phase5.cc
        fyiObservers = phase5.fyi
        for (const w of phase5.warnings) {
          process.stderr.write(`agent-com: phase5 warning: ${w}\n`)
        }
      }

      const aclResult = await validateCliOutboundPolicy(db, agentId, channelId, mentions)
      if (aclResult.ok === false) {
        const detail = `sender ${agentId} or recipients ${aclResult.violations.join(',')} violate channel.outboundAllowlist`
        await db.query('ROLLBACK').catch(() => {})
        committed = true
        await auditOutboundAclViolation(db, 'send', agentId, channelId, mentions, aclResult)
          .catch((err) => process.stderr.write(`agent-com: outbound ACL audit failed (non-fatal): ${err}\n`))
        if (explicitClose) {
          writeFailureJson('OUTBOUND_ACL_VIOLATION', detail, {
            queue_id: target.queue_id,
            message_id: replyTo,
            channel_id: channelId,
            violations: aclResult.violations,
            sender: agentId,
            intended_recipients: mentions,
            violated_policy: aclResult.violated_policy,
            outbound_allowlist: aclResult.outbound_allowlist,
            policy_source: aclResult.policy_source,
          })
        } else {
          console.error(`Error [OUTBOUND_ACL_VIOLATION]: ${detail}; allowlist=${JSON.stringify(aclResult.outbound_allowlist)} policy_source=${aclResult.policy_source}`)
          throw new CliSendExit(1)
        }
      }

      const activeOwner = mentions[0]
      if (!activeOwner) {
        writeFailureJson('INVALID_MENTION', 'mention/mentions must contain exactly one non-empty agent_id', {
          queue_id: target.queue_id,
          message_id: replyTo,
          channel_id: channelId,
        }, 2)
      }
      const conversationGate = resolveConversationControlPlaneGate('cli.send')
      if (!conversationGate.ok) {
        writeFailureJson(conversationGate.error, `invalid AGENT_COM_CONVERSATION_CONTROL_PLANE mode: ${conversationGate.value}`, {
          queue_id: target.queue_id,
          message_id: replyTo,
          channel_id: channelId,
          value: conversationGate.value,
        }, 2)
      }
      let conversationControlPlaneSummary: Record<string, unknown> | null = null

      const id = randomUUID()
      // ARC codex audit (2026-04-10): include HMAC auth metadata so receivers
      // in `enforce` mode don't drop CLI-originated rows as [UNVERIFIED]. The
      // helper returns undefined when AGENT_COMMS_AUTH_MODE === 'off' / no
      // secret, matching server.ts:createAuthMetadata behavior.
      const authMeta = buildAuthMetadata(agentId, channelId, content)
      const routingScope = {
        mode: 'anchored_queue_claim',
        surface: 'cli.send',
        channel_id: channelId,
        thread_id: threadId,
        reply_to: replyTo,
        queue_id: target.queue_id,
        alias_resolution: false,
      }
      const metadata: Record<string, unknown> = {
        mentions,
        cli: 'agent-com next/send (MVP)',
        routing_scope: routingScope,
        aun_control_plane: {
          active_owner: mentions[0] ?? null,
          cc: ccObservers,
          fyi: fyiObservers,
          observers: [...new Set([...ccObservers, ...fyiObservers])],
        },
        ...(authMeta ?? {}),
      }
      await db.query(
        `INSERT INTO agent_messages
           (id, channel_id, author_id, content, message_type, reply_to, metadata,
            depth, source, thread_id, direction, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'agent-comms', $8, 'outbound', 'agent')`,
        [id, channelId, agentId, content, messageType, replyTo, JSON.stringify(metadata), threadId],
      )

      // Phase 2 F cycle 2 (CTO judgment option (a), msg 1495781874977734814):
      // CLI-initiated send performs message_queue fanout directly instead of
      // delegating to the daemon's agent_inbox LISTEN handler. The old
      // `pg_notify('agent_inbox', …)` path dropped silently in SQLite mode
      // (no LISTEN-er) so recipients never saw the message; this direct call
      // works for both PG and SQLite backends identically.
      //
      // ADR-050 (2026-05-05): wake-daemon (bin/wake-daemon.ts) handles
      // recipient wake-up by polling message_queue + tmux send-keys; the
      // CLI no longer needs an in-process signal bus.
      const fanoutRes = await fanoutToRecipients(
        {
          query: async <T = any>(sql: string, params?: any[]) => {
            const r = await db.query(sql, params)
            return { rows: r.rows as T[] }
          },
        },
        {
          messageId: id,
          channelId,
          threadId,
          authorId: agentId,
          content,
          recipients: mentions,
          messageType,
          source: 'cli-send',
        },
      )
      if (fanoutRes.failed.length > 0) {
        process.stderr.write(
          `agent-com: fanout had ${fanoutRes.failed.length} failure(s): ${fanoutRes.failed.join(', ')}\n`,
        )
      }

      if (conversationGate.allocate) {
        const queueRow = fanoutRes.inserted_rows.find((row) => row.recipient === activeOwner)
        const rawAdapter = getRawDbAdapter(db)
        if (!queueRow || !rawAdapter) {
          conversationControlPlaneSummary = {
            ok: false,
            action: 'skipped',
            mode: conversationGate.mode,
            audit_only: conversationGate.audit_only,
            block_on_error: conversationGate.block_on_error,
            error: queueRow ? 'DB_ADAPTER_UNAVAILABLE' : 'CONVERSATION_QUEUE_ROW_NOT_INSERTED',
          }
          await auditLog(db, 'conversation.control_plane.apply', agentId, channelId, {
            surface: 'cli.send',
            message_id: id,
            reply_to: replyTo,
            active_owner: activeOwner,
            source_queue_id: queueRow?.queue_id ?? null,
            ...conversationControlPlaneSummary,
          })
          if (conversationGate.block_on_error) {
            writeFailureJson(String(conversationControlPlaneSummary.error), 'conversation control-plane could not link the active owner queue row', {
              queue_id: target.queue_id,
              message_id: replyTo,
              outbound_message_id: id,
              active_owner: activeOwner,
            })
          }
        } else {
          const replyToConversationId = await loadMessageConversationId(db, replyTo)
          const applied = await applyConversationControlPlaneAllocation(rawAdapter, 'cli.send', {
            surface: 'cli.send',
            channel_id: channelId,
            thread_id: threadId,
            root_message_id: id,
            reply_to_conversation_id: replyToConversationId,
            provider_parent_reference: replyTo,
            orphan_policy: 'isolate',
            owner_agent_id: activeOwner,
            source_queue_id: queueRow.queue_id,
            message_id: id,
          }, {
            allocator: allocateConversationRootInTransaction,
          })
          conversationControlPlaneSummary = summarizeConversationControlPlaneResult(applied)
          await auditLog(db, 'conversation.control_plane.apply', agentId, channelId, {
            surface: 'cli.send',
            message_id: id,
            reply_to: replyTo,
            active_owner: activeOwner,
            source_queue_id: queueRow.queue_id,
            reply_to_conversation_id: replyToConversationId,
            ...conversationControlPlaneSummary,
          })
          if (!applied.ok) {
            const allocationError = conversationControlPlaneFailureError(applied)
            const allocationErrorDetail = conversationControlPlaneFailureDetail(applied)
            writeFailureJson('CONVERSATION_CONTROL_PLANE_ENFORCE_FAILED', `conversation control-plane enforce failed: ${allocationError}`, {
              queue_id: target.queue_id,
              message_id: replyTo,
              outbound_message_id: id,
              active_owner: activeOwner,
              error: allocationError,
              allocation_error: allocationError,
              allocation_error_detail: allocationErrorDetail,
              conversation_control_plane: conversationControlPlaneSummary,
            })
          }
        }
      }

      // ─────────────────────────────────────────────────────────────────
      // Issue #129 Phase 3: outbound_queue INSERT (replaces deliverToDiscord)
      // ─────────────────────────────────────────────────────────────────
      // The Phase 1.5 cut called Discord REST API directly inside the
      // transaction, holding the agents row lock for the duration of the
      // HTTP call. Phase 3 replaces that with an outbound_queue row INSERT
      // — the receiver-side consumer (server.ts:startOutboundConsumer)
      // dequeues and posts on its 1-second tick.
      //
      // Benefits:
      //   - Lock holding time drops from ~Discord-RTT to ~1ms (DB only).
      //   - Retries are centralised in the consumer (attempts/max_attempts).
      //   - Outbound failures no longer fail the send tool synchronously.
      //
      // Resolution order for channel_external_id mirrors deliverToDiscord:
      //   1. thread_adapters (when threadId is set, so the post lands in
      //      the thread, not the parent)
      //   2. channel_adapters fallback
      //
      // If no Discord adapter exists for this channel, the row never gets
      // queued. The receiver pipeline still picks up the agent_messages row
      // via pg_notify, so other bots see the message; only the human-facing
      // Discord display is skipped. We surface this in the response.
      const projection = await resolveOutboundProjectionDecision(db as any, {
        channelId,
        threadId,
        senderAgentId: agentId,
        recipientAgentIds: mentions,
      })

      let outboundQueued = false
      const outboundSkipReason = outboundProjectionSkipReason(projection)
      if (outboundSkipReason) {
        await auditLog(db, 'outbound.enqueue_skipped', agentId, channelId, {
          code: outboundProjectionSkipCode(outboundSkipReason),
          message_id: id,
          channel_external_id: projection.channelExternalId,
          consumer_source: projection.consumerSource,
          consumer_evidence: projection.consumerEvidence,
          projection_source: projection.projectionSource,
          delivery_fallback_reason: projection.deliveryFallbackReason,
          delivery_diagnostics: projection.deliveryDiagnostics,
          reason: outboundSkipReason,
        })
      } else {
        const discordExternalId = projection.channelExternalId!
        try {
          // v2.1.0: clamp outbound content at DISCORD_MAX (1900) chars before
          // enqueue so an over-long LLM reply is truncated once, deterministically,
          // instead of being split across retries inside the Discord adapter.
          await db.query(
            `INSERT INTO outbound_queue (message_id, agent_id, consumer_agent_id, consumer_source, delivery_connector_instance_id, channel_binding_id, provider_channel_access_id, projection_identity_id, intended_projection_identity_id, projection_source, projection_fallback_reason, delivery_fallback_reason, delivery_diagnostics, channel_external_id, content)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              id,
              agentId,
              projection.consumerAgentId,
              projection.consumerSource,
              projection.consumerEvidence?.connector_instance_id ?? null,
              projection.consumerEvidence?.channel_binding_id ?? null,
              projection.consumerEvidence?.provider_channel_access_id ?? null,
              projection.projectionIdentityId,
              projection.intendedProjectionIdentityId,
              projection.projectionSource,
              projection.projectionFallbackReason,
              projection.deliveryFallbackReason,
              JSON.stringify(projection.deliveryDiagnostics),
              discordExternalId,
              truncateForDiscord(decorateProjectedContent({
                content,
                authorAgentId: agentId,
                consumerAgentId: projection.consumerAgentId,
                recipients: mentions,
              })),
            ],
          )
          outboundQueued = true
        } catch (err) {
          // INSERT into outbound_queue failed — this is a DB error, not a
          // Discord error. Roll back the entire transaction so the caller
          // gets a clean retry path. The throw is caught by the inner finally
          // (which ROLLBACKs because committed=false) and the outer catch
          // (which exits non-zero).
          throw err
        }
      }

      const workClosed = !noClose
      if (workClosed) {
        // ─────────────────────────────────────────────────────────────────
        // Finalize in-flight state (§4.2 step 9-11).
        // Issue #130 Phase 4: signal-mode unlink path removed. Queue mode is
        // the only path now. #420 keeps this default path for backward
        // compatibility; ACK/progress callers opt out with --no-close.
        // ─────────────────────────────────────────────────────────────────
        await db.query(
          `UPDATE message_queue
              SET status = 'replied',
                  replied_at = now(),
                  replied_with = $1,
                  claimed_by = NULL,
                  claimed_at = NULL,
                  claim_expires_at = NULL
           WHERE id = $2`,
          [id, target.queue_id],
        )
        // spec §4.2 step 10-11 — flip the agent based on remaining open
        // claims. Issue #278 cycle 1 (auditor BLOCK 1): with multi in-flight
        // the send only closed ONE claim; if other claims are still 'received'
        // the agent must remain busy. EXISTS-derive keeps observability
        // (sender-feedback / heartbeat / bot_status) tracking the truth.
        await db.query(
          `UPDATE agents SET
             status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
             status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
             status_updated_at = now()
           WHERE agent_id = $1`,
          [agentId],
        )
      }
      await auditLog(db, 'message.send', agentId, channelId, {
        message_id: id,
        reply_to: replyTo,
        queue_id: target.queue_id,
        channel_id: channelId,
        thread_id: threadId,
        sender: agentId,
        active_owner: agentId,
        recipients: mentions,
        surface: 'cli.send',
        alias_resolution: false,
      })
      await db.query('COMMIT')
      committed = true

      process.stdout.write(JSON.stringify({
        ok: true,
        message_id: id,
        channel_id: channelId,
        thread_id: threadId,
        reply_to: replyTo,
        mentions,
        active_owner: mentions[0] ?? null,
        cc: ccObservers,
        fyi: fyiObservers,
        auth_signed: authMeta !== undefined,
        outbound_queued: outboundQueued,
        work_closed: workClosed,
        close_mode: workClosed ? (explicitClose || closeRequested ? 'explicit' : 'active_claim') : 'none',
        queue_id: target.queue_id,
        ...(claimRenewalEvidence ? { claim_renewal: claimRenewalEvidence } : {}),
        ...(conversationControlPlaneSummary ? { conversation_control_plane: conversationControlPlaneSummary } : {}),
        ...(outboundSkipReason ? { outbound_skip_reason: outboundSkipReason } : {}),
      }) + '\n')
    } finally {
      // If we threw without committing (validation error, INVALID_REPLY_TO,
      // unexpected exception), roll the transaction back. The committed flag
      // is set right after each successful COMMIT above so this is a no-op
      // on the success and queue-failure paths.
      if (!committed) {
        await db.query('ROLLBACK').catch(() => {})
      }
    }
  } catch (err) {
    if (err instanceof CliSendExit) {
      exitCode = err.code
    } else {
      throw err
    }
  } finally {
    await db.end()
  }
  if (exitCode !== 0) process.exit(exitCode)
}

/**
 * `agent-com notify` — self-originated post (spec §4.3). No reply context,
 * no current_message_id touched, no agents.status transition. Intended for
 * watchdog / startup / periodic-report flows where the caller picks the
 * destination explicitly.
 *
 * Flags:
 *   --channel-id <id>         required for scripted use — canonical destination channel_id
 *   --channel-name <name> --resolve-channel-name
 *                             human alias path only; resolves uniquely or fails closed
 *   --thread-id <id>          optional — post into a thread instead
 *   --mention <agent>         canonical active owner
 *   --mentions <agent>        legacy single-owner alias
 *   --cc a,b / --fyi c        observer-only; no queue rows
 *   --content "<text>"        required
 *   --message-type chat|...   default: chat
 */
async function notifyMessage(args: string[]) {
  const agentId = requireAgentId('notify')
  const { flags } = parseArgs(args)
  const legacyChannelProvided = flags.channel !== undefined
  const channelIdArg = typeof flags['channel-id'] === 'string' ? flags['channel-id'] : undefined
  const channelNameArg = typeof flags['channel-name'] === 'string' ? flags['channel-name'] : undefined
  const resolveChannelName = !!flags['resolve-channel-name']
  const threadArg = flags['thread-id'] ?? null
  let content = flags.content
  const mentionRaw = flags.mention
  const mentionsRaw = flags.mentions
  const mentionsInput = mentionsRaw !== undefined ? (parseCsvFlag(mentionsRaw) ?? []) : undefined
  const ccInput = parseCsvFlag(flags.cc) ?? []
  const fyiInput = parseCsvFlag(flags.fyi) ?? []
  const messageType = flags['message-type'] ?? 'chat'

  if (legacyChannelProvided) {
    console.error('Error [CHANNEL_ALIAS_NOT_ALLOWED]: --channel is ambiguous and no longer accepted for notify; use --channel-id, or --channel-name with --resolve-channel-name for human alias resolution')
    process.exit(2)
  }
  if (channelIdArg && channelNameArg) {
    console.error('Error [INVALID_PARAMETER]: pass either --channel-id or --channel-name, not both')
    process.exit(2)
  }
  if (channelNameArg && !resolveChannelName) {
    console.error('Error [CHANNEL_ALIAS_NOT_ALLOWED]: --channel-name requires --resolve-channel-name')
    process.exit(2)
  }
  if (!channelIdArg && !channelNameArg) {
    console.error('Error [CHANNEL_ID_REQUIRED]: --channel-id is required for notify')
    process.exit(2)
  }
  if (!content) {
    console.error('Error: --content is required')
    process.exit(2)
  }
  let mentions: string[] = []
  let ccObservers: string[] = []
  let fyiObservers: string[] = []

  // Phase 5 — best-effort client-side warning (server/DB path is canonical).
  // The authoritative resolver below runs after channel name/id resolution.
  try {
    const { resolvePhase5 } = await import('../core/routing/server-integration')
    const phase5Warn = resolvePhase5({
      sender: agentId,
      channel_id: '',
      mention: mentionRaw,
      mentions: mentionsInput,
      cc: ccInput,
      fyi: fyiInput,
      content,
      isKnownAgent: () => true,
    })
    if (phase5Warn && phase5Warn.ok) {
      for (const w of phase5Warn.warnings) {
        process.stderr.write(`agent-com: phase5 warning: ${w}\n`)
      }
    }
  } catch {}

  const db = await getDb()
  try {
    // Resolve channel: canonical channel_id for scripted use, or explicit
    // human alias path when --channel-name --resolve-channel-name is passed.
    let resolvedChannelId: string | null = null
    let resolvedThreadId: string | null = threadArg
    let channelResolution: Record<string, unknown> = {
      mode: 'canonical_channel_id',
      alias_resolution: false,
      surface: 'cli.notify',
    }

    if (channelIdArg) {
      const byId = await db.query(`SELECT id FROM channels WHERE id = $1`, [channelIdArg])
      if (byId.rows.length === 0) {
        console.error(`Error [CHANNEL_ID_NOT_FOUND]: channel_id '${channelIdArg}' not found`)
        process.exit(1)
      }
      resolvedChannelId = channelIdArg
      channelResolution = {
        ...channelResolution,
        channel_id: resolvedChannelId,
      }
    } else if (channelNameArg) {
      const byName = await db.query(`SELECT id FROM channels WHERE name = $1 ORDER BY id LIMIT 2`, [channelNameArg])
      if (byName.rows.length === 0) {
        console.error(`Error [CHANNEL_NAME_NOT_FOUND]: channel name '${channelNameArg}' not found`)
        process.exit(1)
      }
      if (byName.rows.length > 1) {
        const ids = byName.rows.map((r: { id: string }) => r.id).join(', ')
        console.error(`Error [CHANNEL_NAME_AMBIGUOUS]: channel name '${channelNameArg}' matches multiple channels (${ids}…). Pass --channel-id instead.`)
        process.exit(1)
      }
      resolvedChannelId = byName.rows[0].id
      channelResolution = {
        mode: 'human_channel_name',
        alias_resolution: true,
        input_alias: channelNameArg,
        channel_id: resolvedChannelId,
        resolved_channel_id: resolvedChannelId,
        candidate_count: 1,
        surface: 'cli.notify',
      }
      await auditLog(db, 'channel.alias_resolved', agentId, resolvedChannelId, channelResolution)
        .catch((err) => process.stderr.write(`agent-com: channel alias audit failed (non-fatal): ${err}\n`))
    }

    if (!resolvedChannelId) {
      console.error('Error [CHANNEL_ID_REQUIRED]: --channel-id is required for notify')
      process.exit(2)
    }

    if (resolvedThreadId) {
      const tr = await db.query(`SELECT channel_id FROM threads WHERE id = $1`, [resolvedThreadId])
      if (tr.rows.length === 0) {
        console.error(`Error [THREAD_NOT_FOUND]: thread '${resolvedThreadId}' not found`)
        process.exit(1)
      }
      const threadChannelId = tr.rows[0].channel_id
      if (threadChannelId !== resolvedChannelId) {
        console.error(`Error [THREAD_CHANNEL_MISMATCH]: thread '${resolvedThreadId}' belongs to channel '${threadChannelId}', not '${resolvedChannelId}'`)
        process.exit(1)
      }
    }

    // Membership check.
    const ch = await db.query(`SELECT members FROM channels WHERE id = $1`, [resolvedChannelId])
    if (ch.rows.length === 0) {
      console.error(`Error: channel ${resolvedChannelId} not found`)
      process.exit(1)
    }
    const members: string[] = ch.rows[0].members ?? []
    if (!members.includes(agentId)) {
      console.error(`Error: ${agentId} is not a member of channel ${resolvedChannelId}`)
      process.exit(1)
    }

    {
      const { resolvePhase5 } = await import('../core/routing/server-integration')
      const knownAgents = await loadKnownAgentIds(db)
      await refreshChannelPolicyDbSnapshot(db)
      const phase5 = resolvePhase5({
        sender: agentId,
        channel_id: resolvedChannelId,
        mention: mentionRaw,
        mentions: mentionsInput,
        cc: ccInput,
        fyi: fyiInput,
        content,
        isKnownAgent: (id: string) => knownAgents.includes(id),
      })
      if (!phase5 || !phase5.ok) {
        const code = phase5?.ok === false ? phase5.error : 'INVALID_MENTION'
        const detail = code === 'UNKNOWN_AGENT'
          ? `mention agent_id "${phase5 && !phase5.ok ? phase5.detail : ''}" not found in agents registry`
          : code === 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED'
            ? 'send/notify supports exactly one active owner. Use --mention for the owner and --cc/--fyi for observers.'
            : code === 'OUTBOUND_ACL_VIOLATION'
              ? `sender ${agentId} or recipients ${(phase5 && !phase5.ok ? phase5.violations ?? [] : []).join(',')} violate channel.outboundAllowlist; allowlist=${JSON.stringify(getChannelPolicy(resolvedChannelId).outboundAllowlist)} policy_source=${getChannelPolicy(resolvedChannelId).policySource}`
              : 'mention/mentions must contain exactly one non-empty agent_id'
        if (code === 'OUTBOUND_ACL_VIOLATION' && phase5 && !phase5.ok) {
          await auditOutboundAclViolation(db, 'notify', agentId, resolvedChannelId, phase5.intended_recipients ?? [], {
            ok: false,
            violations: phase5.violations ?? [],
            violated_policy: 'channel.outboundAllowlist',
            outbound_allowlist: getChannelPolicy(resolvedChannelId).outboundAllowlist,
            policy_source: getChannelPolicy(resolvedChannelId).policySource,
          }).catch((err) => process.stderr.write(`agent-com: outbound ACL audit failed (non-fatal): ${err}\n`))
        }
        console.error(`Error [${code}]: ${detail}`)
        process.exit(code === 'INVALID_MENTION' || code === 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED' ? 2 : 1)
      }
      content = phase5.content
      mentions = phase5.mentions
      ccObservers = phase5.cc
      fyiObservers = phase5.fyi
      for (const w of phase5.warnings) {
        process.stderr.write(`agent-com: phase5 warning: ${w}\n`)
      }
    }

    const aclResult = await validateCliOutboundPolicy(db, agentId, resolvedChannelId, mentions)
    if (aclResult.ok === false) {
      await auditOutboundAclViolation(db, 'notify', agentId, resolvedChannelId, mentions, aclResult)
        .catch((err) => process.stderr.write(`agent-com: outbound ACL audit failed (non-fatal): ${err}\n`))
      console.error(`Error [OUTBOUND_ACL_VIOLATION]: sender ${agentId} or recipients ${aclResult.violations.join(',')} violate channel.outboundAllowlist; allowlist=${JSON.stringify(aclResult.outbound_allowlist)} policy_source=${aclResult.policy_source}`)
      process.exit(1)
    }

    const activeOwner = mentions[0]
    if (!activeOwner) {
      console.error('Error [INVALID_MENTION]: mention/mentions must contain exactly one non-empty agent_id')
      process.exit(2)
    }
    const conversationGate = resolveConversationControlPlaneGate('cli.notify')
    if (!conversationGate.ok) {
      console.error(`Error [${conversationGate.error}]: invalid AGENT_COM_CONVERSATION_CONTROL_PLANE mode: ${conversationGate.value}`)
      process.exit(2)
    }
    let conversationControlPlaneSummary: Record<string, unknown> | null = null

    const id = randomUUID()
    let txCommitted = false
    await db.query('BEGIN')
    try {
      const authMeta = buildAuthMetadata(agentId, resolvedChannelId, content)
      const metadata: Record<string, unknown> = {
        mentions,
        cli: 'agent-com notify',
        channel_resolution: channelResolution,
        aun_control_plane: {
          active_owner: activeOwner,
          cc: ccObservers,
          fyi: fyiObservers,
          observers: [...new Set([...ccObservers, ...fyiObservers])],
        },
        ...(authMeta ?? {}),
      }
      await db.query(
        `INSERT INTO agent_messages
           (id, channel_id, author_id, content, message_type, reply_to, metadata,
            depth, source, thread_id, direction, role)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, 0, 'agent-comms', $7, 'outbound', 'agent')`,
        [id, resolvedChannelId, agentId, content, messageType, JSON.stringify(metadata), resolvedThreadId],
      )

      // Phase 2 F cycle 2: same direct fanout as `sendMessage()` — see rationale
      // there. Notify is self-originated (no reply_to) but otherwise the
      // delivery path is identical: per-recipient message_queue INSERT, no
      // pg_notify delegation. ADR-050: wake-daemon handles recipient wake-up.
      const fanoutRes = await fanoutToRecipients(
        {
          query: async <T = any>(sql: string, params?: any[]) => {
            const r = await db.query(sql, params)
            return { rows: r.rows as T[] }
          },
        },
        {
          messageId: id,
          channelId: resolvedChannelId,
          threadId: resolvedThreadId,
          authorId: agentId,
          content,
          recipients: mentions,
          messageType,
          source: 'cli-notify',
        },
      )
      if (fanoutRes.failed.length > 0) {
        process.stderr.write(
          `agent-com: notify fanout had ${fanoutRes.failed.length} failure(s): ${fanoutRes.failed.join(', ')}\n`,
        )
      }

      if (conversationGate.allocate) {
        const queueRow = fanoutRes.inserted_rows.find((row) => row.recipient === activeOwner)
        const rawAdapter = getRawDbAdapter(db)
        if (!queueRow || !rawAdapter) {
          conversationControlPlaneSummary = {
            ok: false,
            action: 'skipped',
            mode: conversationGate.mode,
            audit_only: conversationGate.audit_only,
            block_on_error: conversationGate.block_on_error,
            error: queueRow ? 'DB_ADAPTER_UNAVAILABLE' : 'CONVERSATION_QUEUE_ROW_NOT_INSERTED',
          }
          await auditLog(db, 'conversation.control_plane.apply', agentId, resolvedChannelId, {
            surface: 'cli.notify',
            message_id: id,
            active_owner: activeOwner,
            source_queue_id: queueRow?.queue_id ?? null,
            ...conversationControlPlaneSummary,
          })
          if (conversationGate.block_on_error) {
            console.error(`Error [${conversationControlPlaneSummary.error}]: conversation control-plane could not link the active owner queue row`)
            process.exitCode = 1
            return
          }
        } else {
          const applied = await applyConversationControlPlaneAllocation(rawAdapter, 'cli.notify', {
            surface: 'cli.notify',
            channel_id: resolvedChannelId,
            thread_id: resolvedThreadId,
            root_message_id: id,
            owner_agent_id: activeOwner,
            source_queue_id: queueRow.queue_id,
            message_id: id,
          }, {
            allocator: allocateConversationRootInTransaction,
          })
          conversationControlPlaneSummary = summarizeConversationControlPlaneResult(applied)
          await auditLog(db, 'conversation.control_plane.apply', agentId, resolvedChannelId, {
            surface: 'cli.notify',
            message_id: id,
            active_owner: activeOwner,
            source_queue_id: queueRow.queue_id,
            ...conversationControlPlaneSummary,
          })
          if (!applied.ok) {
            const allocationError = conversationControlPlaneFailureError(applied)
            const allocationErrorDetail = conversationControlPlaneFailureDetail(applied)
            const detailSuffix = allocationErrorDetail ? ` (${allocationErrorDetail})` : ''
            console.error(`Error [CONVERSATION_CONTROL_PLANE_ENFORCE_FAILED]: conversation control-plane enforce failed: ${allocationError}${detailSuffix}`)
            process.exitCode = 1
            return
          }
        }
      }

      const projection = await resolveOutboundProjectionDecision(db as any, {
        channelId: resolvedChannelId,
        threadId: resolvedThreadId,
        senderAgentId: agentId,
        recipientAgentIds: mentions,
      })
      let outboundQueued = false
      const outboundSkipReason = outboundProjectionSkipReason(projection)
      if (outboundSkipReason) {
        await auditLog(db, 'outbound.enqueue_skipped', agentId, resolvedChannelId, {
          code: outboundProjectionSkipCode(outboundSkipReason),
          message_id: id,
          channel_external_id: projection.channelExternalId,
          consumer_source: projection.consumerSource,
          consumer_evidence: projection.consumerEvidence,
          projection_source: projection.projectionSource,
          delivery_fallback_reason: projection.deliveryFallbackReason,
          delivery_diagnostics: projection.deliveryDiagnostics,
          reason: outboundSkipReason,
        })
      } else {
        const discordExternalId = projection.channelExternalId!
        try {
          // v2.1.0: clamp outbound content at DISCORD_MAX (1900) chars.
          await db.query(
            `INSERT INTO outbound_queue (message_id, agent_id, consumer_agent_id, consumer_source, delivery_connector_instance_id, channel_binding_id, provider_channel_access_id, projection_identity_id, intended_projection_identity_id, projection_source, projection_fallback_reason, delivery_fallback_reason, delivery_diagnostics, channel_external_id, content)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              id,
              agentId,
              projection.consumerAgentId,
              projection.consumerSource,
              projection.consumerEvidence?.connector_instance_id ?? null,
              projection.consumerEvidence?.channel_binding_id ?? null,
              projection.consumerEvidence?.provider_channel_access_id ?? null,
              projection.projectionIdentityId,
              projection.intendedProjectionIdentityId,
              projection.projectionSource,
              projection.projectionFallbackReason,
              projection.deliveryFallbackReason,
              JSON.stringify(projection.deliveryDiagnostics),
              discordExternalId,
              truncateForDiscord(decorateProjectedContent({
                content,
                authorAgentId: agentId,
                consumerAgentId: projection.consumerAgentId,
                recipients: mentions,
              })),
            ],
          )
          outboundQueued = true
        } catch (err) {
          console.error(`Error [OUTBOUND_ENQUEUE_FAILED]: ${String(err).slice(0, 200)}`)
          process.exitCode = 1
          return
        }
      }

      await db.query('COMMIT')
      txCommitted = true

      process.stdout.write(JSON.stringify({
        ok: true,
        message_id: id,
        channel_id: resolvedChannelId,
        thread_id: resolvedThreadId,
        mentions,
        active_owner: activeOwner,
        cc: ccObservers,
        fyi: fyiObservers,
        auth_signed: authMeta !== undefined,
        outbound_queued: outboundQueued,
        ...(conversationControlPlaneSummary ? { conversation_control_plane: conversationControlPlaneSummary } : {}),
        ...(outboundSkipReason ? { outbound_skip_reason: outboundSkipReason } : {}),
      }) + '\n')
    } finally {
      if (!txCommitted) {
        await db.query('ROLLBACK').catch(() => {})
      }
    }
  } finally {
    await db.end()
  }
}

/**
 * `agent-com fail` (spec §4.1, §11 failed_reason, v2.1.0) — mark a message_queue
 * row as `failed` with an explicit reason and release the agent to idle.
 *
 * Called by run-bot.sh / LLM integration when the message can't be replied to:
 * LLM_FAILED (empty / non-zero exit), SEND_FAILED_AFTER_N_RETRIES, LOOP_DETECTED,
 * or any other explicit abandon. Prior to v2.1.0 the implicit-skip path in `next`
 * used status='skipped', which collapsed "LLM lost" and "operator muted" into one
 * state and left no reason string. `fail` is the machine-issued counterpart to
 * the operator-issued `skip`.
 *
 * Flags:
 *   --message-id <uuid>  required — message_queue.message_id (agent_messages.id)
 *   --reason <text>      required — free-form reason, typically one of the
 *                                    §11 標準値 (IMPLICIT_ABANDON / LLM_FAILED /
 *                                    SEND_FAILED_AFTER_N_RETRIES / LOOP_DETECTED)
 *
 * Transaction: UPDATE message_queue → UPDATE agents in one BEGIN/COMMIT so a
 * crash cannot leave the queue row 'failed' while agents.current_message_id
 * still points at it.
 */
async function failMessage(args: string[]) {
  return failOrSkipMessage('fail', args)
}

/**
 * `agent-com skip` (spec §4.1, §11, v2.1.0) — operator-issued sibling of `fail`.
 * Marks the message_queue row `skipped` (not `failed`) to signal "manually muted,
 * no machine error occurred". Same transaction shape as fail.
 *
 * Flags:
 *   --message-id <uuid>  required
 *   --reason <text>      required — typically OBSOLETE / "manual override"
 */
async function skipMessage(args: string[]) {
  return failOrSkipMessage('skip', args)
}

/**
 * Shared implementation for fail/skip — they only differ in the target status.
 * Consolidated here to keep the transaction invariants identical.
 */
async function failOrSkipMessage(kind: 'fail' | 'skip', args: string[]) {
  const agentId = requireAgentId(kind)
  const { flags } = parseArgs(args)
  const messageId = flags['message-id']
  const reason = flags.reason

  if (!messageId) {
    console.error(`Error: --message-id is required`)
    process.exit(2)
  }
  if (!reason) {
    console.error(`Error: --reason is required`)
    process.exit(2)
  }

  const targetStatus = kind === 'fail' ? 'failed' : 'skipped'

  const db = await getDb()
  try {
    await db.query('BEGIN')
    try {
      // Match on (agent_id, message_id) — the partial UNIQUE index guarantees
      // this pair is unique when message_id IS NOT NULL, so we need no tie-break.
      const upd = await db.query(
        `UPDATE message_queue
            SET status = $1,
                failed_reason = $2,
                done_at = now(),
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
          WHERE agent_id = $3 AND message_id = $4 AND status IN ('pending','received')
          RETURNING id`,
        [targetStatus, reason, agentId, messageId],
      )
      if (upd.rows.length === 0) {
        await db.query('ROLLBACK')
        console.error(
          `Error: no in-flight or pending message_queue row for agent_id=${agentId}, message_id=${messageId} (already replied/failed/skipped?)`,
        )
        process.exit(1)
      }
      const queueId = upd.rows[0].id

      // Issue #278 cycle 1 (auditor BLOCK 1): EXISTS-derive busy/idle
      // from the remaining open claims. fail/skip closes one claim
      // only; if others are still 'received' the agent stays busy.
      await db.query(
        `UPDATE agents SET
           status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
           status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
           status_updated_at = now()
         WHERE agent_id = $1`,
        [agentId],
      )
      await db.query('COMMIT')

      process.stdout.write(JSON.stringify({
        ok: true,
        queue_id: queueId,
        message_id: messageId,
        status: targetStatus,
        failed_reason: reason,
      }) + '\n')
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await db.end()
  }
}

/**
 * `agent-com reclaim` (spec §4.1, v2.1.0) — manual orphan reclaim. When a bot
 * crashed after receiving a row (status='received' but never transitioned to replied/failed/skipped)
 * and the normal 15-minute daemon heartbeat reclaim has not run yet, an operator
 * can force the release here.
 *
 * The reclaim is intentionally conservative: it only rolls `read` → `pending` for
 * rows whose `read_at` is older than RECLAIM_MIN_AGE (15 minutes), matching the
 * daemon's orphan-reclaim cutoff. It also clears agents.current_message_id so a
 * fresh `next` can pop from the queue cleanly. Both updates run in one
 * BEGIN/COMMIT so a crash mid-flight cannot leave the agent stuck in `busy`.
 *
 * Flags:
 *   --agent-id <id>  required (falls back to AGENT_ID env)
 */
async function reclaimMessages(args: string[]) {
  const { flags } = parseArgs(args)
  const agentId = resolveAgentId(args, 'reclaim')

  const db = await getDb()
  try {
    await db.query('BEGIN')
    try {
      // Roll 'received' rows older than 15 minutes back to 'pending'. read_at is
      // cleared so a follow-up next() doesn't think the row is still in-flight.
      const rollback = await db.query(
        `UPDATE message_queue
            SET status = 'pending',
                read_at = NULL,
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
          WHERE agent_id = $1
            AND status = 'received'
            AND read_at < now() - INTERVAL '15 minutes'
          RETURNING id`,
        [agentId],
      )

      // Issue #278 cycle 1 (auditor BLOCK 1): reclaim respects multi
      // in-flight — after rolling expired 'received' rows back to 'pending',
      // the agent may still hold OTHER active claims that are not
      // orphaned. EXISTS-derive keeps the right state visible.
      await db.query(
        `UPDATE agents SET
           status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
           status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
           status_updated_at = now()
         WHERE agent_id = $1`,
        [agentId],
      )
      await db.query('COMMIT')

      process.stdout.write(JSON.stringify({
        ok: true,
        agent_id: agentId,
        reclaimed_count: rollback.rows.length,
        reclaimed_queue_ids: rollback.rows.map((r: any) => r.id),
      }) + '\n')
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await db.end()
  }
}

async function diagnoseDelivery(args: string[]) {
  const { flags } = parseArgs(args)
  const queueId = flags['queue-id']
  const messageId = flags['message-id']
  const outboundMessageId = flags['outbound-message-id'] ?? messageId
  const db = await getDb()
  try {
    const report: Record<string, unknown> = { ok: true, inbound: null, outbound: null }

    if (queueId || messageId) {
      const inbound = await db.query(
        `SELECT id, agent_id, message_id, status, claimed_by, claim_expires_at,
                replied_with, failed_reason, done_at
           FROM message_queue
          WHERE ($1::text IS NOT NULL AND id::text = $1)
             OR ($2::text IS NOT NULL AND message_id = $2)
          ORDER BY created_at DESC
          LIMIT 1`,
        [queueId ?? null, messageId ?? null],
      )
      report.inbound = diagnoseInboundQueueRow(inbound.rows[0] ?? null)
    }

    if (outboundMessageId) {
      const outbound = await db.query(
        `SELECT id, message_id, agent_id, consumer_agent_id, consumer_source,
                delivery_connector_instance_id, channel_binding_id, provider_channel_access_id,
                projection_identity_id, intended_projection_identity_id,
                projection_source, projection_fallback_reason,
                delivery_fallback_reason, delivery_diagnostics, channel_external_id,
                status, attempts, max_attempts, last_error, sent_at, discord_message_id
           FROM outbound_queue
          WHERE message_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [outboundMessageId],
      )
      const row = outbound.rows[0] ?? null
      const consumerAgentId = row ? (row.consumer_agent_id ?? row.agent_id) : null
      const consumer = consumerAgentId
        ? await db.query(
          `SELECT agent_id, status, metadata
             FROM agents WHERE agent_id = $1`,
          [consumerAgentId],
        ).catch(() => ({ rows: [] as any[] }))
        : { rows: [] as any[] }
      const consumerRow = consumer.rows[0]
      if (consumerRow) {
        const binding = await getDiscordUiBindingForAgent(db as any, consumerAgentId ?? '')
        const discordUiId = await getAgentDiscordUiId(db as any, consumerAgentId ?? '')
        consumerRow.has_discord_id = discordUiId !== null
        consumerRow.discord_ui_id = discordUiId
        consumerRow.discord_ui_binding_status = binding?.status ?? null
      }
      const projectionIdentityId = row?.projection_identity_id ?? null
      const projection = projectionIdentityId
        ? await db.query(
          `SELECT agent_id, status, metadata
             FROM agents WHERE agent_id = $1`,
          [projectionIdentityId],
        ).catch(() => ({ rows: [] as any[] }))
        : { rows: [] as any[] }
      const projectionRow = projection.rows[0]
      if (projectionRow) {
        const binding = await getDiscordUiBindingForAgent(db as any, projectionIdentityId ?? '')
        const discordUiId = await getAgentDiscordUiId(db as any, projectionIdentityId ?? '')
        projectionRow.has_discord_id = discordUiId !== null
        projectionRow.discord_ui_id = discordUiId
        projectionRow.discord_ui_binding_status = binding?.status ?? null
      }
      report.outbound = diagnoseOutboundQueueRow(row, consumerRow ?? null, projectionRow ?? null)
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await db.end()
  }
}

async function diagnoseProjection(args: string[]) {
  const { flags } = parseArgs(args)
  const channelId = flags.channel ?? flags['channel-id']
  const threadId = flags['thread-id'] ?? null
  const fromAgentId = flags.from ?? flags['from-agent-id'] ?? process.env.AGENT_ID ?? null
  const toAgentIds = (flags.to ?? flags['to-agent-id'] ?? flags.mentions ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const format = flags.format ?? 'text'

  if (!channelId || !fromAgentId || toAgentIds.length === 0) {
    console.error('Usage: agent-com diagnose-projection --channel <id> --from <agent_id> --to <agent_id>[,<agent_id>] [--thread-id <id>] [--format json]')
    process.exit(1)
  }

  const db = await getDb()
  try {
    const projection = await resolveOutboundProjectionDecision(db as any, {
      channelId,
      threadId,
      senderAgentId: fromAgentId,
      recipientAgentIds: toAgentIds,
    })
    const consumerAgentId = projection.consumerAgentId
    const consumer = consumerAgentId
      ? await db.query(
        `SELECT agent_id, status, runtime, metadata
           FROM agents WHERE agent_id = $1`,
        [consumerAgentId],
      ).catch(() => ({ rows: [] as any[] }))
      : { rows: [] as any[] }
    const consumerRow = consumer.rows[0] ?? null
    const consumerBinding = consumerAgentId ? await getDiscordUiBindingForAgent(db as any, consumerAgentId) : null
    const consumerDiscordUiId = consumerAgentId ? await getAgentDiscordUiId(db as any, consumerAgentId) : null
    const hasDiscordIdentity = consumerDiscordUiId !== null
    const projectionIdentityId = projection.projectionIdentityId
    const projectionAgent = projectionIdentityId
      ? await db.query(
        `SELECT agent_id, status, runtime, metadata
           FROM agents WHERE agent_id = $1`,
        [projectionIdentityId],
      ).catch(() => ({ rows: [] as any[] }))
      : { rows: [] as any[] }
    const projectionRow = projectionAgent.rows[0] ?? null
    const projectionBinding = projectionIdentityId ? await getDiscordUiBindingForAgent(db as any, projectionIdentityId) : null
    const projectionDiscordUiId = projectionIdentityId ? await getAgentDiscordUiId(db as any, projectionIdentityId) : null
    const projectionHasDiscordIdentity = projectionDiscordUiId !== null
    const delegated = consumerAgentId !== null && consumerAgentId !== fromAgentId
    const report = {
      ok: true,
      surface: {
        provider: projection.platform,
        channel_id: channelId,
        thread_id: threadId,
        external_id: projection.channelExternalId,
      },
      message: {
        from_agent_id: fromAgentId,
        to_agent_ids: toAgentIds,
      },
      resolved: {
        consumer_agent_id: consumerAgentId,
        consumer_source: projection.consumerSource,
        consumer_evidence: projection.consumerEvidence,
        projection_identity_id: projection.projectionIdentityId,
        intended_projection_identity_id: projection.intendedProjectionIdentityId,
        projection_source: projection.projectionSource,
        projection_fallback_reason: projection.projectionFallbackReason,
        delivery_fallback_reason: projection.deliveryFallbackReason,
        delivery_diagnostics: projection.deliveryDiagnostics,
        delegated,
        consumer_discord_identity_present: hasDiscordIdentity,
        consumer_discord_ui_id: consumerDiscordUiId,
        consumer_discord_ui_binding_status: consumerBinding?.status ?? null,
        projection_discord_identity_present: projectionHasDiscordIdentity,
        projection_discord_ui_id: projectionDiscordUiId,
        projection_discord_ui_binding_status: projectionBinding?.status ?? null,
        consumer_status: consumerRow?.status ?? null,
        consumer_runtime: consumerRow?.runtime ?? null,
        projection_status: projectionRow?.status ?? null,
        projection_runtime: projectionRow?.runtime ?? null,
      },
      preview: consumerAgentId
        ? delegated
          ? `[${fromAgentId} -> ${toAgentIds.join(',')}]\n本文...`
          : '本文...'
        : null,
    }

    if (format === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    const lines = [
      'Projection Preview',
      '',
      `Surface:  ${projection.platform} channel=${channelId}${threadId ? ` thread=${threadId}` : ''}`,
      `External: ${projection.channelExternalId ?? '(none)'}`,
      '',
      `From:     ${fromAgentId}`,
      `To:       ${toAgentIds.join(', ')}`,
      '',
      `Consumer: ${consumerAgentId ?? '(none)'}`,
      `Identity: ${projection.projectionIdentityId ?? '(none)'}`,
      `Intended: ${projection.intendedProjectionIdentityId ?? '(none)'}`,
      `Consumer source:   ${projection.consumerSource}`,
      `Consumer evidence: ${projection.consumerEvidence ? `${projection.consumerEvidence.source_table} connector=${projection.consumerEvidence.connector_instance_id}${projection.consumerEvidence.channel_binding_id ? ` binding=${projection.consumerEvidence.channel_binding_id}` : ''}${projection.consumerEvidence.provider_channel_access_id ? ` access=${projection.consumerEvidence.provider_channel_access_id}` : ''}` : '(none)'}`,
      `Projection source: ${projection.projectionSource}`,
      `Fallback reason:   ${projection.projectionFallbackReason ?? '(none)'}`,
      `Delivery fallback: ${projection.deliveryFallbackReason ?? '(none)'}`,
      `Delivery diagnostics: ${projection.deliveryDiagnostics.length > 0 ? JSON.stringify(projection.deliveryDiagnostics) : '(none)'}`,
      `Consumer Discord:  ${hasDiscordIdentity ? `ui_id=${consumerDiscordUiId}${consumerBinding?.status ? ` (${consumerBinding.status})` : ''}` : 'no UI identity detected'}`,
      `Projection Discord: ${projectionHasDiscordIdentity ? `ui_id=${projectionDiscordUiId}${projectionBinding?.status ? ` (${projectionBinding.status})` : ''}` : 'no UI identity detected'}`,
      `Consumer status:   ${consumerRow?.status ?? '(unknown)'}${consumerRow?.runtime ? ` / ${consumerRow.runtime}` : ''}`,
      `Projection status: ${projectionRow?.status ?? '(unknown)'}${projectionRow?.runtime ? ` / ${projectionRow.runtime}` : ''}`,
      '',
      'Discord will show:',
      report.preview ?? '(not projected)',
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
  } finally {
    await db.end()
  }
}

async function diagnoseQueue(args: string[]) {
  const { flags } = parseArgs(args)
  const agentId = flags['agent-id'] ?? null
  const staleMinutes = Number.parseInt(flags['stale-minutes'] ?? '15', 10)
  const staleSeconds = Number.isFinite(staleMinutes) && staleMinutes >= 0 ? staleMinutes * 60 : 15 * 60
  const format = flags.format ?? 'json'
  const db = await getDb()

  try {
    const report = await buildQueueDoctorReport(db as any, { agentId, staleSeconds })

    if (format === 'text') {
      process.stdout.write(formatQueueDoctorText(report))
      return
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await db.end()
  }
}

async function preflightQueue(args: string[]) {
  const { flags } = parseArgs(args)
  const agentId = flags['agent-id'] ?? null
  const staleMinutes = Number.parseInt(flags['stale-minutes'] ?? '15', 10)
  const staleSeconds = Number.isFinite(staleMinutes) && staleMinutes >= 0 ? staleMinutes * 60 : 15 * 60
  const format = flags.format ?? 'json'
  const gate = flags.gate ?? 'all'
  if (!['all', 'runtime', 'projection'].includes(gate)) {
    console.error('Usage: agent-com queue preflight [--gate all|runtime|projection] [--agent-id <id>] [--stale-minutes 15] [--format json|text]')
    process.exit(2)
  }
  const db = await getDb()

  try {
    const report = await buildQueueDoctorReport(db as any, { agentId, staleSeconds })
    const gateBlockerCodes = gate === 'runtime'
      ? new Set([
        'stale_pending',
        'active_claim_missing_owner',
        'expired_active_claim',
        'retired_or_offline_recipient',
        'tui_without_tmux_session',
        'loop_prompt_backlog',
      ])
      : gate === 'projection'
        ? new Set(['outbound_pending_stale'])
        : null
    const failedBlockers = gateBlockerCodes
      ? report.blockers.filter((item) => item.severity === 'blocker' && gateBlockerCodes.has(item.code) && item.count > 0)
      : report.blockers.filter((item) => item.severity === 'blocker' && item.count > 0)
    const preflight = {
      ok: failedBlockers.length === 0,
      gate,
      failed_blocker_count: failedBlockers.length,
      failed_blocker_codes: failedBlockers.map((item) => item.code),
    }

    if (format === 'text') {
      process.stdout.write(formatQueueDoctorText(report))
      process.stdout.write(`Preflight(${gate}): ${preflight.ok ? 'ok' : `blocked (${preflight.failed_blocker_count}: ${preflight.failed_blocker_codes.join(', ')})`}\n`)
    } else {
      process.stdout.write(`${JSON.stringify({ ...report, preflight }, null, 2)}\n`)
    }

    if (!preflight.ok) {
      process.exitCode = 1
    }
  } finally {
    await db.end()
  }
}

async function repairQueue(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  if (subcommand === 'normalize' && hasFlag(flags, 'execute')) {
    console.error('Error: queue normalize is read-only; run the reported repair command with --execute after review')
    process.exit(2)
  }
  const dryRun = parseRepairDryRun(flags)
  const db = await getDb()

  try {
    if (subcommand === 'normalize') {
      const agentId = flags['agent-id'] ?? null
      const staleMinutes = Number.parseInt(flags['stale-minutes'] ?? '15', 10)
      const staleSeconds = Number.isFinite(staleMinutes) && staleMinutes >= 0 ? staleMinutes * 60 : 15 * 60
      const format = flags.format ?? 'json'
      const report = await buildQueueNormalizationReport(db as any, { agentId, staleSeconds })
      if (format === 'text') {
        process.stdout.write(formatQueueNormalizationText(report))
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      }
      return
    }

    if (subcommand === 'reassign') {
      const fromAgentId = flags.from
      const toAgentId = flags.to
      if (!fromAgentId || !toAgentId) {
        console.error('Usage: agent-com queue reassign --from <agent> --to <agent> [--execute|--dry-run]')
        process.exit(2)
      }
      const report = await reassignPendingQueueRows(db as any, { fromAgentId, toAgentId, dryRun })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    if (subcommand === 'close-obsolete') {
      const agentId = flags['agent-id']
      const reason = flags.reason
      if (!agentId || !reason) {
        console.error('Usage: agent-com queue close-obsolete --agent-id <agent> --reason <text> [--queue-id <id>] [--include-active] [--execute|--dry-run]')
        process.exit(2)
      }
      const report = await closeObsoletePendingQueueRows(db as any, {
        agentId,
        reason,
        queueId: flags['queue-id'] ?? null,
        includeActive: flagEnabled(flags['include-active']),
        dryRun,
      })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    if (subcommand === 'reclaim-expired') {
      const report = await reclaimExpiredQueueClaims(db as any, { agentId: flags['agent-id'] ?? null, dryRun })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    console.error('Usage: agent-com queue <doctor|preflight|normalize|reassign|close-obsolete|reclaim-expired> ...')
    process.exit(2)
  } finally {
    await db.end()
  }
}

/**
 * `agent-com agents` — list registered agents as JSON.
 * MVP: no filters; reads the agents table verbatim.
 */
async function listAgents() {
  const db = await getDb()
  try {
    const r = await db.query(
      `SELECT agent_id, display_name, agent_type, runtime, status, channel_port, registered_at,
              home_directory, runtime_engine_preference, provider_token_source_ref,
              expected_provider_identity, profile_enabled, profile_revision, profile_source
       FROM agents
       ORDER BY agent_id`,
    )
    process.stdout.write(JSON.stringify(r.rows.map((row: any) => ({
      ...row,
      expected_provider_identity: parseJsonObject(row.expected_provider_identity),
      profile_enabled: row.profile_enabled === true || row.profile_enabled === 1 || row.profile_enabled === '1',
    })), null, 2) + '\n')
  } finally {
    await db.end()
  }
}

async function directory(args: string[]) {
  const { flags } = parseArgs(args)
  const format = flags.format ?? 'json'
  const db = await getDb()
  try {
    const report = await buildDirectoryReport(db as any)
    if (format === 'text') {
      process.stdout.write(formatDirectoryText(report))
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } finally {
    await db.end()
  }
}

async function runtimeCommand(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  if (subcommand !== 'inventory' && subcommand !== 'cleanup') {
    console.error('Usage: agent-com runtime <inventory|cleanup> ...')
    process.exit(2)
  }
  const format = flags.format ?? 'json'
  const staleMinutes = parsePositiveIntFlag(flags['stale-minutes'], 15, 'stale-minutes')
  const db = await getDb()
  try {
    if (subcommand === 'inventory') {
      const report = await buildRuntimeInventoryReport((db as any).__adapter, {
        staleMinutes,
        expectedCommit: flags['expected-commit'] ?? null,
        provider: flags.provider ?? 'discord',
        bindingRole: flags['binding-role'] ?? 'outbound',
      })
      if (format === 'text') {
        process.stdout.write(formatRuntimeInventoryText(report))
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      }
      return
    }

    const dryRun = parseRepairDryRun(flags)
    const snapshots = collectRuntimeCleanupSnapshots()
    const includeDisabledProfiles = hasFlag(flags, 'include-disabled') && flagEnabled(flags['include-disabled'])
    const includeTestProfiles = hasFlag(flags, 'include-test') && flagEnabled(flags['include-test'])
    const commonOptions = {
      staleMinutes,
      includeDisabledProfiles,
      includeTestProfiles,
      tmuxPanes: snapshots.tmuxPanes,
      portListeners: snapshots.portListeners,
    }
    const report = dryRun
      ? await buildRuntimeCleanupReport((db as any).__adapter, commonOptions, true)
      : await executeRuntimeCleanup((db as any).__adapter, {
        ...commonOptions,
        confirmHash: flags.confirm ?? '',
        allowUnknownRisk: hasFlag(flags, 'allow-unknown-risk') && flagEnabled(flags['allow-unknown-risk']),
        killProcess: async (pid) => {
          process.kill(pid, 'SIGTERM')
        },
        killTmuxSession: async (session) => {
          execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
        },
      })
    if (format === 'text') {
      process.stdout.write(formatRuntimeCleanupText(report))
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exitCode = 1
  } finally {
    await db.end()
  }
}

function collectRuntimeCleanupSnapshots() {
  let tmuxPanes: ReturnType<typeof parseTmuxListPanes> = []
  let portListeners: ReturnType<typeof parseLsofTcpListeners> = []
  try {
    const tmuxOutput = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_current_path}'], {
      encoding: 'utf8',
    })
    tmuxPanes = parseTmuxListPanes(tmuxOutput)
  } catch {}
  try {
    const lsofOutput = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
    portListeners = parseLsofTcpListeners(lsofOutput)
  } catch {}
  return { tmuxPanes, portListeners }
}

async function inboundCommand(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  if (subcommand !== 'smoke') {
    console.error('Usage: agent-com inbound smoke [--format json|text] [--window-hours 168] [--provider discord] [--binding-role outbound|any]')
    process.exit(2)
  }
  const format = flags.format ?? 'json'
  const windowHours = parsePositiveIntFlag(flags['window-hours'], 168, 'window-hours')
  const bindingRole = flags['binding-role'] === 'any' ? null : (flags['binding-role'] ?? null)
  const db = await getDb()
  try {
    const report = await buildInboundSmokeReport((db as any).__adapter, {
      windowHours,
      provider: flags.provider ?? 'discord',
      bindingRole,
    })
    if (format === 'text') {
      process.stdout.write(formatInboundSmokeText(report))
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } finally {
    await db.end()
  }
}

async function fleetCommand(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  if (subcommand !== 'readiness') {
    console.error('Usage: agent-com fleet readiness [--format json|text] [--denylist <a,b>] [--smoke-run-id <id>] [--operator-agent-id codex-aun] [--require-smoke] [--include-disabled] [--include-test]')
    process.exit(2)
  }
  const format = flags.format ?? 'json'
  const db = await getDb()
  try {
    const report = await buildAunFleetReadinessReport((db as any).__adapter, {
      denylist: parseCsvFlag(flags.denylist ?? process.env.STATE_DAEMON_AGENT_DENYLIST ?? undefined) ?? [],
      smokeRunId: flags['smoke-run-id'] ?? null,
      requireSmoke: hasFlag(flags, 'require-smoke') ? flagEnabled(flags['require-smoke']) : undefined,
      operatorAgentId: flags['operator-agent-id'] ?? 'codex-aun',
      includeDisabledProfiles: hasFlag(flags, 'include-disabled') && flagEnabled(flags['include-disabled']),
      includeTestProfiles: hasFlag(flags, 'include-test') && flagEnabled(flags['include-test']),
    })
    if (format === 'text') {
      process.stdout.write(formatAunFleetReadinessText(report))
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } finally {
    await db.end()
  }
}

async function smokeCommand(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  if (subcommand !== 'run' && subcommand !== 'queue-wake') {
    console.error('Usage: agent-com smoke <run|queue-wake> ...')
    process.exit(2)
  }
  const format = flags.format ?? 'json'
  if (subcommand === 'queue-wake') {
    const timeoutMs = parsePositiveIntFlag(flags['timeout-ms'], 15000, 'timeout-ms')
    const pollMs = parsePositiveIntFlag(flags['poll-ms'], 500, 'poll-ms')
    const mode = hasFlag(flags, 'execute') && flagEnabled(flags['execute']) ? 'execute' : 'dry_run'
    const db = await getDb()
    try {
      const report = await buildQueueWakeSmokeReport((db as any).__adapter, {
        agentId: flags['agent-id'] ?? null,
        mode,
        confirmPlanHash: flags.confirm ?? null,
        timeoutMs,
        pollMs,
        denylist: parseCsvFlag(flags.denylist ?? process.env.STATE_DAEMON_AGENT_DENYLIST ?? undefined) ?? [],
      })
      if (format === 'text') {
        process.stdout.write(formatQueueWakeSmokeText(report))
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      }
      if (!report.ok) process.exitCode = report.error === 'OPERATOR_APPROVAL_REQUIRED' ? 2 : 1
    } finally {
      await db.end()
    }
    return
  }

  const windowHours = parsePositiveIntFlag(flags['window-hours'], 168, 'window-hours')
  const timeoutMs = parsePositiveIntFlag(flags['timeout-ms'], 30000, 'timeout-ms')
  // dry-run/plan is the default and read-only; execute is opt-in and gated by --confirm.
  const mode = hasFlag(flags, 'execute') && flagEnabled(flags['execute']) ? 'execute' : 'dry_run'
  const db = await getDb()
  try {
    const report = await buildFullChannelSmokeReport((db as any).__adapter, {
      provider: flags.provider ?? 'discord',
      windowHours,
      externalChannelId: flags.channel ?? flags['external-channel-id'] ?? null,
      includeDisabled: hasFlag(flags, 'include-disabled') ? flagEnabled(flags['include-disabled']) : false,
      includeTest: hasFlag(flags, 'include-test') ? flagEnabled(flags['include-test']) : false,
      mode,
      confirmPlanHash: flags.confirm ?? null,
      timeoutMs,
    })
    if (format === 'text') {
      process.stdout.write(formatFullChannelSmokeText(report))
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
    if (!report.ok || report.summary.blocked > 0 || report.summary.failure_count > 0) process.exitCode = 2
  } finally {
    await db.end()
  }
}

/**
 * `agent-com status` — system or per-agent status (v1.0.2 §6.5).
 *
 * When AGENT_ID is set: per-agent mode → `{ agent_id, pending, status, last_seen_at }`
 * When no AGENT_ID: system-wide → channels / agents / messages summary
 * `--format json` → single-line JSON (for polling-driver / scripting)
 */
async function status(args: string[]) {
  const { flags } = parseArgs(args)
  const format = flags.format ?? 'text'
  // --agent-id or AGENT_ID gives per-agent status and must pass the runtime
  // identity lock. Omitting both is the only system-wide status path.
  const agentId = (flags['agent-id'] || process.env.AGENT_ID)
    ? resolveAgentId(args, 'status')
    : null

  const db = await getDb()
  try {
    if (agentId) {
      const pending = await db.query(
        `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
        [agentId],
      )
      const agent = await db.query(
        `SELECT status, last_seen_at FROM agents WHERE agent_id = $1`,
        [agentId],
      )
      // Issue #278 (A) segment 3d — agents.current_message_id is gone.
      // The "in-flight claim" view is now the most-recent active per-row
      // claim from message_queue.
      const claim = await db.query(
        `SELECT id::text AS id FROM message_queue
            WHERE claimed_by = $1 AND status = 'received'
            ORDER BY claimed_at DESC NULLS LAST
            LIMIT 1`,
        [agentId],
      )
      const workerActivity = await db.query(
        `SELECT wa.*,
                mq.status AS queue_status,
                mq.message_id AS message_id,
                ari.status AS runtime_status,
                ari.last_seen_at AS runtime_last_seen_at
           FROM worker_activity wa
           LEFT JOIN message_queue mq ON mq.id = wa.queue_id
           LEFT JOIN agent_runtime_instances ari ON ari.runtime_instance_id = wa.runtime_instance_id
          WHERE wa.agent_id = $1
            AND wa.status IN ('planned', 'running', 'blocked', 'stalled')
          ORDER BY wa.updated_at DESC
          LIMIT 1`,
        [agentId],
      ).catch(() => ({ rows: [] as any[] }))
      const row = agent.rows[0]
      const result = {
        agent_id: agentId,
        pending: pending.rows[0]?.n ?? 0,
        status: row?.status ?? 'unknown',
        last_seen_at: row?.last_seen_at ?? null,
        current_message_id: claim.rows[0]?.id ?? null,
        worker_activity: workerActivity.rows[0] ? normalizeWorkerActivity(workerActivity.rows[0]) : null,
      }
      if (format === 'json') {
        process.stdout.write(JSON.stringify(result) + '\n')
      } else {
        console.log(`Agent: ${agentId}`)
        console.log(`Status: ${result.status}`)
        console.log(`Pending: ${result.pending}`)
        console.log(`Last seen: ${result.last_seen_at ?? 'never'}`)
        console.log(`Current message: ${result.current_message_id ?? 'none'}`)
      }
    } else {
      // #530 — system-wide status. Two output modes:
      //   --brief  → legacy minimal summary (kept for backward compat /
      //              scripting callers that depend on the pre-#530 shape).
      //   default  → rich tables: agents (one row per active agent_id) and
      //              queue summary (pending/received/in_progress per agent
      //              with oldest-row age). Drift warnings (retired agents
      //              still receiving queue rows, etc.) follow the tables.
      // --format json → extended schema (additive over the brief shape).
      const chCount = await db.query('SELECT COUNT(*) as cnt FROM channels')
      const agOnline = await db.query("SELECT COUNT(*) as cnt FROM agents WHERE status = 'online'")
      const agTotal = await db.query('SELECT COUNT(*) as cnt FROM agents')
      const msgRecent = await db.query("SELECT COUNT(*) as cnt FROM agent_messages WHERE created_at > now() - interval '1 hour'")
      const brief = hasFlag(flags, 'brief')

      if (brief && format !== 'json') {
        console.log('=== agent-com status ===')
        console.log(`DB: connected`)
        console.log(`Channels: ${chCount.rows[0].cnt}`)
        console.log(`Agents: ${agOnline.rows[0].cnt} online / ${agTotal.rows[0].cnt} total`)
        console.log(`Messages (1h): ${msgRecent.rows[0].cnt}`)
        return
      }

      // Detailed view (also feeds JSON output) — keep the query set small
      // and DB-only so this command stays a pure observability tool.
      // `metadata->>'…'` is a PG operator that the SQLite adapter rewrites
      // to `json_extract(metadata, '$.…')`. Avoid `a.metadata->>…` because
      // the adapter regex captures only the bare column name, leaving
      // `a.` orphaned in front of the rewritten function call. Plain
      // `metadata->>…` is unambiguous since `agents` is the sole FROM table.
      const agentsRes = await db.query(
        `SELECT agent_id,
                agent_type,
                runtime,
                status,
                display_name,
                home_directory,
                last_seen_at,
                metadata->>'discord_id' AS discord_id,
                metadata->>'tmux_session' AS tmux_session,
                metadata->>'discord_username' AS discord_username_cached,
                metadata->>'retired' AS retired_raw
           FROM agents
          WHERE disabled_at IS NULL
          ORDER BY (status = 'busy') DESC,
                   (status = 'idle') DESC,
                   agent_id`,
      )

      // Per-agent live runtime workspace lookup. Pulled from
      // agent_runtime_instances so the value reflects the *actually
      // running* checkout, not a stale metadata field. SQLite tests use
      // bun:sqlite which has had this table since the NORM-020
      // migration, but the column set is small so we tolerate an empty
      // result silently.
      const workspaceRes = await db.query(
        `SELECT agent_id, checkout_path
           FROM agent_runtime_instances
          WHERE status = 'running' AND checkout_path IS NOT NULL`,
      ).catch(() => ({ rows: [] as any[] }))
      const workspaceByAgent = new Map<string, string>()
      for (const r of workspaceRes.rows) {
        // If two runtimes share an agent_id (shouldn't happen, but
        // codex-aun lane is still normalising), prefer the first seen.
        if (!workspaceByAgent.has(r.agent_id)) workspaceByAgent.set(r.agent_id, r.checkout_path)
      }

      // Per CEO 2026-05-24 directive (msg `7d778234`): the live Discord
      // API resolution path is removed. codex-aun lane (NORM-020) owns
      // the per-bot connector/runtime identity work that will persist
      // discord_username into the agents row at heartbeat time. The
      // status CLI conforms to that spec once it lands. Until then,
      // fall through to metadata.discord_username (read-only consumer)
      // → display_name → placeholder.

      // 起動ディレクトリ (launch directory) is the bot profile SSOT
      // (`agents.home_directory`). It is distinct from runtime workspace
      // (= what the process is actually executing inside).
      const queueRes = await db.query(
        `SELECT agent_id,
                status,
                COUNT(*)::int AS n,
                MIN(created_at) AS oldest
           FROM message_queue
          WHERE status IN ('pending','received','in_progress')
          GROUP BY agent_id, status
          ORDER BY agent_id, status`,
      )

      // Pivot queue rows into per-agent { pending, received, in_progress, oldest }.
      type QueueAgg = { pending: number; received: number; in_progress: number; oldest: string | null }
      const queueByAgent = new Map<string, QueueAgg>()
      for (const r of queueRes.rows) {
        const agg = queueByAgent.get(r.agent_id) ?? { pending: 0, received: 0, in_progress: 0, oldest: null }
        ;(agg as any)[r.status] = parseInt(r.n)
        if (agg.oldest == null || (r.oldest && new Date(r.oldest) < new Date(agg.oldest))) {
          agg.oldest = r.oldest
        }
        queueByAgent.set(r.agent_id, agg)
      }

      const workerActivityRes = await db.query(
        `SELECT wa.*
           FROM worker_activity wa
          WHERE wa.status IN ('planned', 'running', 'blocked', 'stalled')
          ORDER BY wa.updated_at DESC
          LIMIT 500`,
      ).catch(() => ({ rows: [] as any[] }))
      const workerActivityByAgent = new Map<string, Record<string, unknown>>()
      for (const row of workerActivityRes.rows) {
        if (!workerActivityByAgent.has(row.agent_id)) {
          workerActivityByAgent.set(row.agent_id, normalizeWorkerActivity(row))
        }
      }

      // Drift warnings — pure DB findings, no shell-out. Each entry is a
      // short string the operator can paste into a follow-up issue.
      const drifts: string[] = []
      for (const a of agentsRes.rows) {
        const q = queueByAgent.get(a.agent_id)
        const retired = a.retired_raw === true || a.retired_raw === 'true' || a.retired_raw === 1
        if (retired && q && (q.pending + q.received + q.in_progress) > 0) {
          drifts.push(`retired agent '${a.agent_id}' still has ${q.pending + q.received + q.in_progress} queued rows`)
        }
        if (a.agent_type === 'human' && q && (q.pending + q.received + q.in_progress) > 0) {
          drifts.push(`human agent '${a.agent_id}' has ${q.pending + q.received + q.in_progress} queued rows — PR #533 fix should have prevented this; check fleet runtime build`)
        }
        if (a.runtime === 'TUI' && (!a.tmux_session || a.tmux_session === '')) {
          drifts.push(`agent '${a.agent_id}' runtime=TUI but metadata.tmux_session is missing`)
        }
      }

      if (format === 'json') {
        process.stdout.write(JSON.stringify({
          channels: parseInt(chCount.rows[0].cnt),
          agents_online: parseInt(agOnline.rows[0].cnt),
          agents_total: parseInt(agTotal.rows[0].cnt),
          messages_1h: parseInt(msgRecent.rows[0].cnt),
          agents: agentsRes.rows.map(a => ({
            // Resolution order for the human-facing bot name:
            //   1. agents.metadata.discord_username (cached — populated
            //      by a future writer in the codex-aun NORM-020 lane)
            //   2. agents.display_name (DB row; drifted on legacy rows)
            //   3. null
            // The chain is exposed individually in JSON so dashboards
            // can prefer the source they trust.
            agent_id: a.agent_id,
            agent_type: a.agent_type,
            runtime: a.runtime,
            status: a.status,
            display_name: a.display_name ?? null,
            last_seen_at: a.last_seen_at,
            discord_id: a.discord_id ?? null,
            discord_username_cached: a.discord_username_cached ?? null,
            tmux_session: a.tmux_session ?? null,
            launch_dir: a.home_directory ?? null,
            workspace: workspaceByAgent.get(a.agent_id) ?? null,
            retired: a.retired_raw === true || a.retired_raw === 'true' || a.retired_raw === 1,
            queue: queueByAgent.get(a.agent_id) ?? { pending: 0, received: 0, in_progress: 0, oldest: null },
            worker_activity: workerActivityByAgent.get(a.agent_id) ?? null,
          })),
          drifts,
        }) + '\n')
        return
      }

      console.log('=== agent-com status ===')
      console.log(`DB: connected`)
      console.log(`Channels: ${chCount.rows[0].cnt} · Agents: ${agOnline.rows[0].cnt} online / ${agTotal.rows[0].cnt} total · Messages (1h): ${msgRecent.rows[0].cnt}`)
      console.log('')
      console.log('--- agents (active, non-disabled) ---')
      console.log(
        'agent_id'.padEnd(20) +
        'discord_id'.padEnd(22) +
        'status'.padEnd(10) +
        'pend/recv/inflight'.padEnd(20) +
        'launch_dir'.padEnd(36) +
        'last_seen',
      )
      // `launch_dir` is the bot profile home directory, distinct from
      // the runtime workspace (= what the process is actually executing
      // inside). Both are exposed in --format json under `launch_dir`
      // and `workspace` respectively so dashboards can compare them.
      const HOME = process.env.HOME ?? ''
      const shrinkHome = (p: string) => (HOME && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p)
      for (const a of agentsRes.rows) {
        const q = queueByAgent.get(a.agent_id) ?? { pending: 0, received: 0, in_progress: 0, oldest: null }
        const qStr = `${q.pending}/${q.received}/${q.in_progress}`
        const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).toISOString().replace('T', ' ').slice(0, 19) : 'never'
        const retiredText = a.retired_raw === true || a.retired_raw === 'true' || a.retired_raw === 1
        const statusStr = retiredText ? `${a.status}*ret` : a.status
        // Per CEO 2026-05-24 directive (msg `768a62b7`): show the
        // raw discord_id only — name resolution is codex-aun lane
        // (NORM-020). JSON still exposes display_name and
        // discord_username_cached for dashboards.
        const discordId = a.discord_id ?? '-'
        const launchRaw = a.home_directory
        const launch = launchRaw ? shrinkHome(launchRaw) : '-'
        console.log(
          a.agent_id.padEnd(20) +
          discordId.padEnd(22) +
          (statusStr ?? '?').padEnd(10) +
          qStr.padEnd(20) +
          launch.padEnd(36) +
          lastSeen,
        )
      }
      if (drifts.length > 0) {
        console.log('')
        console.log(`--- drift warnings (${drifts.length}) ---`)
        for (const d of drifts) console.log(`! ${d}`)
      } else {
        console.log('')
        console.log('--- drift warnings: none ---')
      }
    }
  } finally {
    await db.end()
  }
}

/**
 * `agent-com heartbeat [--agent-id <id>]` — update agents.last_seen_at + disconnected→idle (v1.0.2 §4.5 / §6.5).
 */
async function heartbeat(args: string[]) {
  const agentId = resolveAgentId(args, 'heartbeat')
  const { flags } = parseArgs(args)
  const runtimeInstanceId = flags['runtime-instance-id'] ?? process.env.AGENT_COM_RUNTIME_INSTANCE_ID ?? null
  const discordToken = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || ''
  const discordTokenFingerprint = discordToken.trim()
    ? createHash('sha256').update(discordToken.trim()).digest('hex')
    : null
  const db = await getDb()
  try {
    // ARC codex audit (PR#139): spec requires disconnected→idle recovery on heartbeat.
    await db.query(
      `UPDATE agents SET last_seen_at = now(),
       status = CASE WHEN status = 'disconnected' THEN 'idle' ELSE status END
       WHERE agent_id = $1`,
      [agentId],
    )
    const runtime = runtimeInstanceId
      ? await heartbeatRuntimeInstance(db as any, {
          runtimeInstanceId,
          agentId,
          runtimeEngine: flags['runtime-engine'] ?? process.env.AGENT_COM_RUNTIME_ENGINE ?? process.env.AGENT_COM_RUNTIME ?? 'unknown',
          runtimeKind: flags['runtime-kind'] ?? process.env.AGENT_COM_RUNTIME_KIND ?? 'local_process',
          sessionName: flags['session-name'] ?? inferRuntimeSessionName(),
          processId: process.env.AGENT_COM_RUNTIME_PROCESS_ID ? Number.parseInt(process.env.AGENT_COM_RUNTIME_PROCESS_ID, 10) : null,
          port: parseRuntimePort(),
          checkoutPath: process.env.AGENT_COM_CHECKOUT_PATH ?? process.cwd(),
          commitSha: process.env.AGENT_COM_COMMIT_SHA ?? null,
          endpointUri: process.env.AGENT_COM_ENDPOINT_URI ?? null,
          connectorProvider: discordTokenFingerprint ? 'discord' : null,
          connectorUri: discordTokenFingerprint ? `discord://agents/${agentId}` : null,
          connectorKind: discordTokenFingerprint ? 'chat_adapter' : null,
          connectorTransport: discordTokenFingerprint ? 'discord_gateway' : null,
          metadata: { source: 'agent-com heartbeat' },
          connectorMetadata: discordTokenFingerprint
            ? {
                token_fingerprint: discordTokenFingerprint,
                token_source: process.env.DISCORD_TOKEN ? 'DISCORD_TOKEN' : 'DISCORD_BOT_TOKEN',
              }
            : undefined,
        })
      : null
    process.stdout.write(JSON.stringify({
      ok: true,
      agent_id: agentId,
      last_seen_at: new Date().toISOString(),
      runtime_instance_id: runtime?.runtime_instance_id ?? null,
      runtime_workspace_id: runtime?.workspace_id ?? null,
      runtime_connector_rows_upserted: runtime?.connector_rows_upserted ?? 0,
      runtime_connector_rows_updated: runtime?.connector_rows_updated ?? 0,
    }) + '\n')
  } finally {
    await db.end()
  }
}

/**
 * `agent-com daemon` — long-running polling driver for MCP-unsupported envs
 * (v1.0.2 §6.5). Runs heartbeat + poll loop, prints pending messages to
 * stdout when they arrive. Designed for tmux sessions where the operator
 * reads stdout and manually calls `next`.
 *
 * Usage: agent-com daemon --agent-id <id> [--poll-interval 3000]
 */
async function daemon(args: string[]) {
  const agentId = resolveAgentId(args, 'daemon')
  const { flags } = parseArgs(args)
  const pollInterval = parseInt(flags['poll-interval'] ?? '3000', 10)
  const heartbeatInterval = 30_000

  console.error(`[daemon] Started for ${agentId}, poll=${pollInterval}ms, heartbeat=${heartbeatInterval}ms`)
  console.error(`[daemon] Press Ctrl+C to stop`)

  // Heartbeat timer
  setInterval(async () => {
    const db = await getDb()
    try {
      await db.query(
        `UPDATE agents SET last_seen_at = now(),
         status = CASE WHEN status = 'disconnected' THEN 'idle' ELSE status END
         WHERE agent_id = $1`,
        [agentId],
      )
    } catch (err) {
      console.error(`[daemon] heartbeat error: ${err}`)
    } finally {
      await db.end()
    }
  }, heartbeatInterval)

  // Poll timer
  const poll = async () => {
    const db = await getDb()
    try {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
        [agentId],
      )
      const pending: number = r.rows[0]?.n ?? 0
      if (pending > 0) {
        // Output a notification line so tmux watchers / piped consumers can act.
        process.stdout.write(JSON.stringify({
          event: 'pending',
          agent_id: agentId,
          pending,
          ts: new Date().toISOString(),
          hint: `Run 'AGENT_ID=${agentId} agent-com next' to process`,
        }) + '\n')
      }
    } catch (err) {
      console.error(`[daemon] poll error: ${err}`)
    } finally {
      await db.end()
    }
  }

  // Initial poll + start interval
  await poll()
  setInterval(poll, pollInterval)

  // Keep the process alive
  await new Promise(() => {})
}

function resolveLeaseHolderAgentId(args: string[], flags: Record<string, string>, required: boolean): string | undefined {
  if (flags['holder-agent-id']) return assertExpectedAgentId(flags['holder-agent-id'], 'lease')
  if (flags['agent-id'] || process.env.AGENT_ID) return resolveAgentId(args, 'lease')
  if (required) {
    console.error('Error: --holder-agent-id, --agent-id, or AGENT_ID is required for lease mutation')
    process.exit(2)
  }
  return undefined
}

function parseLeaseTtlMs(flags: Record<string, string>): number {
  if (flags['ttl-ms']) return parsePositiveIntFlag(flags['ttl-ms'], 30_000, 'ttl-ms')
  return parsePositiveIntFlag(flags['ttl-sec'], 30, 'ttl-sec') * 1000
}

function parseLeaseMetadata(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  console.error('Error: --metadata must be a JSON object')
  process.exit(2)
}

function requireLeaseFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]
  if (!value) {
    console.error(`Error: --${name} is required`)
    process.exit(2)
  }
  return value
}

const LEASE_SCOPE_TYPES = new Set(['connector_instance', 'channel_binding', 'queue_partition', 'runtime_instance'])
const LEASE_PURPOSES = new Set(['inbound', 'outbound', 'worker', 'leader', 'presence', 'maintenance'])
const WORKER_ACTIVITY_STATUSES = new Set(['planned', 'running', 'blocked', 'stalled', 'failed', 'completed', 'handoff'])

function optionalWorkerText(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function requireWorkerFlag(flags: Record<string, string>, name: string): string {
  const value = optionalWorkerText(flags[name])
  if (!value) {
    console.error(`Error: --${name} is required`)
    process.exit(2)
  }
  return value
}

function parseWorkerActivityStatus(value: string | undefined): string {
  const status = value?.trim() || 'running'
  if (!WORKER_ACTIVITY_STATUSES.has(status)) {
    console.error(`Error: --status must be one of ${Array.from(WORKER_ACTIVITY_STATUSES).join(', ')}`)
    process.exit(2)
  }
  return status
}

function parseOptionalPositiveIntFlag(value: string | undefined, name: string): number | null {
  if (value === undefined) return null
  return parsePositiveIntFlag(value, 1, name)
}

function parseWorkerProgressPercent(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    console.error('Error: --progress must be an integer from 0 to 100')
    process.exit(2)
  }
  return parsed
}

function parseWorkerTimestamp(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function normalizeWorkerActivity(row: any): Record<string, unknown> {
  const status = String(row.status)
  const terminal = status === 'completed' || status === 'failed' || status === 'handoff'
  const heartbeatAt = parseWorkerTimestamp(row.heartbeat_at)
  const heartbeatAgeSec = heartbeatAt
    ? Math.max(0, Math.floor((Date.now() - heartbeatAt.getTime()) / 1000))
    : null
  const staleAfterSec = Number(row.stale_after_sec ?? 120)
  const visibilityState = terminal
    ? 'closed'
    : heartbeatAgeSec === null
      ? 'unknown'
      : heartbeatAgeSec > staleAfterSec
        ? 'stale'
        : 'moving'
  return {
    activity_id: row.activity_id,
    agent_id: row.agent_id,
    runtime_instance_id: row.runtime_instance_id ?? null,
    lease_id: row.lease_id ?? null,
    queue_id: row.queue_id === null || row.queue_id === undefined ? null : Number(row.queue_id),
    queue_status: row.queue_status ?? null,
    message_id: row.message_id ?? null,
    activity_type: row.activity_type,
    status: row.status,
    summary: row.summary,
    repository: row.repository ?? null,
    branch: row.branch ?? null,
    pull_request: row.pull_request ?? null,
    artifact_uri: row.artifact_uri ?? null,
    blocked_reason: row.blocked_reason ?? null,
    handoff_target_agent_id: row.handoff_target_agent_id ?? null,
    progress_percent: row.progress_percent === null || row.progress_percent === undefined ? null : Number(row.progress_percent),
    progress_label: row.progress_label ?? null,
    stale_after_sec: staleAfterSec,
    heartbeat_age_sec: heartbeatAgeSec,
    visibility_state: visibilityState,
    runtime_status: row.runtime_status ?? null,
    runtime_last_seen_at: row.runtime_last_seen_at ?? null,
    started_at: row.started_at ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    completed_at: row.completed_at ?? null,
    updated_at: row.updated_at ?? null,
    metadata: parseJsonObject(row.metadata),
  }
}

function formatWorkerActivityText(rows: Record<string, unknown>[]): string {
  const lines = ['=== worker activity ===']
  if (rows.length === 0) {
    lines.push('No worker activity rows found.')
    return `${lines.join('\n')}\n`
  }
  for (const row of rows) {
    const agentId = String(row.agent_id)
    const status = String(row.status)
    const queue = row.queue_id === null ? '-' : `queue=${row.queue_id}`
    const visibility = row.visibility_state ? `state=${row.visibility_state}` : null
    const age = row.heartbeat_age_sec === null ? null : `age=${row.heartbeat_age_sec}s`
    const progress = row.progress_percent === null ? null : `progress=${row.progress_percent}%`
    const label = row.progress_label ? `phase=${row.progress_label}` : null
    const repo = row.repository ? `repo=${row.repository}` : null
    const branch = row.branch ? `branch=${row.branch}` : null
    const pr = row.pull_request ? `pr=${row.pull_request}` : null
    const blocked = row.blocked_reason ? `blocked=${row.blocked_reason}` : null
    const heartbeat = row.heartbeat_at ? `hb=${new Date(String(row.heartbeat_at)).toISOString()}` : 'hb=never'
    lines.push([agentId, status, queue, visibility, age, progress, label, heartbeat].filter(Boolean).join(' '))
    lines.push(`  ${String(row.summary)}`)
    const context = [repo, branch, pr, blocked].filter(Boolean)
    if (context.length > 0) lines.push(`  ${context.join(' ')}`)
  }
  return `${lines.join('\n')}\n`
}

async function workerCommand(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  const db = await getDb()
  try {
    if (subcommand === 'report') {
      const agentId = resolveAgentId(args, 'worker report')
      const activityId = optionalWorkerText(flags['activity-id'])
      const status = parseWorkerActivityStatus(flags.status)
      const summary = requireWorkerFlag(flags, 'summary')
      const metadataObject = parseLeaseMetadata(flags.metadata)
      const queueId = parseOptionalPositiveIntFlag(flags['queue-id'], 'queue-id')
      const handoffTargetAgentId =
        optionalWorkerText(flags['handoff-target']) ?? optionalWorkerText(flags['handoff-target-agent-id'])
      if (handoffTargetAgentId) {
        const handoffDiagnostic = await buildOwnerHandoffDiagnostic(db as any, {
          senderAgentId: agentId,
          intendedRecipientAgentId: handoffTargetAgentId,
          queueId,
          channelId: optionalWorkerText(flags['handoff-channel']) ?? optionalWorkerText(flags.channel),
          githubHandoffUrl:
            optionalWorkerText(flags['github-handoff-url']) ??
            optionalWorkerText(flags['handoff-url']) ??
            optionalWorkerText(flags['pull-request']) ??
            optionalWorkerText(flags.pr),
          metadata: metadataObject,
        })
        if (!handoffDiagnostic.ok) {
          await recordOwnerHandoffDiagnostic(db as any, handoffDiagnostic)
            .catch((err) => process.stderr.write(`agent-com: owner handoff diagnostic audit failed (non-fatal): ${err}\n`))
          const code = ownerHandoffDiagnosticCode(handoffDiagnostic)
          process.stderr.write(`Error [${code}]: ${handoffDiagnostic.reason}\n`)
          process.stderr.write(`${JSON.stringify({ ok: false, code, owner_handoff: handoffDiagnostic }, null, 2)}\n`)
          process.exit(1)
        }
        metadataObject.owner_handoff_evidence = handoffDiagnostic
      }
      const metadata = JSON.stringify(metadataObject)
      const commonValues = [
        agentId,
        optionalWorkerText(flags['runtime-instance-id']),
        optionalWorkerText(flags['lease-id']),
        queueId,
        optionalWorkerText(flags['activity-type']) ?? 'worker',
        status,
        summary,
        optionalWorkerText(flags.repository),
        optionalWorkerText(flags.branch),
        optionalWorkerText(flags['pull-request']) ?? optionalWorkerText(flags.pr),
        optionalWorkerText(flags.artifact) ?? optionalWorkerText(flags['artifact-uri']),
        optionalWorkerText(flags['blocked-reason']),
        handoffTargetAgentId,
        parseWorkerProgressPercent(flags.progress ?? flags['progress-percent']),
        optionalWorkerText(flags['progress-label']) ?? optionalWorkerText(flags.phase),
        parseOptionalPositiveIntFlag(flags['stale-after-sec'], 'stale-after-sec'),
        metadata,
      ]
      const insertColumns = activityId
        ? `activity_id, agent_id, runtime_instance_id, lease_id, queue_id, activity_type, status, summary,
           repository, branch, pull_request, artifact_uri, blocked_reason, handoff_target_agent_id,
           progress_percent, progress_label, stale_after_sec, heartbeat_at, completed_at, updated_at, metadata`
        : `agent_id, runtime_instance_id, lease_id, queue_id, activity_type, status, summary,
           repository, branch, pull_request, artifact_uri, blocked_reason, handoff_target_agent_id,
           progress_percent, progress_label, stale_after_sec, heartbeat_at, completed_at, updated_at, metadata`
      const values = activityId
        ? [
            '$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$10', '$11', '$12', '$13', '$14',
            '$15', '$16', 'COALESCE($17::int, 120)',
            'now()', `CASE WHEN $7 IN ('completed', 'failed', 'handoff') THEN now() ELSE NULL END`, 'now()', 'COALESCE($18::jsonb, \'{}\'::jsonb)',
          ]
        : [
            '$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$10', '$11', '$12', '$13',
            '$14', '$15', 'COALESCE($16::int, 120)',
            'now()', `CASE WHEN $6 IN ('completed', 'failed', 'handoff') THEN now() ELSE NULL END`, 'now()', 'COALESCE($17::jsonb, \'{}\'::jsonb)',
          ]
      const params = activityId ? [activityId, ...commonValues] : commonValues
      const result = await db.query(
        `INSERT INTO worker_activity (${insertColumns})
         VALUES (${values.join(', ')})
         ON CONFLICT (activity_id) DO UPDATE SET
           agent_id = EXCLUDED.agent_id,
           runtime_instance_id = EXCLUDED.runtime_instance_id,
           lease_id = EXCLUDED.lease_id,
           queue_id = EXCLUDED.queue_id,
           activity_type = EXCLUDED.activity_type,
           status = EXCLUDED.status,
           summary = EXCLUDED.summary,
           repository = EXCLUDED.repository,
           branch = EXCLUDED.branch,
           pull_request = EXCLUDED.pull_request,
           artifact_uri = EXCLUDED.artifact_uri,
           blocked_reason = EXCLUDED.blocked_reason,
           handoff_target_agent_id = EXCLUDED.handoff_target_agent_id,
           progress_percent = EXCLUDED.progress_percent,
           progress_label = EXCLUDED.progress_label,
           stale_after_sec = EXCLUDED.stale_after_sec,
           heartbeat_at = now(),
           completed_at = CASE
             WHEN EXCLUDED.status IN ('completed', 'failed', 'handoff') THEN COALESCE(worker_activity.completed_at, now())
             ELSE NULL
           END,
           updated_at = now(),
           metadata = EXCLUDED.metadata
         RETURNING *`,
        params,
      )
      const row = result.rows[0]
      await auditLog(db, 'worker.activity_report', agentId, row?.activity_id ?? activityId, {
        activity_id: row?.activity_id ?? activityId,
        status,
        queue_id: commonValues[3],
        repository: commonValues[7],
        branch: commonValues[8],
        pull_request: commonValues[9],
        handoff_target_agent_id: commonValues[12],
        progress_percent: commonValues[13],
        progress_label: commonValues[14],
        stale_after_sec: commonValues[15],
      }).catch((err) => process.stderr.write(`agent-com: worker activity audit failed (non-fatal): ${err}\n`))
      process.stdout.write(`${JSON.stringify({ ok: true, activity: normalizeWorkerActivity(row) }, null, 2)}\n`)
      return
    }

    if (subcommand === 'ping') {
      const agentId = resolveAgentId(args, 'worker ping')
      const activityId = requireWorkerFlag(flags, 'activity-id')
      const status = parseWorkerActivityStatus(flags.status)
      const summary = optionalWorkerText(flags.summary)
      const progressPercent = parseWorkerProgressPercent(flags.progress ?? flags['progress-percent'])
      const progressLabel = optionalWorkerText(flags['progress-label']) ?? optionalWorkerText(flags.phase)
      const staleAfterSec = parseOptionalPositiveIntFlag(flags['stale-after-sec'], 'stale-after-sec')
      const metadata = flags.metadata ? JSON.stringify(parseLeaseMetadata(flags.metadata)) : null
      const result = await db.query(
        `UPDATE worker_activity
            SET status = $3,
                summary = COALESCE($4, summary),
                progress_percent = COALESCE($5::int, progress_percent),
                progress_label = COALESCE($6, progress_label),
                stale_after_sec = COALESCE($7::int, stale_after_sec),
                heartbeat_at = now(),
                completed_at = CASE
                  WHEN $3 IN ('completed', 'failed', 'handoff') THEN COALESCE(completed_at, now())
                  ELSE NULL
                END,
                updated_at = now(),
                metadata = CASE
                  WHEN $8::text IS NULL THEN metadata
                  ELSE COALESCE($8::jsonb, '{}'::jsonb)
                END
          WHERE activity_id = $1
            AND agent_id = $2
         RETURNING *`,
        [activityId, agentId, status, summary, progressPercent, progressLabel, staleAfterSec, metadata],
      )
      if (result.rows.length === 0) {
        console.error(`Error [WORKER_ACTIVITY_NOT_FOUND]: ${activityId}`)
        process.exit(1)
      }
      const row = result.rows[0]
      await auditLog(db, 'worker.activity_ping', agentId, activityId, {
        activity_id: activityId,
        status,
        progress_percent: progressPercent,
        progress_label: progressLabel,
      }).catch((err) => process.stderr.write(`agent-com: worker activity audit failed (non-fatal): ${err}\n`))
      process.stdout.write(`${JSON.stringify({ ok: true, activity: normalizeWorkerActivity(row) }, null, 2)}\n`)
      return
    }

    if (subcommand === 'list') {
      const format = flags.format ?? 'json'
      const agentId = optionalWorkerText(flags['agent-id'])
      const includeClosed = flagEnabled(flags['include-closed'])
      const limit = parsePositiveIntFlag(flags.limit, 20, 'limit')
      const result = await db.query(
        `SELECT wa.*,
                mq.status AS queue_status,
                mq.message_id AS message_id,
                ari.status AS runtime_status,
                ari.last_seen_at AS runtime_last_seen_at
           FROM worker_activity wa
           LEFT JOIN message_queue mq ON mq.id = wa.queue_id
           LEFT JOIN agent_runtime_instances ari ON ari.runtime_instance_id = wa.runtime_instance_id
          WHERE ($1::text IS NULL OR wa.agent_id = $1)
            AND ($2 OR wa.status IN ('planned', 'running', 'blocked', 'stalled'))
          ORDER BY wa.updated_at DESC
          LIMIT $3`,
        [agentId, includeClosed, limit],
      )
      const activities = result.rows.map(normalizeWorkerActivity)
      if (format === 'text') {
        process.stdout.write(formatWorkerActivityText(activities))
        return
      }
      process.stdout.write(`${JSON.stringify({ ok: true, activities }, null, 2)}\n`)
      return
    }

    console.error('Usage: agent-com worker <report|ping|list> ...')
    process.exit(2)
  } finally {
    await db.end()
  }
}

function parseLeaseScopeType(flags: Record<string, string>): LeaseScopeType {
  const value = requireLeaseFlag(flags, 'scope-type')
  if (!LEASE_SCOPE_TYPES.has(value)) {
    console.error(`Error: --scope-type must be one of ${Array.from(LEASE_SCOPE_TYPES).join(', ')}`)
    process.exit(2)
  }
  return value as LeaseScopeType
}

function parseLeasePurpose(flags: Record<string, string>): LeasePurpose {
  const value = flags.purpose ?? 'worker'
  if (!LEASE_PURPOSES.has(value)) {
    console.error(`Error: --purpose must be one of ${Array.from(LEASE_PURPOSES).join(', ')}`)
    process.exit(2)
  }
  return value as LeasePurpose
}

function parseFencingToken(flags: Record<string, string>): number {
  const raw = requireLeaseFlag(flags, 'fencing-token')
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error('Error: --fencing-token must be a positive integer')
    process.exit(2)
  }
  return parsed
}

async function leaseCommand(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  const db = await getDb()
  const adapter = (db as any).__adapter as DbAdapter
  try {
    if (subcommand === 'acquire') {
      const result = await acquireControlPlaneLease(adapter, {
        scopeType: parseLeaseScopeType(flags),
        scopeId: requireLeaseFlag(flags, 'scope-id'),
        purpose: parseLeasePurpose(flags),
        holderAgentId: resolveLeaseHolderAgentId(args, flags, true),
        holderRuntimeInstanceId: flags['holder-runtime-instance-id'],
        holderConnectorInstanceId: flags['holder-connector-instance-id'],
        ttlMs: parseLeaseTtlMs(flags),
        metadata: parseLeaseMetadata(flags.metadata),
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }

    if (subcommand === 'heartbeat') {
      const result = await heartbeatControlPlaneLease(adapter, {
        leaseId: requireLeaseFlag(flags, 'lease-id'),
        fencingToken: parseFencingToken(flags),
        holderAgentId: resolveLeaseHolderAgentId(args, flags, false),
        holderRuntimeInstanceId: flags['holder-runtime-instance-id'],
        holderConnectorInstanceId: flags['holder-connector-instance-id'],
        ttlMs: parseLeaseTtlMs(flags),
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }

    if (subcommand === 'release') {
      const result = await releaseControlPlaneLease(adapter, {
        leaseId: requireLeaseFlag(flags, 'lease-id'),
        fencingToken: parseFencingToken(flags),
        holderAgentId: resolveLeaseHolderAgentId(args, flags, false),
        holderRuntimeInstanceId: flags['holder-runtime-instance-id'],
        holderConnectorInstanceId: flags['holder-connector-instance-id'],
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }

    if (subcommand === 'verify') {
      const result = await verifyControlPlaneFence(adapter, {
        leaseId: requireLeaseFlag(flags, 'lease-id'),
        fencingToken: parseFencingToken(flags),
        holderAgentId: resolveLeaseHolderAgentId(args, flags, false),
        holderRuntimeInstanceId: flags['holder-runtime-instance-id'],
        holderConnectorInstanceId: flags['holder-connector-instance-id'],
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }

    console.error('Usage: agent-com lease <acquire|heartbeat|release|verify> ...')
    process.exit(2)
  } finally {
    await db.end()
  }
}

// --- Main ---
const [, , command, subcommand, ...rest] = process.argv

if (command === 'channel') {
  if (subcommand === 'create') await channelCreate(rest)
  else if (subcommand === 'add-member') await channelAddMember(rest)
  else if (subcommand === 'remove-member') await channelRemoveMember(rest)
  else if (subcommand === 'members') await channelMembers(rest)
  else if (subcommand === 'reconcile') await channelReconcile(rest)
  else if (subcommand === 'policy') await channelPolicy(rest)
  else {
    console.error('Usage: agent-com channel <create|add-member|remove-member|members|reconcile|policy> ...')
    process.exit(1)
  }
} else if (command === 'agent') {
  if (subcommand === 'register') await agentRegister(rest)
  else if (subcommand === 'profile') await agentProfile(rest)
  else {
    console.error('Usage: agent-com agent <register|profile> ...')
    process.exit(1)
  }
} else if (command === 'status') {
  await status([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'heartbeat') {
  await heartbeat([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'daemon') {
  await daemon([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'lease') {
  await leaseCommand(subcommand, rest)
} else if (command === 'next') {
  await nextMessage()
} else if (command === 'send') {
  // Issue #132: rest of argv is flag-style (--content / --mentions / ...).
  // subcommand here is the first positional after `send`, which doesn't apply.
  await sendMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'notify') {
  // spec §4.3: self-originated post, no reply context.
  await notifyMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'fail') {
  // spec §4.1, §11 (v2.1.0): explicit abandon with failed_reason.
  await failMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'skip') {
  // spec §4.1, §11 (v2.1.0): operator-initiated skip with failed_reason.
  await skipMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'reclaim') {
  // spec §4.1 (v2.1.0): manual orphan reclaim for crashed bots.
  await reclaimMessages([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'diagnose-delivery') {
  await diagnoseDelivery([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'diagnose-projection') {
  await diagnoseProjection([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'diagnose-queue') {
  await diagnoseQueue([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'queue' && subcommand === 'doctor') {
  await diagnoseQueue(rest)
} else if (command === 'queue' && subcommand === 'preflight') {
  await preflightQueue(rest)
} else if (command === 'queue') {
  await repairQueue(subcommand, rest)
} else if (command === 'directory') {
  await directory([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'runtime') {
  await runtimeCommand(subcommand, rest)
} else if (command === 'inbound') {
  await inboundCommand(subcommand, rest)
} else if (command === 'fleet') {
  await fleetCommand(subcommand, rest)
} else if (command === 'smoke') {
  await smokeCommand(subcommand, rest)
} else if (command === 'worker') {
  await workerCommand(subcommand, rest)
} else if (command === 'agents') {
  await listAgents()
} else {
  console.error(`agent-com CLI v0.2.0

Commands:
  channel create <id> [--name "Name"] [--members cto,dev-a]
  channel add-member <channel_id> <agent_id>
  channel remove-member <channel_id> <agent_id>
  channel members <channel_id>
  channel reconcile [--provider discord] [--channel <external_id>] [--adapter-owner <agent>] [--members a,b] [--execute --confirm <plan_hash>|--dry-run]
  channel policy list [--format json|text]
  channel policy import-json [--execute|--dry-run] [--path <file>]
  channel policy bootstrap [--execute|--dry-run] [--extra-allowlist <a,b>] [--overwrite]
  channel policy sync-connectors [--channel <id|name>] [--provider discord] [--execute|--dry-run]
  channel policy set <channel_id> [--primary <agent|none>] [--adapter-owner <agent|none>] [--allowlist <a,b|none>] [--execute|--dry-run]
  agent register <agent_id> [--display-name "Name"] [--type dev] [--runtime claude-code] [--home-directory <path>] [--channel-port <port>] [--tmux-session <name>] [--runtime-engine <engine>] [--token-source-ref <ref>]
  agent profile get <agent_id>
  agent profile set <agent_id> [--display-name "Name"] [--type dev] [--runtime <runtime>] [--home-directory <path>] [--channel-port <port>] [--tmux-session <name>] [--runtime-engine <engine>] [--token-source-ref <ref>] [--expected-provider discord] [--expected-provider-subject <id>] [--enabled true|false] [--execute|--dry-run]
  agent profile project <agent_id>|--all [--execute|--dry-run]
  agent profile doctor [--strict] [--live-tmux] [--include-disabled] [--include-test]
  status

Message I/O (requires AGENT_ID env var):
  next                                                — fetch one unread message (oldest first)
  send --content "..." --mention cto [--cc observer-a,observer-b] [--fyi observer-c] [--message-type chat] [--no-close|--close]
  notify --channel-id <id> [--thread-id <id>] --mention cto --content "..." [--cc observer-a] [--fyi observer-b] [--message-type chat]
  notify --channel-name <name> --resolve-channel-name --mention cto --content "..." [--cc observer-a] [--fyi observer-b] [--message-type chat]
  fail --message-id <uuid> --reason <text>            — mark in-flight message failed (v2.1.0, §4.1)
  skip --message-id <uuid> --reason <text>            — operator-initiated skip (v2.1.0, §4.1)
  reclaim [--agent-id <id>]                           — manual orphan reclaim (v2.1.0, §4.1)
  diagnose-delivery [--queue-id <id>] [--message-id <uuid>] [--outbound-message-id <uuid>]
                                                       — JSON explanation for next/projection gaps
  diagnose-projection --channel <id> --from <agent> --to <agent>[,<agent>]
                                                       — terminal preview of surface/projection routing
  diagnose-queue [--agent-id <id>] [--stale-minutes 15] [--format json|text]
  queue doctor [--agent-id <id>] [--stale-minutes 15] [--format json|text]
                                                       — queue health blockers and stale-work diagnostics
  queue preflight [--gate all|runtime|projection] [--agent-id <id>] [--stale-minutes 15] [--format json|text]
                                                       — restart gate; exits non-zero while selected queue blockers remain
  queue normalize [--agent-id <id>] [--stale-minutes 15] [--format json|text]
                                                       — dry-run normalization plan with scoped repair commands
  queue reassign --from <agent> --to <agent> [--execute|--dry-run]
                                                       — dry-run by default; reassign pending rows to a replacement identity
  queue close-obsolete --agent-id <agent> --reason <text> [--queue-id <id>] [--include-active] [--execute|--dry-run]
                                                       — dry-run by default; close obsolete pending rows, or one explicit active row
  queue reclaim-expired [--agent-id <agent>] [--execute|--dry-run]
                                                       — dry-run by default; roll expired received/in_progress claims back to pending
  directory [--format json|text]                       — bot/channel directory and sendability report
  runtime inventory [--format json|text] [--stale-minutes 15] [--expected-commit <sha>] [--binding-role outbound]
                                                       — read-only runtime/connector/binding freshness report
  runtime cleanup [--format json|text] [--stale-minutes 15] [--execute --confirm <plan_hash>] [--allow-unknown-risk] [--include-disabled] [--include-test]
                                                       — dry-run stale runtime/listener/tmux cleanup plan; execute requires a matching plan hash
  inbound smoke [--format json|text] [--window-hours 168]
                                                       — read-only Discord inbound smoke evidence by channel
  fleet readiness [--format json|text] [--denylist <a,b>] [--smoke-run-id <id>] [--require-smoke] [--include-disabled] [--include-test]
                                                       — read-only all-agent AUN readiness gates and activation blockers
  smoke run [--format json|text] [--provider discord] [--window-hours 168] [--channel <external_id>] [--include-disabled] [--include-test] [--execute --confirm <plan_hash>] [--timeout-ms 30000]
                                                       — NORM-060 full-channel smoke (dry-run/plan default, read-only)
  smoke queue-wake [--format json|text] [--agent-id <agent>] [--execute --confirm <plan_hash>] [--timeout-ms 15000] [--poll-ms 500]
                                                       — bounded state-daemon queue wake smoke; no manual next and no terminal close
  worker report --agent-id <agent> --summary <text> [--status running|blocked|stalled|failed|completed|handoff] [--queue-id <id>] [--repository <repo>] [--branch <branch>] [--pull-request <ref>] [--progress 0-100] [--progress-label <phase>] [--stale-after-sec 120] [--blocked-reason <text>] [--handoff-target <agent>] [--handoff-channel <id>]
                                                       — write DB-backed current activity evidence for an internal worker
  worker ping --agent-id <agent> --activity-id <uuid> [--summary <text>] [--progress 0-100] [--progress-label <phase>]
                                                       — heartbeat an existing worker activity row so operators can tell it is still moving
  worker list [--agent-id <agent>] [--include-closed] [--format json|text] [--limit 20]
                                                       — show visible worker activity evidence without requiring Discord identity
  agents                                              — list registered agents (JSON)
  status [--format json] [--agent-id <id>]            — system or per-agent status
  heartbeat [--runtime-instance-id <uuid>]           — update last_seen_at and optional runtime heartbeat evidence
  lease acquire --scope-type <type> --scope-id <id> [--purpose outbound] --holder-agent-id <agent> [--ttl-sec 30]
                                                       — acquire a control-plane lease and fencing token
  lease heartbeat --lease-id <id> --fencing-token <n> [--holder-agent-id <agent>] [--ttl-sec 30]
                                                       — extend an active lease if the fence still matches
  lease verify --lease-id <id> --fencing-token <n> [--holder-agent-id <agent>]
                                                       — fail closed unless the active fence still matches
  lease release --lease-id <id> --fencing-token <n> [--holder-agent-id <agent>]
                                                       — release an active lease
  daemon [--poll-interval 3000]                       — long-running poll driver (non-MCP envs)`)
  if (command) process.exit(1)
}
