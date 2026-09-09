import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { execFileSync } from 'node:child_process'
import { Client } from 'pg'

/** SQL owns eligibility. These types/adapters do not invent per-surface rules. */
export interface AdmissionDb {
  query(sql: string, params?: any[]): Promise<any[] | { rows: any[] }>
}
export class AdmissionError extends Error {
  constructor(readonly code: string, detail = code) { super(detail); this.name = 'AdmissionError' }
}
export interface AuthorityRef { url: string; sha256: string }
export interface AdmissionConfig {
  policy_id: string
  agent_id: string
  max_tasks: 2
  max_inflight: 1
  invocation_max_attempts: 1
  finalizer_max_attempts: 1
  source_sha: string
  guard_digest: string
  cohort_digest: string
  runtime_id: string
  worker_timeout_seconds: number
  expires_at: string
  maker: string
  checker: string
  roles: { controller: string; executor: string; runtime: string }
  authority: AuthorityRef
  task_definitions: [TaskDefinition, TaskDefinition]
  no_affected_work_ref: AuthorityRef
  transport: BoundedTransportConfig
}
interface TaskDefinition { ref: string; sender: string; channel_id: string }
export interface AdmissionBinding { policyId: string; configDigest: string; sourceSha: string; cohortDigest: string; runtimeId: string }
export function admissionBindingFromEnv(env: Record<string, string | undefined>): AdmissionBinding | null {
  const keys = ['AUN_ADMISSION_POLICY_ID','AUN_ADMISSION_CONFIG_DIGEST','AUN_ADMISSION_SOURCE_SHA','AUN_ADMISSION_COHORT_DIGEST','AUN_ADMISSION_RUNTIME_ID'] as const
  if (keys.every(key => !env[key])) return null
  const [policyId,configDigest,sourceSha,cohortDigest,runtimeId] = keys.map(key => env[key])
  if (typeof policyId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(policyId)
    || typeof configDigest !== 'string' || !/^[0-9a-f]{64}$/.test(configDigest)
    || typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(sourceSha)
    || typeof cohortDigest !== 'string' || !/^[0-9a-f]{64}$/.test(cohortDigest) || !runtimeId
    || env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS || env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS || env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER
    || env.STATE_DAEMON_QUEUE_WORK_RECOVER_EXPIRED_SCHEDULER_CLAIM === '1'
    || env.STATE_DAEMON_QUEUE_WORK_RESUME_DONE_FINALIZATION === '1') throw new AdmissionError('ADMISSION_LOADED_CONFIG_INVALID')
  return { policyId, configDigest, sourceSha, cohortDigest, runtimeId }
}
export interface AdmissionState {
  policy: { policy_id: string; agent_id: string; revision: string | number; config_digest: string; config: AdmissionConfig; status: string; expires_at: string }
  tasks: Array<{ ordinal: number; queue_id: string | number; message_id: string; stage: string; claim_fence: Record<string, unknown> | null; result_digest: string | null; reply_id: string | null }>
}
export const admissionSha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

export interface BoundedTransportConfig {
  original_max_posts: 1; reply_max_posts: 3; waits_ms: [10000, 30000]
  post_timeout_ms: 10000; transport_horizon_ms: 120000
  persistence_max_writes: 5; persistence_window_ms: 20000
  receipt_dir: string; host: string
}
export interface BoundedDiscordRequest {
  delivery_id: string; channel_id: string; author_id: string
  body: { content: string; nonce: string; enforce_nonce: true
    allowed_mentions: { parse: Array<'users' | 'roles'>; replied_user: false }
    message_reference?: { message_id: string; channel_id: string; fail_if_not_exists: false } }
}
export interface BoundedOwner { token: string; pid: number; start: string; host: string; cohort: string }
export interface BoundedAck { message_id: string; channel_id: string; author_id: string; nonce: string; response_sha256: string }
export type BoundedProviderOutcome =
  | { kind: 'ACK'; ack: BoundedAck; wire_calls: number }
  | { kind: 'RETRYABLE'; reason: string; wire_calls: number; retry_after_ms: number; global: boolean }
  | { kind: 'NEEDS_ATTENTION'; reason: string; wire_calls: number }
export interface BoundedReceipt {
  version: 1; policy_id: string; config_digest: string; source_sha: string; cohort_digest: string
  delivery_id: string; request_digest: string; owner: BoundedOwner
  state: 'INTENT' | 'RETRYABLE' | 'ACK_PENDING_DB' | 'SENT' | 'NEEDS_ATTENTION'
  reservations: number; wire_calls: number; first_attempt_at: number; updated_at: number
  next_not_before: number | null; ack: BoundedAck | null; reason: string | null
  retry: { retry_after_ms: number; global: boolean; wire_calls: number } | null
  persistence: { started_at: number | null; writes: number; stage: 0 | 1 | 2; recovery_tokens: string[] }
  notice_pending: boolean
}
export interface BoundedClock { now(): number; monotonic(): number }
const boundedClock: BoundedClock = { now: Date.now, monotonic: () => performance.now() }
const shaPattern = /^[0-9a-f]{64}$/
const deliveryPattern = /^out-[1-9][0-9]{0,18}$/
const snowflakePattern = /^[1-9][0-9]{0,19}$/

/** Serialize in a fixed order; persisted request bytes, not caller object order, are pinned. */
export function boundedRequestBytes(r: BoundedDiscordRequest): string {
  if (!r || typeof r.delivery_id !== 'string' || !deliveryPattern.test(r.delivery_id)
    || typeof r.channel_id !== 'string' || !snowflakePattern.test(r.channel_id)
    || typeof r.author_id !== 'string' || !snowflakePattern.test(r.author_id)
    || !r.body || typeof r.body.content !== 'string' || Array.from(r.body.content).length > 2000 || !r.body.content.length
    || r.body.nonce !== r.delivery_id || r.body.enforce_nonce !== true
    || !r.body.allowed_mentions || r.body.allowed_mentions.replied_user !== false
    || JSON.stringify(r.body.allowed_mentions.parse) !== '["users","roles"]'
    || Object.keys(r).sort().join(',') !== 'author_id,body,channel_id,delivery_id'
    || Object.keys(r.body).sort().join(',') !== (r.body.message_reference ? 'allowed_mentions,content,enforce_nonce,message_reference,nonce' : 'allowed_mentions,content,enforce_nonce,nonce')
    || Object.keys(r.body.allowed_mentions).sort().join(',') !== 'parse,replied_user') throw new AdmissionError('ADMISSION_REQUEST_INVALID')
  const ref = r.body.message_reference
  if (ref && (Object.keys(ref).sort().join(',') !== 'channel_id,fail_if_not_exists,message_id'
    || typeof ref.message_id !== 'string' || !snowflakePattern.test(ref.message_id)
    || ref.channel_id !== r.channel_id || ref.fail_if_not_exists !== false)) throw new AdmissionError('ADMISSION_REQUEST_INVALID')
  return JSON.stringify({ delivery_id: r.delivery_id, channel_id: r.channel_id, author_id: r.author_id,
    body: { content: r.body.content, nonce: r.body.nonce, enforce_nonce: true,
      allowed_mentions: { parse: ['users','roles'], replied_user: false },
      ...(ref ? { message_reference: { message_id: ref.message_id, channel_id: ref.channel_id, fail_if_not_exists: false } } : {}) } })
}

export function validateBoundedTransport(c: unknown): asserts c is BoundedTransportConfig {
  const v = c as BoundedTransportConfig
  if (!v || Object.keys(v).sort().join(',') !== 'host,original_max_posts,persistence_max_writes,persistence_window_ms,post_timeout_ms,receipt_dir,reply_max_posts,transport_horizon_ms,waits_ms'
    || v.original_max_posts !== 1 || v.reply_max_posts !== 3 || JSON.stringify(v.waits_ms) !== '[10000,30000]'
    || v.post_timeout_ms !== 10000 || v.transport_horizon_ms !== 120000 || v.persistence_max_writes !== 5 || v.persistence_window_ms !== 20000
    || typeof v.receipt_dir !== 'string' || !isAbsolute(v.receipt_dir) || resolve(v.receipt_dir) !== v.receipt_dir
    || typeof v.host !== 'string' || !v.host.length) throw new AdmissionError('ADMISSION_TRANSPORT_CONFIG_INVALID')
}
export function currentBoundedOwner(cohort: string): BoundedOwner {
  const start = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()
  if (!start) throw new AdmissionError('ADMISSION_OWNER_IDENTITY_UNKNOWN')
  return { token: randomUUID(), pid: process.pid, start, host: hostname(), cohort }
}

/** No mkdir, chmod repair, TTL theft or unlink of a foreign lock. */
export class BoundedReceiptStore {
  private readonly directoryIdentity: string
  constructor(readonly directory: string, readonly owner: BoundedOwner) {
    this.directoryIdentity = this.checkDirectory()
  }
  private checkDirectory(): string {
    if (!isAbsolute(this.directory) || resolve(this.directory) !== this.directory || realpathSync(this.directory) !== this.directory
      || this.owner.host !== hostname() || !process.getuid) throw new AdmissionError('ADMISSION_RECEIPT_DIRECTORY_INVALID')
    let part = this.directory
    while (part !== dirname(part)) {
      if (lstatSync(part).isSymbolicLink()) throw new AdmissionError('ADMISSION_RECEIPT_DIRECTORY_INVALID')
      part = dirname(part)
    }
    const st = lstatSync(this.directory)
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) throw new AdmissionError('ADMISSION_RECEIPT_DIRECTORY_INVALID')
    return `${st.dev}:${st.ino}`
  }
  private path(id: string, suffix: 'json' | 'lock'): string {
    if (typeof id !== 'string' || !deliveryPattern.test(id) || this.checkDirectory() !== this.directoryIdentity) throw new AdmissionError('ADMISSION_RECEIPT_DIRECTORY_CHANGED')
    return join(this.directory, `${id}.${suffix}`)
  }
  private read(path: string): any {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o777) !== 0o600 || st.size > 16384 || st.nlink !== 1) throw new AdmissionError('ADMISSION_RECEIPT_INVALID')
      return JSON.parse(readFileSync(fd, 'utf8'))
    } finally { closeSync(fd) }
  }
  readReceipt(id: string): BoundedReceipt | null {
    let r: BoundedReceipt
    try { r = this.read(this.path(id, 'json')) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new AdmissionError('ADMISSION_RECEIPT_INVALID') }
    const keys = 'ack,cohort_digest,config_digest,delivery_id,first_attempt_at,next_not_before,notice_pending,owner,persistence,policy_id,reason,request_digest,reservations,retry,source_sha,state,updated_at,version,wire_calls'
    if (!r || Object.keys(r).sort().join(',') !== keys || r.version !== 1 || r.delivery_id !== id
      || typeof r.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(r.policy_id)
      || [r.config_digest,r.request_digest,r.cohort_digest].some(v=>typeof v!=='string'||!shaPattern.test(v))
      || typeof r.source_sha !== 'string' || !/^[0-9a-f]{40}$/.test(r.source_sha)
      || !r.owner || Object.keys(r.owner).sort().join(',') !== 'cohort,host,pid,start,token' || r.owner.cohort !== r.cohort_digest
      || typeof r.owner.token !== 'string' || !r.owner.token || !Number.isInteger(r.owner.pid) || r.owner.pid <= 0
      || typeof r.owner.start !== 'string' || !r.owner.start || typeof r.owner.host !== 'string' || !r.owner.host
      || !['INTENT','RETRYABLE','ACK_PENDING_DB','SENT','NEEDS_ATTENTION'].includes(r.state)
      || !Number.isInteger(r.reservations) || r.reservations < 1 || r.reservations > 3
      || !Number.isInteger(r.wire_calls) || r.wire_calls < 0 || r.wire_calls > r.reservations
      || !Number.isFinite(r.first_attempt_at) || !Number.isFinite(r.updated_at)
      || (r.next_not_before !== null && !Number.isFinite(r.next_not_before))
      || typeof r.notice_pending !== 'boolean' || (r.reason !== null && typeof r.reason !== 'string')
      || !r.persistence || Object.keys(r.persistence).sort().join(',') !== 'recovery_tokens,stage,started_at,writes'
      || ![0,1,2].includes(r.persistence.stage) || !Number.isInteger(r.persistence.writes) || r.persistence.writes < 0 || r.persistence.writes > 5
      || (r.persistence.started_at !== null && !Number.isFinite(r.persistence.started_at))
      || !Array.isArray(r.persistence.recovery_tokens) || r.persistence.recovery_tokens.some(t => typeof t !== 'string' || !t)
      || ((r.state === 'ACK_PENDING_DB' || r.state === 'SENT') && !r.ack)) throw new AdmissionError('ADMISSION_RECEIPT_INVALID')
    if(r.retry!==null && (!r.retry || Object.keys(r.retry).sort().join(',')!=='global,retry_after_ms,wire_calls'
      || !Number.isFinite(r.retry.retry_after_ms) || r.retry.retry_after_ms<0 || typeof r.retry.global!=='boolean'
      || ![0,1].includes(r.retry.wire_calls)))throw new AdmissionError('ADMISSION_RECEIPT_INVALID')
    if(r.state==='RETRYABLE'&&!r.retry)throw new AdmissionError('ADMISSION_RECEIPT_INVALID')
    if (r.ack && (Object.keys(r.ack).sort().join(',') !== 'author_id,channel_id,message_id,nonce,response_sha256'
      || [r.ack.message_id,r.ack.channel_id,r.ack.author_id].some(v=>typeof v!=='string'||!snowflakePattern.test(v))
      || r.ack.nonce !== id || typeof r.ack.response_sha256!=='string' || !shaPattern.test(r.ack.response_sha256))) throw new AdmissionError('ADMISSION_RECEIPT_INVALID')
    return r
  }
  lock(id: string): () => void {
    const path = this.path(id, 'lock')
    let fd: number
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (e) { throw new AdmissionError((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'ADMISSION_DELIVERY_OWNER_UNRESOLVED' : 'ADMISSION_RECEIPT_UNAVAILABLE') }
    try { writeFileSync(fd, JSON.stringify(this.owner)); fsyncSync(fd) } finally { closeSync(fd) }
    this.syncParent()
    return () => {
      if (this.read(this.path(id, 'lock')).token !== this.owner.token) throw new AdmissionError('ADMISSION_DELIVERY_OWNER_MISMATCH')
      unlinkSync(path); this.syncParent()
    }
  }
  /** Only explicit recovery, after independently sourced positive end evidence. */
  releaseEndedOwner(id: string, prior: BoundedOwner): void {
    if(prior.host!==hostname())throw new AdmissionError('ADMISSION_DELIVERY_OWNER_MISMATCH')
    const probe=Bun.spawnSync(['/bin/ps','-p',String(prior.pid),'-o','lstart='],{stdout:'pipe',stderr:'pipe'})
    if (probe.exitCode!==1 || probe.stdout.toString().trim()!=='') throw new AdmissionError('ADMISSION_PRIOR_OWNER_NOT_ENDED')
    const path=this.path(id,'lock')
    let actual: BoundedOwner
    try { actual=this.read(path) } catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return;throw e }
    if (JSON.stringify(actual)!==JSON.stringify(prior) || prior.host!==hostname()) throw new AdmissionError('ADMISSION_DELIVERY_OWNER_MISMATCH')
    unlinkSync(path);this.syncParent()
  }
  write(r: BoundedReceipt): void {
    const target = this.path(r.delivery_id, 'json')
    if (this.read(this.path(r.delivery_id, 'lock')).token !== this.owner.token) throw new AdmissionError('ADMISSION_DELIVERY_OWNER_MISMATCH')
    const raw = JSON.stringify(r)
    if (Buffer.byteLength(raw) > 16384) throw new AdmissionError('ADMISSION_RECEIPT_TOO_LARGE')
    // Validate any prior target before replacing it; never follow a symlink.
    try { this.read(target) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    const temp = join(this.directory, `${r.delivery_id}.${this.owner.token}.tmp`)
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, raw); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, target); this.syncParent()
  }
  private syncParent(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}

// Tokens are object identities minted only after a guarded DB provider check.
// JSON/CLI strings and a new object with the same fields are never capabilities.
export interface BoundedPostPermit { readonly kind: 'bounded-post-permit' }
const postPermits = new WeakMap<BoundedPostPermit, { digest: string; channel: string; deadline: number; start: number; latestStartDelay: number; clock: BoundedClock; calls: number }>()
export async function authorizeBoundedPost(db: AdmissionDb, row: any, request: BoundedDiscordRequest, owner: BoundedOwner,
  deadline: number, binding: AdmissionBinding, clock: BoundedClock = boundedClock): Promise<BoundedPostPermit> {
  const digest = admissionSha256(boundedRequestBytes(request))
  await admissionRows(db, 'SELECT public.aun_admission_outbound($1,$2,$3::jsonb)', [row.id,'provider_check',JSON.stringify({
    owner_token: owner.token, request_digest: digest, claimed_at: row.claimed_at,
    consumer_agent_id: row.consumer_agent_id ?? row.agent_id, source_sha: binding.sourceSha, cohort_digest: binding.cohortDigest,
  })])
  if (deadline - clock.now() < 10000) throw new AdmissionError('ADMISSION_DELIVERY_WINDOW_EXPIRED')
  const permit: BoundedPostPermit = Object.freeze({ kind: 'bounded-post-permit' })
  postPermits.set(permit, { digest, channel: request.channel_id, deadline, start: clock.monotonic(),
    latestStartDelay:Math.min(10000,deadline-clock.now()-10000), clock, calls: 0 })
  return permit
}
export function consumeBoundedPostPermit(permit: BoundedPostPermit, request: BoundedDiscordRequest, url: string, method: string): void {
  const p = postPermits.get(permit)
  if (!p || p.calls !== 0 || method !== 'POST' || url !== `https://discord.com/api/v10/channels/${p.channel}/messages`
    || p.digest !== admissionSha256(boundedRequestBytes(request)) || p.clock.now() + 10000 > p.deadline
    || p.clock.monotonic() - p.start < 0 || p.clock.monotonic() - p.start > p.latestStartDelay) throw new AdmissionError('ADMISSION_PROVIDER_PERMIT_DENIED')
  p.calls++
}
export function boundedWireCalls(permit: BoundedPostPermit): number { return postPermits.get(permit)?.calls ?? 0 }
export function boundedRetryAfter(header: string | null, body: unknown): number | null {
  const values = [header, body].filter(x => x !== null && x !== undefined)
  if (!values.length) return null
  if (values.some(x => !['string','number'].includes(typeof x) || String(x).trim() === '' || !Number.isFinite(Number(x)) || Number(x) < 0)) return null
  return Math.max(...values.map(x => Math.ceil(Number(x) * 1000)))
}

export interface BoundedDiscordPort {
  prepareBoundedRequest(row: any): Promise<BoundedDiscordRequest>
  sendBoundedRequest(request: BoundedDiscordRequest, permit: BoundedPostPermit): Promise<BoundedProviderOutcome>
}
function outboundDiagnostic(row: any): any {
  const entries = row.delivery_diagnostics?.filter((d: any) => d?.code === 'AUN_BOUNDED_ADMISSION')
  if (entries?.length !== 1) throw new AdmissionError('ADMISSION_DIAGNOSTICS_INVALID')
  return entries[0]
}
async function outboundTransition(db: AdmissionDb, row: any, action: string, input: Record<string, unknown>): Promise<any> {
  const rows = await admissionRows(db, 'SELECT public.aun_admission_outbound($1,$2,$3::jsonb) AS row',
    [row.id,action,JSON.stringify(input)])
  if (!rows[0]?.row) throw new AdmissionError('ADMISSION_STATE_MISSING')
  return rows[0].row
}
const persistenceSchedule = [0,1000,3000,7000,15000]
/** One existing tick, never a new retry loop/timer. Journal budgets precede writes. */
async function persistBoundedReceipt(db: AdmissionDb, row: any, receipt: BoundedReceipt, store: BoundedReceiptStore,
  clock: BoundedClock, recoveryToken?: string): Promise<BoundedReceipt> {
  const p = receipt.persistence
  if (receipt.state === 'SENT' && p.stage === 2 && !receipt.notice_pending) return receipt
  if (!receipt.ack && !receipt.notice_pending) return receipt
  if (p.started_at === null) p.started_at = clock.now()
  const elapsed = clock.now() - p.started_at
  if (elapsed < 0) return receipt // Backward clock never shortens the persisted deadline.
  if (p.writes >= 5 || elapsed >= 20000) {
    receipt.state = 'NEEDS_ATTENTION';receipt.reason = 'PERSISTENCE_BUDGET_EXHAUSTED';receipt.notice_pending = true
    store.write(receipt);return receipt
  }
  if (elapsed < persistenceSchedule[p.writes]) return receipt
  // Observe connection health before consuming a write; failure is pause, not unsent.
  try { await admissionRows(db,'SELECT 1') } catch { return receipt }
  p.writes++;receipt.updated_at=clock.now();store.write(receipt)
  try {
    // SET LOCAL lives only in this short statement's explicit transaction; a
    // lost response is reconciled by the idempotent same-stage next write.
    await admissionRows(db,'BEGIN')
    try {
      await admissionRows(db,"SET LOCAL statement_timeout='1s'")
      await admissionRows(db,"SET LOCAL lock_timeout='1s'")
      const budget={persistence:{started_at:new Date(p.started_at!).toISOString(),writes:p.writes},
        ...(recoveryToken?{recovery_token:recoveryToken}:{})}
      if (receipt.ack && p.stage === 0) {
        await outboundTransition(db,row,'sent',{ack:receipt.ack,owner_token:receipt.owner.token,
          request_digest:receipt.request_digest,total_wire_calls:receipt.wire_calls,...budget})
      } else if (receipt.ack && p.stage === 1) {
        await outboundTransition(db,row,'backfill',{provider_message_id:receipt.ack.message_id,...budget})
      } else if (receipt.notice_pending) {
        await outboundTransition(db,row,'halt',{reason:receipt.reason ?? 'DELIVERY_UNCONFIRMED',...budget})
      } else throw new AdmissionError('ADMISSION_PERSISTENCE_STAGE_INVALID')
      await admissionRows(db,'COMMIT')
    } catch (e) { await admissionRows(db,'ROLLBACK').catch(()=>{});throw e }
    if (receipt.ack && p.stage < 2) {
      p.stage = (p.stage + 1) as 1 | 2
      if (p.stage === 2 && !receipt.notice_pending) receipt.state='SENT'
    } else receipt.notice_pending=false
    receipt.updated_at=clock.now();store.write(receipt)
  } catch {
    // Known ACK stays latched. Do not feed this into provider classification.
    // The prewrite journal survives even if the DB commit response was lost.
  }
  return receipt
}

/** Host-only bounded delivery. No ordinary adapter call/fallback is reachable here. */
export async function deliverBoundedOutbound(input: {
  db: AdmissionDb; row: any; binding: AdmissionBinding; adapter: BoundedDiscordPort
  clock?: BoundedClock; owner?: BoundedOwner
}): Promise<{ status: string; reserved: number; observed_wire_calls: number; reason?: string }> {
  const { db,binding,adapter }=input
  const clock=input.clock ?? boundedClock
  const state=await readAdmissionBinding(db,binding)
  validateBoundedTransport(state.policy.config.transport)
  const owner=input.owner ?? currentBoundedOwner(binding.cohortDigest)
  if (owner.host !== state.policy.config.transport.host || owner.cohort !== binding.cohortDigest) throw new AdmissionError('ADMISSION_OWNER_IDENTITY_MISMATCH')
  const store=new BoundedReceiptStore(state.policy.config.transport.receipt_dir,owner)
  const id=`out-${input.row.id}`
  const release=store.lock(id)
  let noMorePost=false
  let observedReservations=0,observedWireCalls=0
  try {
    // Preserve PostgreSQL's full claim timestamp precision across restart.
    // pg's default timestamptz→Date decoder truncates the microsecond fence.
    let row=(await admissionRows(db,'SELECT to_jsonb(o) AS row FROM public.outbound_queue o WHERE id=$1',[input.row.id]))[0]?.row
    if (!row) throw new AdmissionError('ADMISSION_OUTBOUND_NOT_BOUND')
    let diag=outboundDiagnostic(row)
    let receipt=store.readReceipt(id)
    observedReservations=row.attempts;observedWireCalls=receipt?.wire_calls??0
    if (diag.policy_id!==binding.policyId || diag.config_digest!==binding.configDigest) throw new AdmissionError('ADMISSION_LOADED_CONFIG_MISMATCH')
    if (receipt && (receipt.policy_id!==binding.policyId || receipt.config_digest!==binding.configDigest
      || receipt.cohort_digest!==binding.cohortDigest || receipt.source_sha!==binding.sourceSha
      || receipt.request_digest!==diag.request_digest || receipt.reservations!==row.attempts)) throw new AdmissionError('ADMISSION_RECEIPT_BINDING_MISMATCH')
    if (receipt?.ack) {
      noMorePost=true
      const persisted=await persistBoundedReceipt(db,row,receipt,store,clock)
      return {status:persisted.state,reserved:row.attempts,observed_wire_calls:persisted.wire_calls}
    }
    if (receipt?.state==='NEEDS_ATTENTION') {
      const persisted=await persistBoundedReceipt(db,row,receipt,store,clock)
      return {status:persisted.state,reserved:row.attempts,observed_wire_calls:persisted.wire_calls}
    }
    if(receipt?.state==='RETRYABLE' && diag.outcome==='INTENT' && receipt.retry){
      // A durable classified outcome survived, but its DB update did not.
      // Reconcile that same attempt before allowing a subsequent reservation.
      row=await outboundTransition(db,row,'retry',{owner_token:receipt.owner.token,request_digest:receipt.request_digest,
        claimed_at:row.claimed_at,...receipt.retry,reason:receipt.reason})
      diag=outboundDiagnostic(row)
      receipt.next_not_before=Math.max(receipt.next_not_before!,Date.parse(diag.next_not_before));store.write(receipt)
    }
    if (row.attempts>0 && (!receipt || receipt.state!=='RETRYABLE' || diag.outcome!=='RETRYABLE')) {
      // A missing terminal outcome is not evidence the provider did not send.
      await outboundTransition(db,row,'halt',{reason:'DELIVERY_OUTCOME_UNKNOWN'})
      return {status:'NEEDS_ATTENTION',reserved:row.attempts,observed_wire_calls:receipt?.wire_calls ?? 0,reason:'DELIVERY_OUTCOME_UNKNOWN'}
    }
    const now=clock.now()
    if(state.policy.status!=='ENABLED'||Date.parse(state.policy.expires_at)<=now)throw new AdmissionError('ADMISSION_DENIED')
    if (receipt && (now<receipt.updated_at || now<(receipt.next_not_before ?? Infinity))) return {status:'RETRY_WAIT',reserved:row.attempts,observed_wire_calls:receipt.wire_calls}
    let request: BoundedDiscordRequest
    if (diag.request_bytes) request=JSON.parse(diag.request_bytes)
    else {
      try{request=await adapter.prepareBoundedRequest(row)}catch(error){
        if(error instanceof AdmissionError && ['ADMISSION_ATTACHMENTS_UNSUPPORTED','ADMISSION_REQUEST_INVALID',
          'ADMISSION_DESTINATION_UNRESOLVED','ADMISSION_MENTIONS_UNRESOLVED','ADMISSION_PROVIDER_IDENTITY_MISMATCH'].includes(error.code)){
          await outboundTransition(db,row,'halt',{reason:error.code})
          return {status:'NEEDS_ATTENTION',reserved:row.attempts,observed_wire_calls:0,reason:error.code}
        }
        throw error
      }
      const bytes=boundedRequestBytes(request)
      row=await outboundTransition(db,row,'freeze',{consumer_agent_id:row.consumer_agent_id??row.agent_id,
        source_sha:binding.sourceSha,cohort_digest:binding.cohortDigest,request_bytes:bytes,request_digest:admissionSha256(bytes)})
      diag=outboundDiagnostic(row)
    }
    const bytes=boundedRequestBytes(request)
    if (admissionSha256(bytes)!==diag.request_digest) throw new AdmissionError('ADMISSION_REQUEST_CHANGED')
    const deadline=Math.min(Date.parse(state.policy.expires_at), (receipt?.first_attempt_at ?? now)+120000)
    if (row.attempts>=row.max_attempts || now+10000>deadline) {
      await outboundTransition(db,row,'halt',{reason:'DELIVERY_BUDGET_OR_WINDOW_EXHAUSTED'})
      return {status:'NEEDS_ATTENTION',reserved:row.attempts,observed_wire_calls:receipt?.wire_calls??0}
    }
    row=await outboundTransition(db,row,'claim',{consumer_agent_id:row.consumer_agent_id??row.agent_id,source_sha:binding.sourceSha,
      cohort_digest:binding.cohortDigest,owner_token:owner.token,owner_host:owner.host,owner_pid:owner.pid,owner_start:owner.start})
    diag=outboundDiagnostic(row)
    observedReservations=row.attempts
    receipt={version:1,policy_id:binding.policyId,config_digest:binding.configDigest,source_sha:binding.sourceSha,
      cohort_digest:binding.cohortDigest,delivery_id:id,request_digest:diag.request_digest,owner,state:'INTENT',
      reservations:row.attempts,wire_calls:receipt?.wire_calls??0,first_attempt_at:Date.parse(diag.first_attempt_at),
      updated_at:clock.now(),next_not_before:null,ack:null,reason:null,retry:null,notice_pending:false,
      persistence:{started_at:null,writes:0,stage:0,recovery_tokens:[]}}
    store.write(receipt) // Failure here cannot reach the provider; reservation is retained.
    const permit=await authorizeBoundedPost(db,row,request,owner,deadline,binding,clock)
    let outcome: BoundedProviderOutcome
    try { outcome=await adapter.sendBoundedRequest(request,permit) }
    catch { outcome={kind:'NEEDS_ATTENTION',reason:'PROVIDER_OUTCOME_UNKNOWN',wire_calls:boundedWireCalls(permit)} }
    receipt.wire_calls+=boundedWireCalls(permit);receipt.updated_at=clock.now()
    observedWireCalls=receipt.wire_calls
    if (outcome.wire_calls!==boundedWireCalls(permit)) outcome={kind:'NEEDS_ATTENTION',reason:'PROVIDER_WIRE_COUNT_MISMATCH',wire_calls:boundedWireCalls(permit)}
    if (outcome.kind==='ACK') {
      noMorePost=true;receipt.ack=outcome.ack;receipt.state='ACK_PENDING_DB'
      store.write(receipt)
      const persisted=await persistBoundedReceipt(db,row,receipt,store,clock)
      return {status:persisted.state,reserved:row.attempts,observed_wire_calls:receipt.wire_calls}
    }
    if (outcome.kind==='RETRYABLE' && row.attempts<row.max_attempts && diag.kind==='reply') {
      const due=clock.now()+Math.max(row.attempts===1?10000:30000,outcome.retry_after_ms)
      if (due+10000<=deadline && Number.isFinite(due)) {
        receipt.state='RETRYABLE';receipt.reason=outcome.reason;receipt.next_not_before=due
        receipt.retry={retry_after_ms:outcome.retry_after_ms,global:outcome.global,wire_calls:outcome.wire_calls};store.write(receipt)
        try {
          row=await outboundTransition(db,row,'retry',{owner_token:owner.token,request_digest:receipt.request_digest,
            claimed_at:row.claimed_at,wire_calls:outcome.wire_calls,retry_after_ms:outcome.retry_after_ms,global:outcome.global,reason:outcome.reason})
          receipt.next_not_before=Math.max(due,Date.parse(outboundDiagnostic(row).next_not_before));store.write(receipt)
        } catch { /* DB outage retains the journal and never treats INTENT as retry permission. */ }
        return {status:'RETRY_WAIT',reserved:row.attempts,observed_wire_calls:receipt.wire_calls}
      }
    }
    receipt.state='NEEDS_ATTENTION';receipt.reason=outcome.kind==='NEEDS_ATTENTION'?outcome.reason:'DELIVERY_RETRY_EXHAUSTED'
    receipt.notice_pending=true;store.write(receipt)
    await persistBoundedReceipt(db,row,receipt,store,clock)
    return {status:'NEEDS_ATTENTION',reserved:row.attempts,observed_wire_calls:receipt.wire_calls,reason:receipt.reason!}
  } catch (error) {
    // No fallback after any bounded failure, especially after a known ACK.
    if (noMorePost) return {status:'ACK_STORAGE_UNKNOWN',reserved:observedReservations,observed_wire_calls:observedWireCalls}
    throw error
  } finally { release() }
}

export interface BoundedRecoveryRef {
  policy_id: string; delivery_id: string; receipt_sha256: string; request_digest: string; source_head: string
  recovery_token: string; max_writes: 5; window_ms: 20000; authority_url: string; authority_sha256: string
  prior_owner_end_evidence: { owner: BoundedOwner; ref: AuthorityRef }
}
function publishedRecords(body: string): any[] {
  const records: any[]=[]
  const visit=(v:any)=>{if(v&&typeof v==='object'){records.push(v);for(const x of Object.values(v))visit(x)}}
  for(const match of body.matchAll(/```json\s*([\s\S]*?)```/g)){try{visit(JSON.parse(match[1]))}catch{}}
  try{visit(JSON.parse(body))}catch{}
  return records
}
/** Explicit controller recovery; no provider/worker reference exists in this function. */
export async function recoverBoundedReceipt(input: {
  db: AdmissionDb; state: AdmissionState; deliveryId: string; receiptPath: string; recovery: unknown
  readBody: (ref:AuthorityRef)=>Promise<string>; dryRun: boolean
  clock?: BoundedClock; sleep?: (ms:number)=>Promise<void>
}): Promise<Record<string,unknown>> {
  const r=input.recovery as BoundedRecoveryRef
  const expected='authority_sha256,authority_url,delivery_id,max_writes,policy_id,prior_owner_end_evidence,receipt_sha256,recovery_token,request_digest,source_head,window_ms'
  if (!r || Object.keys(r).sort().join(',')!==expected || r.policy_id!==input.state.policy.policy_id
    || r.delivery_id!==input.deliveryId || !deliveryPattern.test(r.delivery_id) || r.max_writes!==5 || r.window_ms!==20000
    || typeof r.recovery_token!=='string' || !/^[A-Za-z0-9_-]{1,120}$/.test(r.recovery_token)
    || typeof r.receipt_sha256!=='string' || !shaPattern.test(r.receipt_sha256)
    || typeof r.request_digest!=='string' || !shaPattern.test(r.request_digest)
    || r.source_head!==input.state.policy.config.source_sha || !r.prior_owner_end_evidence
    || Object.keys(r.prior_owner_end_evidence).sort().join(',')!=='owner,ref') throw new AdmissionError('ADMISSION_RECOVERY_INVALID')
  const clock=input.clock??boundedClock
  const authority={url:r.authority_url,sha256:r.authority_sha256}
  await verifyAuthorityRef(input.state.policy.config.authority,input.readBody)
  await verifyAuthorityRef(authority,input.readBody)
  await verifyAuthorityRef(r.prior_owner_end_evidence.ref,input.readBody)
  const records=publishedRecords(await input.readBody(authority))
  const granted=records.find(v=>v.decision==='APPROVED' && v.action==='persist-receipt' && v.policy_id===r.policy_id
    && v.delivery_id===r.delivery_id && v.request_digest===r.request_digest && v.receipt_sha256===r.receipt_sha256
    && v.source_head===r.source_head && v.recovery_token===r.recovery_token && v.max_writes===5 && v.window_ms===20000
    && typeof v.expires_at==='string' && Date.parse(v.expires_at)>clock.now())
  if(!granted)throw new AdmissionError('ADMISSION_RECOVERY_AUTHORITY_MISMATCH')
  const endRecords=publishedRecords(await input.readBody(r.prior_owner_end_evidence.ref))
  const prior=r.prior_owner_end_evidence.owner
  if(!prior || prior.host!==hostname() || prior.cohort!==input.state.policy.config.cohort_digest
    || !endRecords.some(v=>v.ended===true && v.host===prior.host && v.pid===prior.pid && v.start===prior.start
      && typeof v.ended_at==='string' && Date.parse(v.ended_at)<=clock.now())) throw new AdmissionError('ADMISSION_PRIOR_OWNER_END_EVIDENCE_INVALID')
  const store=new BoundedReceiptStore(input.state.policy.config.transport.receipt_dir,currentBoundedOwner(prior.cohort))
  if(input.receiptPath!==join(store.directory,`${r.delivery_id}.json`))throw new AdmissionError('ADMISSION_RECEIPT_PATH_MISMATCH')
  const receipt=store.readReceipt(r.delivery_id)
  if(!receipt || admissionSha256(readFileSync(input.receiptPath))!==r.receipt_sha256 || receipt.request_digest!==r.request_digest
    || receipt.config_digest!==input.state.policy.config_digest
    || ['host','pid','start','cohort'].some(k=>receipt.owner[k as keyof BoundedOwner]!==prior[k as keyof BoundedOwner])
    || receipt.persistence.recovery_tokens.includes(r.recovery_token))throw new AdmissionError('ADMISSION_RECEIPT_BINDING_MISMATCH')
  if(!receipt.ack && !receipt.notice_pending)throw new AdmissionError('ADMISSION_RECOVERY_NO_DURABLE_OUTCOME')
  const row=(await admissionRows(input.db,'SELECT to_jsonb(o) AS row FROM public.outbound_queue o WHERE id=$1',[r.delivery_id.slice(4)]))[0]?.row
  if(!row || outboundDiagnostic(row).request_digest!==r.request_digest)throw new AdmissionError('ADMISSION_RECEIPT_BINDING_MISMATCH')
  if(input.dryRun)return {status:'UNEXECUTED',action:'persist-receipt',delivery_id:r.delivery_id,effect_count:0}
  // One prior-end record and a fresh process observation are both required.
  store.releaseEndedOwner(r.delivery_id,prior)
  const release=store.lock(r.delivery_id)
  try{
    receipt.persistence={...receipt.persistence,started_at:clock.now(),writes:0,
      recovery_tokens:[...receipt.persistence.recovery_tokens,r.recovery_token]}
    store.write(receipt) // Tokens remain consumed even when the following DB response is lost.
    await outboundTransition(input.db,row,'recover_receipt',{expected_digest:input.state.policy.config_digest,
      expected_revision:String(input.state.policy.revision),source_sha:r.source_head,recovery_token:r.recovery_token,
      receipt_sha256:r.receipt_sha256,request_digest:r.request_digest,authority_url:r.authority_url,authority_sha256:r.authority_sha256,
      authority_expires_at:granted.expires_at,persistence_started_at:new Date(receipt.persistence.started_at!).toISOString()})
    const sleep=input.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)))
    for(let n=0;n<5;n++){
      if(clock.now()>=Date.parse(granted.expires_at))break
      const before=receipt.persistence.writes
      await persistBoundedReceipt(input.db,row,receipt,store,clock,r.recovery_token)
      if(receipt.persistence.stage===2&&!receipt.notice_pending)break
      if(receipt.persistence.writes===before)break // DB unavailable pauses, not a retry loop.
      const next=persistenceSchedule[receipt.persistence.writes]
      if(next===undefined)break
      const delay=receipt.persistence.started_at!+next-clock.now()
      if(delay>0)await sleep(delay)
    }
    return {status:receipt.state,delivery_id:r.delivery_id,persistence_writes:receipt.persistence.writes,
      provider_post_delta:0,task_invocation_delta:0,notice_pending:receipt.notice_pending}
  }finally{release()}
}
/** Identifiers are code-owned, never CLI input. Catalog-only: safe before install. */
export function unboundedQueuePredicate(column: string, dialect?: string): string {
  if (!/^(?:[a-z_]+\.)?agent_id$/.test(column)) throw new AdmissionError('ADMISSION_SQL_IDENTIFIER_INVALID')
  if (dialect !== 'postgres') return '1=1'
  return `NOT EXISTS (SELECT 1 FROM pg_trigger ba_t JOIN pg_proc ba_f ON ba_f.oid=ba_t.tgfoid
    WHERE ba_t.tgrelid='public.message_queue'::regclass AND NOT ba_t.tgisinternal
      AND ba_f.proname='aun_admission_queue_guard' AND ba_f.pronamespace='public'::regnamespace
      AND split_part(encode(ba_t.tgargs,'escape'), E'\\\\000',1)=${column})`
}
export function unboundedOutboundPredicate(alias = 'outbound_queue', dialect = 'postgres'): string {
  if (!/^[a-z_]+$/.test(alias)) throw new AdmissionError('ADMISSION_SQL_IDENTIFIER_INVALID')
  if (dialect !== 'postgres') return '1=1'
  return `NOT (${alias}.delivery_diagnostics @> '[{"code":"AUN_BOUNDED_ADMISSION"}]'::jsonb)
    AND NOT EXISTS(SELECT 1 FROM public.agent_messages ba_m JOIN public.message_queue ba_q
      ON ba_q.message_id IN (ba_m.id::text,ba_m.reply_to::text)
      WHERE ba_m.id::text=${alias}.message_id AND NOT (${unboundedQueuePredicate('ba_q.agent_id','postgres')}))`
}
export function isBoundedOutbound(row: any): boolean {
  return Array.isArray(row?.delivery_diagnostics) && row.delivery_diagnostics.some((d: any) => d?.code === 'AUN_BOUNDED_ADMISSION')
}
export async function boundedOutboundEffect(db: AdmissionDb, row: any, action: 'sent' | 'halt' | 'backfill', input: Record<string, unknown>): Promise<void> {
  await admissionRows(db, 'SELECT public.aun_admission_outbound($1,$2,$3::jsonb)', [row.id,action,JSON.stringify({ ...input, claimed_at: row.claimed_at })])
}
/** Selection is read-only. Lock/journal/freeze must precede the guarded reservation. */
export async function selectBoundedOutbound(db: AdmissionDb, consumerAgentId: string, env: NodeJS.ProcessEnv = process.env): Promise<any | null> {
  const binding=admissionBindingFromEnv(env)
  if (!binding) return null
  const state=await readAdmissionBinding(db,binding)
  if(!state.tasks.length)return null
  const rows=await admissionRows(db,`SELECT o.* FROM public.outbound_queue o,
    LATERAL jsonb_array_elements(o.delivery_diagnostics) d
    WHERE COALESCE(o.consumer_agent_id,o.agent_id)=$1 AND d->>'code'='AUN_BOUNDED_ADMISSION'
      AND d->>'policy_id'=$2 AND d->>'config_digest'=$3
      AND d->>'original_queue_id'=ANY($4::text[])
      AND ($5::boolean OR o.attempts>0)
      AND d->>'outcome' IS DISTINCT FROM 'NEEDS_ATTENTION'
      AND COALESCE(d->>'backfill_complete','false')<>'true'
      AND (o.next_retry_at IS NULL OR o.next_retry_at<=clock_timestamp())
    ORDER BY o.created_at,o.id LIMIT 1`,[consumerAgentId,binding.policyId,binding.configDigest,state.tasks.map(t=>String(t.queue_id)),state.policy.status==='ENABLED'])
  return rows[0]??null
}
export async function admissionRows(db: AdmissionDb, sql: string, params: any[] = []): Promise<any[]> {
  try { const result = await db.query(sql, params); return Array.isArray(result) ? result : result.rows }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = message.match(/\bADMISSION_[A-Z_]+\b/)?.[0]
    if (code) throw new AdmissionError(code)
    if (sql.includes('aun_admission_') && ['42883','42P01'].includes(String((error as any)?.code))) throw new AdmissionError('ADMISSION_STORAGE_UNSUPPORTED')
    throw error
  }
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
export function assertAuthorityRef(ref: unknown): asserts ref is AuthorityRef {
  if (!ref || typeof ref !== 'object') throw new AdmissionError('ADMISSION_AUTHORITY_REQUIRED')
  const r = ref as AuthorityRef
  if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256) || typeof r.url !== 'string'
    || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+#issuecomment-\d+$/.test(r.url)) {
    throw new AdmissionError('ADMISSION_AUTHORITY_INVALID')
  }
}
/** Reads the exact published comment body; no implicit PR head or stale cache. */
export async function verifyAuthorityRef(ref: AuthorityRef, readBody: (ref: AuthorityRef) => Promise<string>): Promise<void> {
  assertAuthorityRef(ref)
  if (admissionSha256(await readBody(ref)) !== ref.sha256) throw new AdmissionError('ADMISSION_AUTHORITY_DIGEST_MISMATCH')
}
export function validateAdmissionConfig(value: unknown): asserts value is AdmissionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdmissionError('ADMISSION_CONFIG_INVALID')
  const c = value as AdmissionConfig
  if (!nonempty(c.policy_id) || !/^[A-Za-z0-9_-]{1,120}$/.test(c.policy_id)
    || !nonempty(c.agent_id) || !/^[A-Za-z0-9_-]{1,80}$/.test(c.agent_id)
    || c.max_tasks !== 2 || c.max_inflight !== 1 || c.invocation_max_attempts !== 1 || c.finalizer_max_attempts !== 1
    || typeof c.source_sha !== 'string' || !/^[0-9a-f]{40}$/.test(c.source_sha)
    || typeof c.guard_digest !== 'string' || !/^[0-9a-f]{64}$/.test(c.guard_digest)
    || typeof c.cohort_digest !== 'string' || !/^[0-9a-f]{64}$/.test(c.cohort_digest)
    || !nonempty(c.runtime_id) || !Number.isInteger(c.worker_timeout_seconds) || c.worker_timeout_seconds <= 0
    || !Number.isFinite(Date.parse(c.expires_at)) || !nonempty(c.maker) || !nonempty(c.checker) || c.maker === c.checker
    || !Array.isArray(c.task_definitions) || c.task_definitions.length !== 2
    || c.task_definitions.some(d => !d || !nonempty(d.ref) || !nonempty(d.sender) || !nonempty(d.channel_id))
    || !c.roles || Object.keys(c.roles).sort().join(',') !== 'controller,executor,runtime'
    || Object.values(c.roles).some(r => !nonempty(r)) || new Set(Object.values(c.roles)).size !== 3) {
    throw new AdmissionError('ADMISSION_CONFIG_INVALID')
  }
  assertAuthorityRef(c.authority)
  assertAuthorityRef(c.no_affected_work_ref)
  validateBoundedTransport(c.transport)
}
export async function admissionInstalled(db: AdmissionDb, dialect?: string): Promise<boolean> {
  if (dialect === 'sqlite') return false
  const rows = await admissionRows(db, "SELECT to_regprocedure('public.aun_admission_agent_status(text)') IS NOT NULL AS installed")
  return rows[0]?.installed === true
}
export async function admissionForAgent(db: AdmissionDb, agentId: string): Promise<AdmissionState | null> {
  const scoped = await admissionRows(db, `SELECT EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid='public.message_queue'::regclass
    AND NOT t.tgisinternal AND t.tgfoid='public.aun_admission_queue_guard()'::regprocedure
    AND split_part(encode(t.tgargs,'escape'), E'\\\\000', 1)=$1) AS protected`, [agentId])
  if (scoped[0]?.protected !== true) return null
  const rows = await admissionRows(db, 'SELECT public.aun_admission_agent_status($1) AS state', [agentId])
  if (!rows[0]?.state) throw new AdmissionError('ADMISSION_POLICY_NOT_VISIBLE')
  return rows[0].state
}
export async function tryBoundedClaim(db: AdmissionDb, agentId: string, opts: {
  dialect?: string; env?: NodeJS.ProcessEnv; queueId?: string; dryRun?: boolean
} = {}): Promise<Record<string, any> | null> {
  const env = opts.env ?? process.env
  const binding = admissionBindingFromEnv(env)
  if (!await admissionInstalled(db, opts.dialect)) {
    if (binding) throw new AdmissionError('ADMISSION_STORAGE_UNSUPPORTED')
    return null
  }
  const state = binding ? await readAdmissionBinding(db,binding,agentId) : await admissionForAgent(db, agentId)
  if (!state) return null
  if (env.AUN_ADMISSION_POLICY_ID !== state.policy.policy_id || env.AUN_ADMISSION_CONFIG_DIGEST !== state.policy.config_digest
    || env.AUN_ADMISSION_SOURCE_SHA !== state.policy.config.source_sha || env.AUN_ADMISSION_COHORT_DIGEST !== state.policy.config.cohort_digest) {
    throw new AdmissionError('ADMISSION_LOADED_CONFIG_MISMATCH')
  }
  const task = state.tasks.find(t => t.stage === 'ENROLLED' && (!opts.queueId || String(t.queue_id) === opts.queueId))
  if (!task) throw new AdmissionError('ADMISSION_NO_ENROLLED_TASK')
  if (opts.dryRun) return { ok: true, dry_run: true, mode: 'bounded-admission', queue_id: String(task.queue_id), claimed: false, effect_count: 0 }
  await admissionTransition(db, state, 'claim', { ordinal: task.ordinal, runtime_id: env.AUN_ADMISSION_RUNTIME_ID,
    source_sha: env.AUN_ADMISSION_SOURCE_SHA, cohort_digest: env.AUN_ADMISSION_COHORT_DIGEST })
  const [row] = await admissionRows(db, 'SELECT id,agent_id,message_id,payload,status,claimed_by,claimed_at::text,claim_expires_at::text FROM message_queue WHERE id=$1', [task.queue_id])
  if (!row || row.status !== 'received') throw new AdmissionError('ADMISSION_CLAIM_READBACK_MISMATCH')
  const payload = JSON.parse(row.payload)
  return { ...payload, ok: true, mode: 'bounded-admission', waiting: 0, queue_id: String(row.id), message_id: row.message_id,
    claimed_by: row.claimed_by, claimed_at: row.claimed_at, claim_expires_at: row.claim_expires_at }
}
export async function admissionStatus(db: AdmissionDb, policyId: string): Promise<AdmissionState | null> {
  const rows = await admissionRows(db, 'SELECT public.aun_admission_status($1) AS state', [policyId])
  return rows[0]?.state ?? null
}
/** Read-only loaded-source/guard/target join. It grants no execution authority. */
export async function readAdmissionBinding(db: AdmissionDb, binding: AdmissionBinding, agentId?: string): Promise<AdmissionState> {
  const [capability] = await admissionRows(db, 'SELECT public.aun_admission_capability() AS capability')
  if (capability?.capability?.revision !== '2026-09-08.v1' || capability.capability.postgres_version < 170000) throw new AdmissionError('ADMISSION_STORAGE_UNSUPPORTED')
  const state = await admissionStatus(db, binding.policyId)
  if (!state || state.policy.config_digest !== binding.configDigest || state.policy.config.source_sha !== binding.sourceSha
    || state.policy.config.cohort_digest !== binding.cohortDigest || state.policy.config.runtime_id !== binding.runtimeId
    || state.policy.config.guard_digest !== capability.capability.guard_digest || (agentId && state.policy.agent_id !== agentId)) {
    throw new AdmissionError('ADMISSION_LOADED_CONFIG_MISMATCH')
  }
  const guards = await admissionRows(db, `SELECT count(*)::integer AS n, bool_and(t.tgenabled='O') AS enabled
    FROM pg_trigger t JOIN pg_proc f ON f.oid=t.tgfoid
    WHERE t.tgrelid IN ('public.message_queue'::regclass,'public.agent_messages'::regclass,'public.outbound_queue'::regclass)
      AND NOT t.tgisinternal AND f.pronamespace='public'::regnamespace AND f.proname IN
        ('aun_admission_queue_guard','aun_admission_transport_guard','aun_admission_commit_guard')
      AND split_part(encode(t.tgargs,'escape'), E'\\\\000',1)=$1
      AND split_part(encode(t.tgargs,'escape'), E'\\\\000',2)=$2`, [state.policy.agent_id,binding.policyId])
  if (guards[0]?.n !== 6 || guards[0]?.enabled !== true) throw new AdmissionError('ADMISSION_GUARD_DRIFT')
  return state
}
export async function sealBoundedMessage(db: AdmissionDb, messageId: string, dialect?: string): Promise<void> {
  if (!await admissionInstalled(db, dialect)) return
  const scoped = await admissionRows(db, `SELECT EXISTS(SELECT FROM pg_trigger t CROSS JOIN public.agent_messages m
    WHERE t.tgrelid='public.message_queue'::regclass AND NOT t.tgisinternal
    AND t.tgfoid='public.aun_admission_queue_guard()'::regprocedure AND m.id::text=$1
    AND (m.metadata->'mentions' ? split_part(encode(t.tgargs,'escape'), E'\\\\000',1)
      OR m.metadata->'aun_control_plane'->>'active_owner'=split_part(encode(t.tgargs,'escape'), E'\\\\000',1)
      OR split_part(encode(t.tgargs,'escape'), E'\\\\000',1)=ANY(m.input_mentions)
      OR EXISTS(SELECT FROM public.message_queue q WHERE q.message_id IN (m.id::text,m.reply_to::text)
        AND q.agent_id=split_part(encode(t.tgargs,'escape'), E'\\\\000',1)))) AS protected`, [messageId])
  // No-policy defaults remain callable without new runtime role membership.
  if (scoped[0]?.protected === true) await admissionRows(db, 'SELECT public.aun_admission_seal_send($1)', [messageId])
}
export async function admissionTransition(db: AdmissionDb, state: AdmissionState, action: string, input: Record<string, unknown>): Promise<AdmissionState> {
  const rows = await admissionRows(db, 'SELECT public.aun_admission_transition($1,$2,$3,$4,$5::jsonb) AS state',
    [state.policy.policy_id, state.policy.revision, state.policy.config_digest, action, JSON.stringify(input)])
  if (!rows[0]?.state) throw new AdmissionError('ADMISSION_STATE_MISSING')
  return rows[0].state
}

/** PREPARE never uses a pooled worker connection or another transaction's snapshot. */
export async function prepareAdmission(input: {
  databaseUrl: string
  config: AdmissionConfig
  readAuthorityBody: (ref: AuthorityRef) => Promise<string>
  dryRun?: boolean
}): Promise<Record<string, unknown>> {
  validateAdmissionConfig(input.config)
  new BoundedReceiptStore(input.config.transport.receipt_dir,currentBoundedOwner(input.config.cohort_digest))
  await verifyAuthorityRef(input.config.authority, input.readAuthorityBody)
  await verifyAuthorityRef(input.config.no_affected_work_ref, input.readAuthorityBody)
  if (Date.parse(input.config.expires_at) - Date.now() <= input.config.worker_timeout_seconds * 1000) throw new AdmissionError('ADMISSION_WORKER_WINDOW_INVALID')
  const db = new Client({ connectionString: input.databaseUrl })
  db.on('error', () => {}) // transaction_timeout owns/ends only this dedicated connection.
  await db.connect()
  try {
    const capability = await admissionRows(db, "SELECT current_setting('transaction_timeout',true) AS timeout, current_setting('server_version_num')::integer AS version")
    if (!capability[0]?.timeout || capability[0].version < 170000) throw new AdmissionError('ADMISSION_STORAGE_UNSUPPORTED')
    const digest = await admissionRows(db, 'SELECT public.aun_admission_digest($1::jsonb) AS digest', [JSON.stringify(input.config)])
    if (input.dryRun) return { status: 'NOT_PREPARED', dry_run: true, config_digest: digest[0].digest, effect_count: 0 }
    await db.query("SET transaction_timeout='1s'")
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      await admissionRows(db, 'SELECT public.aun_admission_prepare_lock()')
      const result = await admissionRows(db, 'SELECT public.aun_admission_prepare($1::jsonb) AS state', [JSON.stringify(input.config)])
      await db.query('COMMIT')
      return result[0].state
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {})
      throw error
    }
  } finally { await db.end().catch(() => {}) }
}
