/**
 * Per-fixture DB seed helpers. Tests target the same `agent_comms` dev DB but
 * scope their data to `agent_id LIKE 'sd-test-%'` and a known set of queue ids
 * inserted within the fixture, so they cannot collide with live fleet rows.
 *
 * For real isolation in CI, swap `DATABASE_URL` to a testcontainers / per-run
 * schema. The contract is: `cleanFixture` removes everything the fixture wrote.
 */
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeHostFixture, registerNativeFixtureRuntime, stopNativeFixtures } from '../../helpers/seat-native-runtime-fixture'
import { readNativeSeatContextReceipt } from '../../../core/seat-context-recovery'
import { recordVerifiedNativeRuntimeMemoryReady } from '../../../core/runtime-memory-ready'
import type { observeSeatProvider } from '../../../core/seat-runtime-selection'

type NativeFixture = Awaited<ReturnType<typeof nativeHostFixture>>
const nativeModes = new WeakMap<Client, { epoch: number; origin: number;
  seats: Map<string, { fixture: NativeFixture; home: string; id: string; session: string; providerVisible: boolean }> }>()

/** Only the opted-in caller tests use real native evidence. Business-clock offsets
 * remain deterministic, translated near the genuine receipt's wall clock. */
export function enableNativeRuntimeFixtures(client: Client, epoch: string): void {
  nativeModes.set(client, { epoch: Date.parse(epoch), origin: Date.now(), seats: new Map() })
}
export function fixtureDate(client: Client, original: Date | string): Date {
  const mode = nativeModes.get(client)
  if (!mode) throw new Error('NATIVE_FIXTURE_CLOCK_NOT_ENABLED')
  return new Date(mode.origin + new Date(original).getTime() - mode.epoch)
}
export function fixtureProviderObserver(client: Client): typeof observeSeatProvider {
  return input => {
    const seat = nativeModes.get(client)?.seats.get(input.agentId)
    return seat?.providerVisible ? seat.fixture.observeProvider(input) : null
  }
}

export function fixtureNativeProofReader(client: Client): typeof import('../../../core/runtime-native-proof').readCurrentNativeProof {
  return async input => {
    const seat=nativeModes.get(client)?.seats.get(input.agentId)
    if(!seat || seat.id!==input.runtimeInstanceId)throw Error('NATIVE_FIXTURE_SEAT_MISMATCH')
    return readNativeSeatContextReceipt({agentId:input.agentId,project:input.project,runtimeInstanceId:input.runtimeInstanceId,
      targetRuntime:'codex',providerPid:input.observation.provider_pid,providerStartedAt:input.observation.provider_started_at,
      hostSessionId:seat.session,transport:{command:seat.fixture.node,args:[seat.fixture.memory],env:seat.fixture.env},
      env:{PATH:process.env.PATH!,LANG:'C',...seat.fixture.env},cwd:seat.home})
  }
}

export async function refreshNativeFixtureHeartbeat(client: Client, agentId: string, now: Date): Promise<void> {
  const seat = nativeModes.get(client)?.seats.get(agentId)
  if (!seat) throw new Error('NATIVE_FIXTURE_SEAT_MISSING')
  const endpoint = seat.fixture.observed.endpoint
  const observation = seat.fixture.observeProvider({agentId,runtimeInstanceId:seat.id,
    processId:endpoint.pid,sessionName:seat.session,workspace:seat.home,now})
  if (!observation) throw new Error('NATIVE_FIXTURE_PROVIDER_EXITED')
  // Heartbeat renews logical authority. Physical freshness is read from this
  // fixture's actual process; the deterministic business clock is not a DB
  // liveness snapshot.
  await client.query(`UPDATE control_plane_leases SET expires_at=$2
    WHERE holder_runtime_instance_id=$1 AND status='active'`,
    [seat.id,new Date(Math.max(Date.now(),now.getTime())+30*60_000)])

}

async function seedNativeRuntime(client: Client, agent: SeedAgent, session: string): Promise<void> {
  const mode = nativeModes.get(client)!
  let seat = mode.seats.get(agent.agent_id)
  if (!seat) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-native-seat-')))
    const id = agent.runtime_instance_id ?? randomUUID()
    const fixture = await nativeHostFixture(home, home, agent.agent_id, 'agent-comms-mcp', session, 'accepted', id)
    seat = { fixture, home, id, session,
      providerVisible: agent.observed_provider === 'codex' }
    mode.seats.set(agent.agent_id, seat)
  }
  const db = {
    query: async (sql: string, params?: any[]) => (await client.query(sql, params)).rows,
    execute: async (sql: string, params?: any[]) => ({ rowCount: (await client.query(sql, params)).rowCount ?? 0 }),
  }
  await registerNativeFixtureRuntime(db as any, seat.fixture, agent.agent_id, 'agent-comms-mcp', seat.session, seat.home, seat.id)
  if (agent.memoryReady !== false) {
    const receipt = await readNativeSeatContextReceipt({agentId:agent.agent_id,project:'agent-comms-mcp',runtimeInstanceId:seat.id,
      targetRuntime:'codex',providerPid:seat.fixture.observed.provider.pid,providerStartedAt:seat.fixture.observed.provider.startedAt,
      hostSessionId:seat.session,transport:{command:seat.fixture.node,args:[seat.fixture.memory],env:seat.fixture.env},cwd:seat.home})
    await recordVerifiedNativeRuntimeMemoryReady(db,{agentId:agent.agent_id,project:'agent-comms-mcp',runtimeInstanceId:seat.id,
      receipt,observeProvider:seat.fixture.observeProvider,inspect:seat.fixture.inspect,readNativeProof:fixtureNativeProofReader(client)})
  }
  await client.query(`INSERT INTO channels (id, name, type, members) VALUES ($1, $1, 'channel', ARRAY[$2]::text[])
    ON CONFLICT (id) DO UPDATE SET members=EXCLUDED.members`, [`${TEST_PREFIX}channel-${agent.agent_id}`, agent.agent_id])
}

export const TEST_PREFIX = 'sd-test-'

export function makeAgentId(suffix: string): string {
  return `${TEST_PREFIX}${suffix}`
}

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const MIGRATION_FILES = [
  'db/migrations/2026-05-08-state-daemon-323.up.sql',
  'db/migrations/2026-05-14-agent-wake-suppression-ssot.up.sql',
  'db/migrations/2026-06-06-runtime-memory-ready-evidence.up.sql',
]
let migrationApplied = false

/**
 * Apply the state-daemon migration once per test process. The CI workflow
 * runs `bun run db/migrate.ts` which only installs the inline core schema
 * (paired files under `db/migrations/` are operator-driven per the migrate.ts
 * comment, so the workflow never reaches them). The migration is idempotent
 * — every statement is guarded — so re-applying on a dev DB that already
 * has the schema from PR #329 is a no-op.
 */
async function ensureStateDaemonMigration(client: Client): Promise<void> {
  if (migrationApplied) return
  try {
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(join(REPO_ROOT, file), 'utf-8')
      await client.query(sql)
    }
    migrationApplied = true
  } catch (err) {
    // The migration file may not be present on a branch that has rebased
    // past it; keep the seed helper resilient so other branches can still
    // run unrelated DB tests.
    process.stderr.write(
      `[state-daemon test seed] migration apply skipped: ${(err as Error).message}\n`,
    )
  }
}

export async function openClient(): Promise<Client> {
  const url = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
  const c = new Client({ connectionString: url })
  await c.connect()
  // State-daemon contract files share the same fixture prefix on the same
  // Postgres database. Bun may run files in parallel, so serialize the suite
  // at the DB connection level before any file can clean another file's rows.
  await c.query(`SELECT pg_advisory_lock(hashtext('agent-comms-state-daemon-contract-tests'))`)
  await ensureStateDaemonMigration(c)
  return c
}

export async function cleanAll(c: Client): Promise<void> {
  const mode = nativeModes.get(c)
  if (mode?.seats.size) {
    await stopNativeFixtures()
    for (const seat of mode.seats.values()) rmSync(seat.home, {recursive:true,force:true})
    mode.seats.clear()
  }
  await c.query(`DELETE FROM message_queue WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
  await c.query(`DELETE FROM agent_messages WHERE channel_id LIKE $1`, [`${TEST_PREFIX}channel-%`])
  await c.query(`DELETE FROM channels WHERE id LIKE $1`, [`${TEST_PREFIX}channel-%`])
  await c.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
}

export interface SeedAgent {
  /** Explicit fixture process observation, independent of stored profile hints. */
  observed_provider?: 'codex' | null
  agent_id: string
  runtime?: 'TUI' | 'SIG' | 'codex' | 'codex-runner'
  runtime_engine_preference?: 'codex' | 'codex-runner' | 'claude-code' | null
  tmux_session?: string | null
  discord_id?: string | null
  port?: number | null
  status?: 'online' | 'offline' | 'idle' | 'busy' | 'restarting'
  last_seen_at?: Date | string
  runtime_instance_id?: string
  memoryReady?: boolean
}

function fixturePort(agentId: string): number {
  let hash = 0
  for (const ch of agentId) hash = (hash * 31 + ch.charCodeAt(0)) % 20_000
  return 20_000 + hash
}

export async function seedAgent(c: Client, a: SeedAgent): Promise<void> {
  // tmux_session lives in metadata JSONB per spec v0.6 §7.1 (既存 column 不要、
  // metadata key で abstract). status / last_seen_at / runtime はそれぞれ既存 column.
  const metadata: Record<string, unknown> = {}
  metadata.memory_project = 'agent-comms-mcp'
  // A session identity remains part of the registered memory-ready tuple even
  // for a non-TUI runner. `tmux_session: null` means the planner must not use a
  // tmux wake path; it does not make the runtime instance anonymous.
  metadata.tmux_session = a.tmux_session === null
    ? `${a.agent_id}-codex`
    : a.tmux_session ?? `${a.agent_id}-session`
  if (a.discord_id) {
    metadata.discord_id = a.discord_id
  }
  const port = a.port === undefined ? fixturePort(a.agent_id) : a.port
  await c.query(
    `INSERT INTO agents(agent_id,display_name,agent_type,last_wake_attempt_at,
       metadata,profile_enabled,disabled_at)
     VALUES ($1,$1,'test',NULL,$2::jsonb,TRUE,NULL)
     ON CONFLICT(agent_id) DO UPDATE SET last_wake_attempt_at=NULL,
       metadata=EXCLUDED.metadata,profile_enabled=TRUE,disabled_at=NULL`,
    [a.agent_id,JSON.stringify({memory_project:'agent-comms-mcp',...(a.discord_id?{discord_id:a.discord_id}:{})})],
  )
  if (nativeModes.has(c) && port !== null && a.observed_provider === 'codex' && a.status !== 'offline') {
    await seedNativeRuntime(c, a, metadata.tmux_session as string)
    return
  }
  if (a.memoryReady === false || port === null) return

  // Non-native caller fixtures can enroll logical identity but cannot mint a
  // native memory receipt or claim that a provider process is running.
  const runtimeInstanceId = a.runtime_instance_id ?? randomUUID()
  await c.query(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_kind)
    VALUES($1,$2,'local_process') ON CONFLICT(runtime_instance_id) DO NOTHING`,[runtimeInstanceId,a.agent_id])
  const fixtureChannelId = `${TEST_PREFIX}channel-${a.agent_id}`
  await c.query(
    `INSERT INTO channels (id, name, type, members)
     VALUES ($1, $1, 'channel', ARRAY[$2]::text[])
     ON CONFLICT (id) DO UPDATE SET members=EXCLUDED.members`,
    [fixtureChannelId, a.agent_id],
  )
}

export interface SeedQueueRow {
  agent_id: string
  status?: 'pending' | 'received' | 'in_progress' | 'replied' | 'skipped' | 'failed'
  message_id?: string | null
  payload?: string
  claim_expires_at?: Date | null
  claimed_by?: string | null
  claimed_at?: Date | null
  created_at?: Date
  last_wake_attempt_at?: Date | null
  last_heartbeat_at?: Date | null
}

export async function seedQueueRow(c: Client, r: SeedQueueRow): Promise<number> {
  const messageIdExplicit = Object.prototype.hasOwnProperty.call(r, 'message_id')
  const messageId = messageIdExplicit ? r.message_id ?? null : randomUUID()
  if (messageId !== null) {
    const fixtureChannelId = `${TEST_PREFIX}channel-${r.agent_id}`
    await c.query(
      `INSERT INTO channels (id, name, type, members)
       VALUES ($1, $1, 'channel', ARRAY[$2]::text[])
       ON CONFLICT (id) DO UPDATE SET members=EXCLUDED.members`,
      [fixtureChannelId, r.agent_id],
    )
    await c.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source)
       VALUES ($1::uuid, $2, 'state-daemon-fixture', $3, 'instruction', 'state-daemon-fixture')
       ON CONFLICT (id) DO UPDATE SET channel_id=EXCLUDED.channel_id`,
      [messageId, fixtureChannelId, r.payload ?? 'state-daemon fixture work'],
    )
  }
  const res = await c.query(
    `INSERT INTO message_queue
       (agent_id, status, message_id, payload, claim_expires_at,
        claimed_by, claimed_at, created_at, last_wake_attempt_at, last_heartbeat_at,claimed_runtime_instance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10,$11)
     RETURNING id`,
    [
      r.agent_id,
      r.status ?? 'pending',
      messageId,
      r.payload ?? JSON.stringify({ message_type: 'instruction', content: 'state-daemon fixture work' }),
      r.claim_expires_at ?? null,
      r.claimed_by ?? null,
      r.claimed_at ?? null,
      r.created_at ?? null,
      r.last_wake_attempt_at ?? null,
      r.last_heartbeat_at ?? null,
      ['received','in_progress'].includes(r.status ?? 'pending') ? nativeModes.get(c)?.seats.get(r.agent_id)?.id ?? null : null,
    ],
  )
  return Number((res.rows as Array<{ id: number }>)[0].id)
}
