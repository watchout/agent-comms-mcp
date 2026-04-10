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
import { randomUUID } from 'node:crypto'

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

/**
 * `agent-com next` — pop one unread inbox signal, hydrate the row from
 * agent_messages, and stash the in-flight state for the eventual `send`.
 *
 * Output (stdout, single JSON object):
 *   { waiting: true }                                       — nothing pending
 *   { waiting: false, message_id, channel_id, from, content, message_type, created_at, reply_to }
 *
 * The signal file is NOT deleted here — `send` deletes it on successful
 * reply, and a future `agent-com ack` (out of MVP scope) can clear it without
 * sending. This keeps the queue conservative: a crash between next and send
 * leaves the signal in place for the next attempt.
 */
async function nextMessage() {
  const agentId = requireAgentId('next')
  const signals = listSignals(agentId)
  if (signals.length === 0) {
    process.stdout.write(JSON.stringify({ waiting: true }) + '\n')
    return
  }
  const signalPath = signals[0]
  let messageId: string
  let signalFrom: string | null = null
  let signalChannel: string | null = null
  try {
    const sig = JSON.parse(readFileSync(signalPath, 'utf-8'))
    messageId = sig.id
    signalFrom = sig.from ?? null
    signalChannel = sig.channel ?? null
  } catch (err) {
    console.error(`Error: failed to read signal file ${signalPath}: ${err}`)
    process.exit(1)
  }

  const db = await getDb()
  try {
    const r = await db.query(
      `SELECT id, channel_id, author_id, content, message_type, reply_to, created_at
       FROM agent_messages WHERE id = $1`,
      [messageId],
    )
    if (r.rows.length === 0) {
      // Stale signal — the message was deleted. Drop the signal and report empty.
      try { unlinkSync(signalPath) } catch {}
      process.stdout.write(JSON.stringify({ waiting: true, dropped_stale: messageId }) + '\n')
      return
    }
    const row = r.rows[0]
    // Persist in-flight state for `send` to consume.
    writeFileSync(
      currentStatePath(agentId),
      JSON.stringify({ message_id: row.id, channel_id: row.channel_id, signal_path: signalPath }),
      { mode: 0o600 },
    )
    process.stdout.write(JSON.stringify({
      waiting: false,
      message_id: row.id,
      channel_id: row.channel_id,
      from: row.author_id ?? signalFrom,
      content: row.content,
      message_type: row.message_type,
      reply_to: row.reply_to,
      created_at: row.created_at,
      signal_channel: signalChannel,
    }) + '\n')
  } finally {
    await db.end()
  }
}

/**
 * `agent-com send` — reply to the message captured by the most recent `next`.
 *
 * Flags:
 *   --content "<text>"        required
 *   --mentions a,b,c          required (comma-separated agent IDs)
 *   --message-type chat|...   default: chat
 *
 * MVP scope: this is a thin INSERT + pg_notify path. The full server.ts send
 * handler (rate limit / dup check / message split / channel-server push /
 * SSE fallback) is intentionally NOT duplicated here — the receiver picks up
 * the row via pg_notify and runs its own routing. Adding the heavy validation
 * is the next iteration once we have a shared core module to import from.
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

  const statePath = currentStatePath(agentId)
  if (!existsSync(statePath)) {
    console.error(`Error: no in-flight message — run 'agent-com next' first (state file ${statePath} missing)`)
    process.exit(1)
  }
  let state: { message_id: string; channel_id: string; signal_path: string }
  try {
    state = JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch (err) {
    console.error(`Error: failed to read state file ${statePath}: ${err}`)
    process.exit(1)
  }

  const db = await getDb()
  try {
    // Membership check — bot can only reply in channels it belongs to.
    const ch = await db.query('SELECT members FROM channels WHERE id = $1', [state.channel_id])
    if (ch.rows.length === 0) {
      console.error(`Error: channel ${state.channel_id} not found`)
      process.exit(1)
    }
    const members: string[] = ch.rows[0].members ?? []
    if (!members.includes(agentId)) {
      console.error(`Error: ${agentId} is not a member of channel ${state.channel_id}`)
      process.exit(1)
    }

    const id = randomUUID()
    const metadata = { mentions, cli: 'agent-com next/send (MVP)' }
    await db.query(
      `INSERT INTO agent_messages
         (id, channel_id, author_id, content, message_type, reply_to, metadata,
          depth, source, thread_id, direction, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'agent-comms', NULL, 'outbound', 'agent')`,
      [id, state.channel_id, agentId, content, messageType, state.message_id, JSON.stringify(metadata)],
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

    // Clear in-flight state and the consumed inbox signal.
    try { unlinkSync(statePath) } catch {}
    try { unlinkSync(state.signal_path) } catch {}

    process.stdout.write(JSON.stringify({
      ok: true,
      message_id: id,
      channel_id: state.channel_id,
      reply_to: state.message_id,
      mentions,
    }) + '\n')
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
