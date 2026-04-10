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
 *   agent-com send --content "..." --mentions cto,ceo       — reply to last next-fetched message
 *   agent-com agents                                        — list registered agents (JSON)
 *
 * `next` and `send` track the in-flight reply target via a per-agent state file
 * at `/tmp/agent-com-{AGENT_ID}.current`. AGENT_ID env var is required for both.
 */

import { Client } from 'pg'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID, createHash, createHmac } from 'node:crypto'

// --- DB connection ---
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

async function getDb(): Promise<Client> {
  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()
  return client
}

// --- Helpers ---
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      flags[key] = argv[i + 1] ?? ''
      i++
    } else {
      positional.push(argv[i])
    }
  }
  return { positional, flags }
}

async function auditLog(db: Client, eventType: string, agentId: string | null, target: string | null, detail: Record<string, unknown>) {
  await db.query(
    'INSERT INTO audit_log (event_type, agent_id, target, detail, org_id) VALUES ($1, $2, $3, $4, $5)',
    [eventType, agentId, target, JSON.stringify(detail), 'default']
  )
}

async function pgNotify(db: Client, channel: string, payload: Record<string, unknown>) {
  await db.query(`SELECT pg_notify($1, $2)`, [channel, JSON.stringify(payload)])
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

async function agentRegister(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const agentId = positional[0]
  if (!agentId) { console.error('Usage: agent-com agent register <agent_id> [--display-name "Name"] [--type dev] [--runtime claude-code]'); process.exit(1) }

  const displayName = flags['display-name'] ?? agentId
  const agentType = flags.type ?? 'dev'
  const runtime = flags.runtime ?? 'claude-code'

  const db = await getDb()
  await db.query(
    `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, registered_at)
     VALUES ($1, 'default', $2, $3, $4, 'offline', now())
     ON CONFLICT (agent_id) DO UPDATE SET display_name = $2, agent_type = $3, runtime = $4`,
    [agentId, displayName, agentType, runtime]
  )
  await auditLog(db, 'agent.register', 'cli', agentId, { display_name: displayName, agent_type: agentType, runtime })
  await pgNotify(db, 'agent_events', { event: 'agent.register', agent_id: agentId })
  console.log(`Agent '${agentId}' registered (${displayName}, ${agentType}/${runtime})`)
  await db.end()
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #132 — message-queue-spec §4-6 commands (MVP: next / send / agents)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the runtime AGENT_ID. Required for next/send because the CLI must
 * know which inbox to read and which author to stamp on outbound rows.
 */
function requireAgentId(command: string): string {
  const id = process.env.AGENT_ID
  if (!id) {
    console.error(`Error: AGENT_ID env var is required for 'agent-com ${command}'`)
    process.exit(2)
  }
  return id
}

/**
 * Inbox signal directory shared with server.ts (`sendInboxSignal`). routeInbound
 * already filters recipients on push, so reading these signals == reading the
 * agent's authoritative pending queue. Each `.signal` file is named with a
 * Date.now() prefix so lexical sort == chronological order.
 */
function inboxDir(agentId: string): string {
  const stateDir = process.env.AGENT_COMMS_STATE_DIR ?? join(homedir(), '.agent-com')
  return join(stateDir, 'inbox', agentId)
}

function currentStatePath(agentId: string): string {
  return join(tmpdir(), `agent-com-${agentId}.current`)
}

/** Return signal file paths sorted oldest-first, or [] if none / dir missing. */
function listSignals(agentId: string): string[] {
  const dir = inboxDir(agentId)
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.signal'))
      .sort()
      .map(f => join(dir, f))
  } catch {
    return []
  }
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Outbound platform delivery (Discord REST API direct call)
// ─────────────────────────────────────────────────────────────────────────────
//
// ARC codex audit (2026-04-10): after the INSERT + pg_notify, the CLI must
// also relay the message to the originating platform (Discord first), or the
// reply only exists in the DB and never reaches human users in the channel.
//
// Phase 1 minimum: call Discord REST API directly using $DISCORD_BOT_TOKEN.
// Phase 3 will replace this with an `outbound_queue` INSERT consumed by a
// dedicated outbound worker — see message-queue-spec §7.2.
//
// Resolution order:
//   1. If `thread_id` is set on the in-flight state, prefer thread_adapters
//      (so the reply lands in the same thread, not the parent).
//   2. Otherwise, fall back to channel_adapters for the parent channel.
async function deliverToDiscord(
  db: Client,
  channelId: string,
  threadId: string | null,
  content: string,
): Promise<{ delivered: boolean; reason?: string }> {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) return { delivered: false, reason: 'DISCORD_BOT_TOKEN not set' }

  // Resolve external Discord channel/thread ID.
  let externalId: string | null = null
  if (threadId) {
    const r = await db.query(
      `SELECT external_id FROM thread_adapters WHERE thread_id = $1 AND platform = 'discord'`,
      [threadId],
    )
    if (r.rows.length > 0) externalId = r.rows[0].external_id
  }
  if (!externalId) {
    const r = await db.query(
      `SELECT external_id FROM channel_adapters WHERE channel_id = $1 AND platform = 'discord'`,
      [channelId],
    )
    if (r.rows.length > 0) externalId = r.rows[0].external_id
  }
  if (!externalId) return { delivered: false, reason: 'no discord adapter mapping' }

  // Discord 2,000 char limit — codepoint-safe truncation.
  const DISCORD_LIMIT = 2000
  let body = content
  if ([...body].length > DISCORD_LIMIT) {
    body = [...body].slice(0, DISCORD_LIMIT - 1).join('') + '…'
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${externalId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: body }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { delivered: false, reason: `discord ${res.status}: ${text.slice(0, 200)}` }
    }
    return { delivered: true }
  } catch (err) {
    return { delivered: false, reason: `discord fetch failed: ${err}` }
  }
}

/**
 * `agent-com next` — pop one pending message_queue row and stamp it as the
 * agent's current_message_id (Issue #128 Phase 2 / message-queue-spec §4.1).
 *
 * Internal flow (spec §4.1 step list, mapped to this implementation):
 *   1. If agents.current_message_id is set → implicit-skip the prior row
 *      (UPDATE message_queue SET status='skipped' WHERE id=current
 *       AND status='read'). The spec wording leaves status='read' on
 *       implicit skip, but we use 'skipped' so operators can distinguish
 *       bypassed messages from in-progress ones. The CHECK constraint
 *       added in db/migrate.ts allows both values.
 *   2. SELECT the oldest pending row (priority DESC, created_at ASC).
 *   3. UPDATE status='read', read_at=NOW(), agents.current_message_id=row.id.
 *   4. Hydrate channel/content from message_queue.payload (the receiver
 *      already enriched it on INSERT) — no second query into agent_messages
 *      is required for the canonical fields.
 *   5. Emit JSON with §4.1 shape (waiting count, content, channel_id, ...).
 *
 * Mixed Mode (spec §21): if the queue is empty for this agent, fall back to
 * the legacy filesystem-signal path so existing bots that haven't migrated
 * to the receiver-with-message_queue path still work. Operators can opt out
 * of the fallback by setting AGENT_COMMS_LEGACY_QUEUE=0.
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
    // Step 1: implicit-skip the prior current_message_id (Issue #128 §4.1).
    // ARC codex audit (PR#134, lead-ama msg 1492279341898272849): wrap the
    // SELECT + UPDATEs in BEGIN/COMMIT with FOR UPDATE SKIP LOCKED so two
    // concurrent `agent-com next` invocations for the same agent never pop
    // the same row. SKIP LOCKED makes a parallel call see the next pending
    // row instead of blocking.
    //
    // The implicit-skip of the prior current_message_id is part of the same
    // transaction so a crash midway through cannot leave us with a popped
    // 'read' row and an unsynchronised agents.current_message_id.
    let row: { id: string | number; message_id: string | null; payload: string; priority: number; created_at: Date } | null = null
    let priorId: number | null = null
    await db.query('BEGIN')
    try {
      const prevRow = await db.query(
        `SELECT current_message_id FROM agents WHERE agent_id = $1 FOR UPDATE`,
        [agentId],
      )
      priorId = prevRow.rows[0]?.current_message_id ?? null
      if (priorId !== null) {
        await db.query(
          `UPDATE message_queue SET status = 'skipped'
           WHERE id = $1 AND status = 'read'`,
          [priorId],
        )
      }

      // Step 2: pop the oldest pending row with an exclusive lock so a
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
        // Empty queue under lock — clear current_message_id so a stale value
        // doesn't trigger a phantom implicit-skip on the next call. Commit
        // before falling through to the (read-only) signal fallback.
        if (priorId !== null) {
          await db.query(`UPDATE agents SET current_message_id = NULL WHERE agent_id = $1`, [agentId])
        }
        await db.query('COMMIT')
      } else {
        // Step 3: mark read + stamp current_message_id inside the same txn.
        // Both UPDATEs run before COMMIT so a crash mid-step leaves a clean
        // state (PostgreSQL aborts the txn).
        const popped = pop.rows[0]
        await db.query(
          `UPDATE message_queue SET status = 'read', read_at = now() WHERE id = $1`,
          [popped.id],
        )
        await db.query(
          `UPDATE agents SET current_message_id = $1 WHERE agent_id = $2`,
          [popped.id, agentId],
        )
        await db.query('COMMIT')
        row = popped
      }
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      throw err
    }

    if (row === null) {
      // Mixed Mode (§21): fall back to filesystem signals for any inbox
      // signals that the receiver wrote without going through message_queue
      // (e.g. bots not yet migrated). Skip when explicitly disabled.
      if (process.env.AGENT_COMMS_LEGACY_QUEUE !== '0') {
        const fallback = await nextMessageFromSignal(db, agentId)
        if (fallback) {
          process.stdout.write(JSON.stringify(fallback) + '\n')
          return
        }
      }
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
    }) + '\n')
  } finally {
    await db.end()
  }
}

/**
 * Mixed-Mode legacy fallback: if message_queue is empty for this agent, scan
 * the filesystem signal directory and synthesize a queue-shaped response.
 * Returns null when there is no signal either. Writes the legacy state file
 * so `sendMessage` can recover the reply target via either path.
 */
async function nextMessageFromSignal(db: Client, agentId: string): Promise<Record<string, unknown> | null> {
  const signals = listSignals(agentId)
  if (signals.length === 0) return null
  const signalPath = signals[0]
  let messageId: string
  let signalFrom: string | null = null
  try {
    const sig = JSON.parse(readFileSync(signalPath, 'utf-8'))
    messageId = sig.id
    signalFrom = sig.from ?? null
  } catch {
    return null
  }

  const r = await db.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, thread_id, created_at
     FROM agent_messages WHERE id = $1`,
    [messageId],
  )
  if (r.rows.length === 0) {
    // Stale signal — drop and report empty. Caller will surface waiting:0.
    try { unlinkSync(signalPath) } catch {}
    return { waiting: 0, dropped_stale: messageId }
  }
  const row = r.rows[0]

  // Write the legacy state file so the existing send-path branch can pick it up.
  writeFileSync(
    currentStatePath(agentId),
    JSON.stringify({
      message_id: row.id,
      channel_id: row.channel_id,
      thread_id: row.thread_id ?? null,
      signal_path: signalPath,
    }),
    { mode: 0o600 },
  )

  return {
    waiting: signals.length,
    mode: 'signal',
    queue_id: null,
    message_id: row.id,
    channel_id: row.channel_id,
    thread_id: row.thread_id ?? null,
    from: row.author_id ?? signalFrom,
    content: row.content,
    message_type: row.message_type,
    source: 'legacy-signal',
    created_at: row.created_at,
  }
}

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
 *   --mentions a,b,c          required (comma-separated agent IDs)
 *   --message-type chat|...   default: chat
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
  const content = flags.content
  const mentionsRaw = flags.mentions
  const messageType = flags['message-type'] ?? 'chat'

  if (!content) {
    console.error('Error: --content is required')
    process.exit(2)
  }
  if (!mentionsRaw) {
    console.error('Error: --mentions is required (comma-separated agent IDs)')
    process.exit(2)
  }
  const mentions = mentionsRaw.split(',').map(m => m.trim()).filter(Boolean)
  if (mentions.length === 0) {
    console.error('Error: --mentions must contain at least one agent ID')
    process.exit(2)
  }

  // ARC codex audit follow-up (PR#134, lead-ama msg 1492283029933133874):
  // wrap the entire DB-touching flow in BEGIN/COMMIT with FOR UPDATE on the
  // agents row. Two concurrent `agent-com send` calls now serialise on the
  // agents row lock — the second caller blocks until the first commits, then
  // sees current_message_id = NULL (cleared by the first) and exits with
  // NO_CURRENT_MESSAGE instead of double-replying.
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

  const db = await getDb()
  let exitCode = 0
  let committed = false
  try {
    await db.query('BEGIN')
    try {
      // ─────────────────────────────────────────────────────────────────
      // Step 1: lock the agents row + read current_message_id
      // ─────────────────────────────────────────────────────────────────
      // FOR UPDATE blocks any other session that takes the same row lock,
      // so concurrent `next`/`send` calls for this agent serialise on this
      // line. The first caller wins; the second blocks here until the first
      // commits, then reads the post-commit state (current_message_id = NULL
      // after a successful send).
      type Target = {
        mode: 'queue' | 'signal'
        reply_to: string         // agent_messages.id of the original
        channel_id: string
        thread_id: string | null
        queue_id: number | null  // message_queue.id (queue mode only)
        signal_path: string | null
        state_path: string | null
      }
      let target: Target | null = null

      const cur = await db.query(
        `SELECT current_message_id FROM agents WHERE agent_id = $1 FOR UPDATE`,
        [agentId],
      )
      const currentId: number | null = cur.rows[0]?.current_message_id ?? null
      if (currentId !== null) {
        const q = await db.query(
          `SELECT id, message_id, payload FROM message_queue WHERE id = $1`,
          [currentId],
        )
        if (q.rows.length > 0) {
          const qrow = q.rows[0]
          let payload: Record<string, any> = {}
          try { payload = JSON.parse(qrow.payload) } catch {}
          target = {
            mode: 'queue',
            reply_to: qrow.message_id ?? payload.message_id,
            channel_id: payload.channel_id,
            thread_id: payload.thread_id ?? null,
            queue_id: qrow.id,
            signal_path: null,
            state_path: null,
          }
        }
      }

      // Mixed-Mode fallback: legacy /tmp state file (set by signal-mode `next`).
      const statePath = currentStatePath(agentId)
      if (target === null && existsSync(statePath)) {
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf-8'))
          target = {
            mode: 'signal',
            reply_to: state.message_id,
            channel_id: state.channel_id,
            thread_id: state.thread_id ?? null,
            queue_id: null,
            signal_path: state.signal_path ?? null,
            state_path: statePath,
          }
        } catch (err) {
          console.error(`Error: failed to read legacy state file ${statePath}: ${err}`)
          throw new CliSendExit(1)
        }
      }

      if (target === null) {
        // Spec §4.2 step 1: no current message → NO_CURRENT_MESSAGE error.
        // This branch ALSO catches the "concurrent send raced and won" case:
        // the first caller has already committed and cleared current_message_id,
        // so the second caller wakes up here with NO_CURRENT_MESSAGE.
        console.error(`Error [NO_CURRENT_MESSAGE]: no in-flight message for ${agentId} — run 'agent-com next' first`)
        throw new CliSendExit(1)
      }

      // ARC codex audit (2026-04-10): thread_id must flow through to the INSERT
      // and the outbound delivery so the reply lands in the same thread.
      const threadId: string | null = target.thread_id

      // Re-bind state alias for the legacy code paths below that referenced
      // `state.channel_id` etc. — keeps the diff localised.
      const state = {
        message_id: target.reply_to,
        channel_id: target.channel_id,
        signal_path: target.signal_path,
      }
      // Membership check — bot can only reply in channels it belongs to.
      const ch = await db.query('SELECT members FROM channels WHERE id = $1', [state.channel_id])
      if (ch.rows.length === 0) {
        console.error(`Error: channel ${state.channel_id} not found`)
        throw new CliSendExit(1)
      }
      const members: string[] = ch.rows[0].members ?? []
      if (!members.includes(agentId)) {
        console.error(`Error: ${agentId} is not a member of channel ${state.channel_id}`)
        throw new CliSendExit(1)
      }

      const id = randomUUID()
      // ARC codex audit (2026-04-10): include HMAC auth metadata so receivers
      // in `enforce` mode don't drop CLI-originated rows as [UNVERIFIED]. The
      // helper returns undefined when AGENT_COMMS_AUTH_MODE === 'off' / no
      // secret, matching server.ts:createAuthMetadata behavior.
      const authMeta = buildAuthMetadata(agentId, state.channel_id, content)
      const metadata: Record<string, unknown> = {
        mentions,
        cli: 'agent-com next/send (MVP)',
        ...(authMeta ?? {}),
      }
      await db.query(
        `INSERT INTO agent_messages
           (id, channel_id, author_id, content, message_type, reply_to, metadata,
            depth, source, thread_id, direction, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'agent-comms', $8, 'outbound', 'agent')`,
        [id, state.channel_id, agentId, content, messageType, state.message_id, JSON.stringify(metadata), threadId],
      )

      // pg_notify so server.ts (or any LISTENer) picks the row up and runs the
      // full receiver-side routing (channel-server push, SSE fallback, …).
      //
      // The agent_inbox LISTEN handler routes per-recipient: `to` MUST be a
      // recipient agent_id, NOT the channel id. Fan out one notify per mention so
      // every push target gets its own routing pass — matches the inbound
      // pipeline's `to: receiverAgentId` shape (server.ts handleInboundMessage
      // L1349-1355). lead-ama follow-up to PR#133 first cut.
      for (const recipient of mentions) {
        await db.query(
          `SELECT pg_notify('agent_inbox', $1)`,
          [JSON.stringify({
            event: 'message.created',
            to: recipient,
            message_id: id,
            channel_id: state.channel_id,
            source: 'cli-send',
          })],
        )
      }

      // ARC codex audit (2026-04-10): after the DB row is committed, relay the
      // message to the originating platform. Phase 1 minimum is a direct Discord
      // REST API call (Phase 3 will replace this with outbound_queue).
      // NOTE: this HTTP call happens INSIDE the transaction (PR#134 ARC
      // follow-up). The agents row lock is held for the duration of the call.
      const deliveryResult = await deliverToDiscord(db, state.channel_id, threadId, content)

      // ARC codex audit follow-ups for the failure branch (PR#133 → PR#134):
      //
      // Phase 1.5 (signal mode, ARC msg 1492266518673887262): the legacy
      // filesystem state file + inbox signal MUST stay in place on failure so
      // the operator can resend by re-running `agent-com send`. The DB row is
      // already INSERTed; a naive retry creates a duplicate row but preserves
      // delivery semantics.
      //
      // Phase 2 (queue mode, ARC msg 1492279341898272849): the DB row is the
      // queue's source of truth. Leaving the queue at 'read' would let a
      // re-run pop the same logical message and INSERT a SECOND reply through
      // the spec'd flow — the very double-reply class the queue was meant to
      // prevent. So in queue mode we mark the row 'replied' and clear
      // current_message_id even on Discord failure. The agent_messages row is
      // intact; outbound retry is delegated to Phase 3 outbound_queue.
      //
      // Both modes still report ok:false + db_saved:true so callers can detect
      // the Discord-side failure and decide whether to surface it to humans.
      if (!deliveryResult.delivered) {
        if (target.mode === 'queue' && target.queue_id !== null) {
          await db.query(
            `UPDATE message_queue SET status = 'replied', replied_at = now(), replied_with = $1
             WHERE id = $2`,
            [id, target.queue_id],
          )
          await db.query(
            `UPDATE agents SET current_message_id = NULL WHERE agent_id = $1`,
            [agentId],
          )
        }
        // Signal mode: leave target.state_path / target.signal_path in place.
        // COMMIT the INSERT + (queue UPDATEs if any) so the failure response's
        // db_saved:true claim is honoured even when we exit non-zero.
        await db.query('COMMIT')
        committed = true
        process.stdout.write(JSON.stringify({
          ok: false,
          mode: target.mode,
          message_id: id,
          channel_id: state.channel_id,
          thread_id: threadId,
          reply_to: state.message_id,
          mentions,
          auth_signed: authMeta !== undefined,
          db_saved: true,
          discord_delivered: false,
          discord_skip_reason: deliveryResult.reason,
          // Mode-specific retry guidance.
          retry: target.mode === 'queue'
            ? 'queue marked replied to prevent double-reply through next/send. Outbound retry must wait for Phase 3 outbound_queue, OR post the agent_messages row to Discord manually.'
            : 'run agent-com send again to retry Discord delivery (will create a duplicate DB row — clean up manually after success)',
        }) + '\n')
        throw new CliSendExit(1)
      }

      // ─────────────────────────────────────────────────────────────────
      // Discord 配信成功 — finalize in-flight state.
      // ─────────────────────────────────────────────────────────────────
      if (target.mode === 'queue' && target.queue_id !== null) {
        // Spec §4.2 step 9-11: replied + clear current_message_id.
        await db.query(
          `UPDATE message_queue SET status = 'replied', replied_at = now(), replied_with = $1
           WHERE id = $2`,
          [id, target.queue_id],
        )
        await db.query(
          `UPDATE agents SET current_message_id = NULL WHERE agent_id = $1`,
          [agentId],
        )
      }
      // COMMIT the success path before touching the filesystem (the
      // unlinkSync calls below are non-transactional and must run after
      // the DB state is durable).
      await db.query('COMMIT')
      committed = true
      if (target.mode === 'signal') {
        // Mixed-Mode legacy path: clear filesystem state after COMMIT.
        if (target.state_path) { try { unlinkSync(target.state_path) } catch {} }
        if (target.signal_path) { try { unlinkSync(target.signal_path) } catch {} }
      }

      process.stdout.write(JSON.stringify({
        ok: true,
        mode: target.mode,
        message_id: id,
        channel_id: state.channel_id,
        thread_id: threadId,
        reply_to: state.message_id,
        mentions,
        auth_signed: authMeta !== undefined,
        discord_delivered: true,
      }) + '\n')
    } finally {
      // If we threw without committing (validation error, NO_CURRENT_MESSAGE,
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
 * `agent-com agents` — list registered agents as JSON.
 * MVP: no filters; reads the agents table verbatim.
 */
async function listAgents() {
  const db = await getDb()
  try {
    const r = await db.query(
      `SELECT agent_id, display_name, agent_type, runtime, status, channel_port, registered_at
       FROM agents
       ORDER BY agent_id`,
    )
    process.stdout.write(JSON.stringify(r.rows, null, 2) + '\n')
  } finally {
    await db.end()
  }
}

async function status() {
  const db = await getDb()

  const chCount = await db.query('SELECT COUNT(*) as cnt FROM channels')
  const agOnline = await db.query("SELECT COUNT(*) as cnt FROM agents WHERE status = 'online'")
  const agTotal = await db.query('SELECT COUNT(*) as cnt FROM agents')
  const msgRecent = await db.query("SELECT COUNT(*) as cnt FROM agent_messages WHERE created_at > now() - interval '1 hour'")
  const auditRecent = await db.query("SELECT COUNT(*) as cnt FROM audit_log WHERE created_at > now() - interval '1 hour'")

  console.log('=== agent-com status ===')
  console.log(`DB: connected`)
  console.log(`Channels: ${chCount.rows[0].cnt}`)
  console.log(`Agents: ${agOnline.rows[0].cnt} online / ${agTotal.rows[0].cnt} total`)
  console.log(`Messages (1h): ${msgRecent.rows[0].cnt}`)
  console.log(`Audit events (1h): ${auditRecent.rows[0].cnt}`)
  await db.end()
}

// --- Main ---
const [, , command, subcommand, ...rest] = process.argv

if (command === 'channel') {
  if (subcommand === 'create') await channelCreate(rest)
  else if (subcommand === 'add-member') await channelAddMember(rest)
  else if (subcommand === 'remove-member') await channelRemoveMember(rest)
  else if (subcommand === 'members') await channelMembers(rest)
  else {
    console.error('Usage: agent-com channel <create|add-member|remove-member|members> ...')
    process.exit(1)
  }
} else if (command === 'agent') {
  if (subcommand === 'register') await agentRegister(rest)
  else {
    console.error('Usage: agent-com agent <register> ...')
    process.exit(1)
  }
} else if (command === 'status') {
  await status()
} else if (command === 'next') {
  await nextMessage()
} else if (command === 'send') {
  // Issue #132: rest of argv is flag-style (--content / --mentions / ...).
  // subcommand here is the first positional after `send`, which doesn't apply.
  await sendMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'agents') {
  await listAgents()
} else {
  console.error(`agent-com CLI v0.2.0

Commands:
  channel create <id> [--name "Name"] [--members cto,dev-a]
  channel add-member <channel_id> <agent_id>
  channel remove-member <channel_id> <agent_id>
  channel members <channel_id>
  agent register <agent_id> [--display-name "Name"] [--type dev] [--runtime claude-code]
  status

Message I/O (Issue #132, MVP — requires AGENT_ID env var):
  next                                                — fetch one unread message (oldest first)
  send --content "..." --mentions cto,ceo [--message-type chat]
  agents                                              — list registered agents (JSON)`)
  if (command) process.exit(1)
}
