import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  FLEET_RUNTIME_V1_CONTRACT,
  FLEET_RUNTIME_V1_TARGETS,
  FleetRuntimeV1Error,
  canonicalFleetRuntimeJson,
  computeFleetRuntimeReceiptDigest,
  executeFleetRuntimeV1,
  prepareFleetRuntimeV1Request,
  type FleetRuntimeEffectReceipt,
  type FleetRuntimeInvocationState,
  type FleetRuntimeOperation,
  type FleetRuntimePersistencePort,
  type FleetRuntimePreflightReceipt,
  type FleetRuntimeRequest,
  type FleetRuntimeRootGoalReadback,
} from './fleet-runtime-v1-adapter'

export const FLEET_RUNTIME_V1_LOCAL_PROVIDER = Object.freeze({
  schema_version: 'fleet-runtime-v1/local-provider/v1',
  target_repository: 'watchout/kodama',
  target_agent_id: 'kodama',
  target_session: 'discord-kodama',
  target_port: 8803,
  required_executor: Object.freeze({
    actor_agent_id: 'aun-runtime-executor',
    active_function: 'runtime_recovery_executor',
  }),
  remote_preimage_head: '3c85d6f7a3c83e31c90fe4e3172c111c7541978f',
  remote_preimage_tree: '47d992a5c709cf65ef15f4aab5e60887be1aa45a',
  payload_digest: FLEET_RUNTIME_V1_CONTRACT.payload_digest,
  payload_path_count: 24,
})

export const FLEET_RUNTIME_V1_PRODUCTION_STATE_ROOT = '/Users/yuji/Library/Application Support/agent-comms-mcp/fleet-runtime-v1'

const STATE_SCHEMA = 'fleet-runtime-v1/local-operation-state/v1' as const
const INVOCATION_KEY = /^frv1:N40:[a-f0-9]{64}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const ACTIVE_LOCAL_INVOCATIONS = new Set<string>()
const PROCESS_EXECUTION_OWNER_ID = `${hostname()}:${process.pid}:${randomUUID()}`

export type FleetRuntimeLocalProviderErrorCode =
  | 'PROTECTED_EFFECTS_DISABLED'
  | 'STATE_DIRECTORY_INVALID'
  | 'STATE_RECORD_INVALID'
  | 'STATE_COLLISION'
  | 'IN_FLIGHT'
  | 'EXECUTOR_BINDING_MISMATCH'
  | 'TARGET_NOT_ADMITTED'
  | 'COMMAND_FAILED'
  | 'READBACK_INVALID'
  | 'UNSAFE_CHECKOUT'
  | 'PAYLOAD_VERIFICATION_FAILED'
  | 'WAITING_INDEPENDENT_MERGE'
  | 'INTERRUPTED_SUBEFFECT_UNRESOLVED'
  | 'OPERATION_STATE_MISMATCH'

export class FleetRuntimeLocalProviderError extends Error {
  constructor(readonly code: FleetRuntimeLocalProviderErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'FleetRuntimeLocalProviderError'
  }
}

function providerFail(code: FleetRuntimeLocalProviderErrorCode, message: string): never {
  throw new FleetRuntimeLocalProviderError(code, message)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return providerFail('READBACK_INVALID', `${label} is not valid JSON`)
  }
}

function parseCanonicalJson<T>(raw: string, label: string): T {
  const parsed = parseJson<T>(raw, label)
  if (canonicalFleetRuntimeJson(parsed) !== raw) {
    return providerFail('READBACK_INVALID', `${label} must be canonical JSON without duplicate or ambiguous keys`)
  }
  return parsed
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return providerFail('READBACK_INVALID', `${label} must be an object`)
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (canonicalFleetRuntimeJson(actual) !== canonicalFleetRuntimeJson(wanted)) {
    return providerFail('READBACK_INVALID', `${label} keys differ: expected ${wanted.join(',')}; got ${actual.join(',')}`)
  }
}

function canonicalSelfDigest(value: Record<string, unknown>, digestField = 'receipt_sha256'): string {
  const material = clone(value)
  delete material[digestField]
  return sha256(canonicalFleetRuntimeJson(material))
}

function findAgentRecord(value: unknown, agentId: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAgentRecord(item, agentId)
      if (found) return found
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.agent_id === agentId) return record
  for (const item of Object.values(record)) {
    const found = findAgentRecord(item, agentId)
    if (found) return found
  }
  return null
}

function assertNoSymlinkComponents(path: string): void {
  const normalized = resolve(path)
  const parts = normalized.split(sep).filter(Boolean)
  let cursor = sep
  for (const part of parts) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) continue
    if (lstatSync(cursor).isSymbolicLink()) {
      return providerFail('STATE_DIRECTORY_INVALID', `symlink component is forbidden: ${cursor}`)
    }
  }
}

function assertApprovedRoot(stateDirectory: string, approvedRoot: string): string {
  if (!isAbsolute(stateDirectory) || stateDirectory !== resolve(stateDirectory)
    || !isAbsolute(approvedRoot) || approvedRoot !== resolve(approvedRoot)
    || stateDirectory !== approvedRoot) {
    return providerFail('STATE_DIRECTORY_INVALID', 'state-dir must equal the exact approved absolute root')
  }
  assertNoSymlinkComponents(approvedRoot)
  if (existsSync(approvedRoot) && (!lstatSync(approvedRoot).isDirectory() || realpathSync(approvedRoot) !== approvedRoot)) {
    return providerFail('STATE_DIRECTORY_INVALID', 'approved state root must be a real directory')
  }
  return approvedRoot
}

function ensureContained(root: string, candidate: string): string {
  const rel = relative(root, candidate)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return candidate
  return providerFail('STATE_DIRECTORY_INVALID', 'provider path escaped the state directory')
}


function assertSafeStatePath(root: string, candidate: string, allowRoot = false): string {
  const normalizedRoot = resolve(root)
  const normalized = resolve(candidate)
  if (!allowRoot && normalized === normalizedRoot) {
    return providerFail('STATE_DIRECTORY_INVALID', 'operation path must be a strict state-root descendant')
  }
  ensureContained(normalizedRoot, normalized)
  assertNoSymlinkComponents(normalizedRoot)
  assertNoSymlinkComponents(normalized)
  return normalized
}

function safeMkdir(root: string, path: string): void {
  assertSafeStatePath(root, path, path === root)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertSafeStatePath(root, path, path === root)
}

export function validateFleetRuntimeCheckoutReadback(input: {
  checkout_path: string
  state_directory: string
  canonical_path: string
  remote: string
  head: string
  tree: string
  status_porcelain: string
  expected_head?: string
  expected_tree?: string
}): void {
  const root = resolve(input.state_directory)
  const checkout = resolve(input.checkout_path)
  if (checkout === resolve(input.canonical_path)) {
    return providerFail('UNSAFE_CHECKOUT', 'canonical checkout is never an execution checkout')
  }
  ensureContained(root, checkout)
  assertNoSymlinkComponents(root)
  assertNoSymlinkComponents(checkout)
  const admittedRemotes = new Set([
    'https://github.com/watchout/kodama.git',
    'git@github.com:watchout/kodama.git',
  ])
  if (!admittedRemotes.has(input.remote)
    || !COMMIT.test(input.head)
    || !COMMIT.test(input.tree)
    || input.status_porcelain !== ''
    || (input.expected_head !== undefined && input.head !== input.expected_head)
    || (input.expected_tree !== undefined && input.tree !== input.expected_tree)) {
    return providerFail('UNSAFE_CHECKOUT', 'checkout repository, head, tree, or cleanliness differs')
  }
}

function exactCounter(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return providerFail('READBACK_INVALID', `${label} must be an explicit nonnegative integer`)
  }
  return value
}

export function parseFleetRuntimeQueueStatus(
  report: unknown,
  observedNowMs: number,
  maxAgeMs = 5 * 60_000,
): FleetRuntimeRequest['queue_precheck'] {
  assertPlainRecord(report, 'agent-com status')
  if (typeof report.observed_at !== 'string') return providerFail('READBACK_INVALID', 'official status omitted observed_at')
  const observedAtMs = Date.parse(report.observed_at)
  if (!Number.isFinite(observedAtMs) || observedAtMs > observedNowMs + 30_000 || observedNowMs - observedAtMs > maxAgeMs) {
    return providerFail('READBACK_INVALID', 'official queue observed_at is invalid or stale')
  }
  const agents = Array.isArray(report.agents) ? report.agents : Array.isArray(report.rows) ? report.rows : null
  if (!agents) return providerFail('READBACK_INVALID', 'official status omitted agents')
  const kodama = agents.find(candidate => candidate !== null && typeof candidate === 'object'
    && (candidate as Record<string, unknown>).agent_id === 'kodama')
  if (!kodama) return providerFail('READBACK_INVALID', 'official status omitted kodama')
  const agent = kodama as Record<string, unknown>
  const queue = agent.queue !== null && typeof agent.queue === 'object' && !Array.isArray(agent.queue)
    ? agent.queue as Record<string, unknown> : agent
  const counted = ['pending_count', 'received_count', 'in_progress_count'].every(key => Object.hasOwn(queue, key))
  const official = ['pending', 'received', 'in_progress'].every(key => Object.hasOwn(queue, key))
  if (counted === official) return providerFail('READBACK_INVALID', 'queue counters must use exactly one complete official field set')
  const pending = exactCounter(queue[counted ? 'pending_count' : 'pending'], counted ? 'pending_count' : 'pending')
  const received = exactCounter(queue[counted ? 'received_count' : 'received'], counted ? 'received_count' : 'received')
  const inProgress = exactCounter(queue[counted ? 'in_progress_count' : 'in_progress'], counted ? 'in_progress_count' : 'in_progress')
  const material = { observed_at: report.observed_at, agent_id: 'kodama', pending, received, in_progress: inProgress }
  return {
    source_receipt_sha256: sha256(canonicalFleetRuntimeJson(material)),
    observed_at: report.observed_at,
    entries: [{ repository: 'watchout/kodama', agent_id: 'kodama', pending_count: pending, active_count: received + inProgress }],
  }
}

export function parseFleetRuntimeRootGoalReadback(raw: unknown): FleetRuntimeRootGoalReadback {
  assertPlainRecord(raw, 'root-goal status')
  assertExactKeys(raw, [
    'schema', 'verdict', 'store_code', 'runtime_digest', 'root', 'write_count', 'effect_delivery_performed',
  ], 'root-goal status')
  const pass = raw.verdict === 'PASS' && raw.store_code === 'FOUND'
    && SHA256.test(String(raw.runtime_digest ?? '')) && raw.root !== null && typeof raw.root === 'object' && !Array.isArray(raw.root)
  const blocked = raw.verdict === 'BLOCKED' && raw.store_code === 'STORE_NOT_CREATED'
    && raw.runtime_digest === null && raw.root === null
  if (raw.schema !== 'shirube-goal-runtime-command/v1'
    || (!pass && !blocked) || raw.write_count !== 0 || raw.effect_delivery_performed !== false) {
    return providerFail('READBACK_INVALID', 'root-goal status schema, verdict, store state, or zero-effect proof differs')
  }
  return {
    repository: 'watchout/kodama',
    store_path: '/Users/yuji/Developer/kodama/.framework/runtime/goal-convergence.json',
    schema: raw.schema,
    verdict: raw.verdict,
    store_code: raw.store_code,
    runtime_digest: raw.runtime_digest as string | null,
    root: raw.root,
    write_count: 0,
    effect_delivery_performed: false,
  }
}

export function assertExactFleetRuntimePathSet(expected: readonly string[], actual: readonly string[], label: string): void {
  if (expected.length !== 24 || actual.length !== expected.length
    || new Set(expected).size !== expected.length || new Set(actual).size !== actual.length
    || expected.some((path, index) => path !== actual[index])) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', `${label} differs from the exact ordered 24-path manifest`)
  }
}

export function validateFleetRuntimePayloadBlobLayer(
  expected: readonly { path: string; bytes: number; sha256: string }[],
  actual: readonly { path: string; bytes: number; sha256: string }[],
  label: string,
): void {
  assertExactFleetRuntimePathSet(expected.map(file => file.path), actual.map(file => file.path), label)
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index].bytes !== expected[index].bytes || actual[index].sha256 !== expected[index].sha256) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `${label} blob differs at ${expected[index].path}`)
    }
  }
}

export function validateFleetRuntimeExternalMergeBinding(input: {
  request: FleetRuntimeRequest
  receipt: Record<string, unknown>
  pr: Record<string, unknown>
  createdPrUrl: string
  pushedHead: string
  observedMergeTree: string
}): void {
  validateFleetRuntimeExternalMergeReceipt(input.request, input.receipt, {
    createdPrUrl: input.createdPrUrl,
    pushedHead: input.pushedHead,
  })
  const mergeCommit = input.pr.mergeCommit as Record<string, unknown> | null
  if (input.receipt.pr_url !== input.createdPrUrl
    || input.pr.url !== input.createdPrUrl
    || input.receipt.pushed_head !== input.pushedHead
    || input.pr.headRefOid !== input.receipt.pushed_head
    || input.pr.state !== 'MERGED' || input.pr.mergedAt === null
    || input.pr.baseRefName !== input.request.preimages[0].required_base_branch
    || mergeCommit?.oid !== input.receipt.merge_commit
    || input.receipt.merge_tree !== input.observedMergeTree) {
    return providerFail('READBACK_INVALID', 'external merge is not bound to the created PR and exact pushed head')
  }
}

const EXTERNAL_MERGE_RECEIPT_KEYS = Object.freeze([
  'schema_version', 'receipt_sha256', 'subject_digest', 'request_id', 'request_digest', 'idempotency_key',
  'operation', 'target_repository', 'base', 'pr_url', 'pushed_head', 'merge_commit', 'merge_tree', 'result',
  'predecessor_receipt_sha256',
] as const)

export function validateFleetRuntimeExternalMergeReceipt(
  request: FleetRuntimeRequest,
  rawReceipt: Record<string, unknown>,
  expected: { createdPrUrl: string; pushedHead: string },
): Record<string, unknown> {
  const receipt = clone(rawReceipt)
  assertPlainRecord(receipt, 'external merge receipt')
  assertExactKeys(receipt, EXTERNAL_MERGE_RECEIPT_KEYS, 'external merge receipt')
  if (receipt.schema_version !== 'fleet-runtime-v1/external-merge-receipt/v1'
    || receipt.receipt_sha256 !== canonicalSelfDigest(receipt)
    || receipt.subject_digest !== sha256(canonicalFleetRuntimeJson(request.subject))
    || receipt.request_id !== request.request_id || receipt.request_digest !== request.request_digest
    || receipt.idempotency_key !== request.idempotency_key || receipt.operation !== request.operation
    || receipt.target_repository !== 'watchout/kodama'
    || receipt.base !== request.preimages[0].required_base_branch
    || receipt.pr_url !== expected.createdPrUrl || receipt.pushed_head !== expected.pushedHead
    || !/^https:\/\/github\.com\/watchout\/kodama\/pull\/[1-9][0-9]*$/.test(String(receipt.pr_url ?? ''))
    || !COMMIT.test(String(receipt.pushed_head ?? '')) || !COMMIT.test(String(receipt.merge_commit ?? ''))
    || !COMMIT.test(String(receipt.merge_tree ?? '')) || receipt.result !== 'PASS'
    || receipt.predecessor_receipt_sha256 !== request.predecessor_receipt.sha256) {
    return providerFail('READBACK_INVALID', 'external merge receipt tuple or canonical self digest differs')
  }
  return receipt
}

function yamlTopScalar(body: string, key: string): string {
  const matches = [...body.matchAll(new RegExp(`^${key}:\\s*([^\\n]+)$`, 'gm'))]
  if (matches.length !== 1) return providerFail('READBACK_INVALID', `immutable body requires exactly one ${key}`)
  return matches[0][1].trim()
}

function yamlSection(body: string, key: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex(line => line === `${key}:`)
  if (start < 0 || lines.filter(line => line === `${key}:`).length !== 1) {
    return providerFail('READBACK_INVALID', `immutable body requires exactly one ${key} section`)
  }
  let end = start + 1
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].trim() === '')) end += 1
  return lines.slice(start + 1, end).join('\n')
}

function yamlIndentedScalar(section: string, key: string): string {
  const matches = [...section.matchAll(new RegExp(`^  ${key}:\\s*([^\\n]+)$`, 'gm'))]
  if (matches.length !== 1) return providerFail('READBACK_INVALID', `immutable section requires exactly one ${key}`)
  return matches[0][1].trim()
}

function yamlNestedSection(section: string, key: string, indent = 2): string {
  const prefix = ' '.repeat(indent)
  const lines = section.split('\n')
  const start = lines.findIndex(line => line === `${prefix}${key}:`)
  if (start < 0 || lines.filter(line => line === `${prefix}${key}:`).length !== 1) {
    return providerFail('READBACK_INVALID', `immutable section requires exactly one ${key} subsection`)
  }
  let end = start + 1
  while (end < lines.length && (lines[end].startsWith(`${prefix}  `) || lines[end].trim() === '')) end += 1
  return lines.slice(start + 1, end).map(line => line.slice(indent)).join('\n')
}

function yamlList(section: string, key: string): string[] {
  const nested = yamlNestedSection(section, key)
  const values = nested.split('\n').filter(line => line.startsWith('  - ')).map(line => line.slice(4).trim())
  if (values.length === 0 || nested.split('\n').some(line => line.trim() && !line.startsWith('  - '))) {
    return providerFail('READBACK_INVALID', `${key} must be an explicit list`)
  }
  return values
}

function yamlInlineList(value: string, label: string): string[] {
  if (!/^\[[^\[\]]*\]$/.test(value)) return providerFail('READBACK_INVALID', `${label} must be an inline list`)
  return value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean)
}

function parseOwnerStageMatrix(body: string): FleetRuntimeRequest['owner_decision']['stage_authority_matrix'] {
  const section = yamlSection(body, 'stage_authority_matrix')
  const chunks = section.split(/(?=^  - stage_id: )/m).filter(chunk => chunk.trim())
  if (chunks.length !== 4) return providerFail('READBACK_INVALID', 'owner stage matrix must contain exactly four entries')
  return chunks.map(chunk => {
    const semanticKeys = [...chunk.matchAll(/^\s{2,4}(?:- )?([a-z_]+):/gm)].map(match => match[1])
    const expectedKeys = ['stage_id', 'actor_agent_id', 'active_function', 'allowed_operations', 'target_repositories']
    if (semanticKeys.length !== expectedKeys.length || semanticKeys.some((key, index) => key !== expectedKeys[index])) {
      return providerFail('READBACK_INVALID', 'owner stage matrix entry has duplicate, unknown, missing, or reordered keys')
    }
    const stage = chunk.match(/^  - stage_id:\s*(\S+)$/m)?.[1]
    const scalar = (key: string) => chunk.match(new RegExp(`^    ${key}:\\s*(\\S.*)$`, 'm'))?.[1]
    const actor = scalar('actor_agent_id')
    const activeFunction = scalar('active_function')
    const operations = scalar('allowed_operations')
    const targets = scalar('target_repositories')
    if (!stage || !actor || !activeFunction || !operations || !targets) {
      return providerFail('READBACK_INVALID', 'owner stage matrix entry is incomplete')
    }
    return {
      stage_id: stage,
      actor_agent_id: actor,
      active_function: activeFunction,
      allowed_operations: yamlInlineList(operations, 'allowed_operations') as FleetRuntimeOperation[],
      target_repositories: yamlInlineList(targets, 'target_repositories'),
    }
  })
}

function localReceiptExactKeys(operation: FleetRuntimeOperation): string[] {
  const common = [
    'schema_version', 'receipt_id', 'receipt_sha256', 'request_id', 'request_digest', 'idempotency_key', 'stage_id',
    'operation', 'effect_id', 'actor_agent_id', 'active_function', 'started_at', 'completed_at', 'result', 'per_target',
    'duplicate_effect_count', 'unauthorized_effect_count', 'subject_digest', 'predecessor_receipt_sha256',
    'predecessor_receipt_raw_body_sha256', 'predecessor_receipt_self_sha256', 'target_repository',
  ]
  const specific = operation === 'ROLLBACK'
    ? ['merge_commit', 'merge_tree', 'pr_url', 'forward_effect_receipt_sha256', 'restored_preimage', 'fresh_runtime_instance_readback', 'queue_counts_unchanged']
    : operation === 'REAPPLY'
      ? ['merge_commit', 'merge_tree', 'pr_url', 'rollback_receipt_sha256', 'recovery_receipt_sha256', 'payload_digest', 'postimage']
      : operation === 'CANARY_COLD_START'
        ? ['merge_commit', 'merge_tree', 'pr_url']
        : ['rollback_receipt_sha256']
  return [...common, ...specific]
}

export function validateFleetRuntimeLocalReceipt(
  raw: string | Record<string, unknown>,
  expected: {
    request: FleetRuntimeRequest
    operation: FleetRuntimeOperation
    target: string
    predecessorRawBodySha256: string
    predecessorSelfSha256: string | null
  },
): Record<string, unknown> {
  const receipt = typeof raw === 'string' ? parseCanonicalJson<Record<string, unknown>>(raw, 'local receipt') : clone(raw)
  assertPlainRecord(receipt, 'local receipt')
  const request = expected.request
  const expectedSchema = expected.operation === 'ROLLBACK'
    ? 'fleet-runtime-v1/rollback-receipt/v1'
    : expected.operation === 'REAPPLY'
      ? 'fleet-runtime-v1/reapply-receipt/v1'
      : 'fleet-runtime-v1/effect-receipt/v1'
  assertExactKeys(receipt, localReceiptExactKeys(expected.operation), 'local receipt')
  const perTarget = receipt.per_target
  const target = Array.isArray(perTarget) && perTarget.length === 1 ? perTarget[0] : null
  assertPlainRecord(target, 'local receipt target')
  assertExactKeys(target, ['repository', 'preimage', 'postimage', 'queue_precheck', 'root_goal_readback'], 'local receipt target')
  const postimage = target.postimage
  assertPlainRecord(postimage, 'local receipt postimage')
  assertExactKeys(postimage, [
    'head_commit', 'tree', 'runtime_surface_sha256', 'distribution_surface_sha256', 'release', 'config', 'policy',
    'root', 'goal', 'runtime_digest', 'runtime_instance_id',
  ], 'local receipt postimage')
  if (receipt.schema_version !== expectedSchema || receipt.operation !== expected.operation
    || receipt.request_id !== request.request_id || receipt.request_digest !== request.request_digest
    || receipt.idempotency_key !== request.idempotency_key
    || receipt.actor_agent_id !== request.executor_identity.actor_agent_id
    || receipt.active_function !== request.executor_identity.active_function
    || receipt.stage_id !== request.stage_id || receipt.result !== 'PASS'
    || receipt.subject_digest !== sha256(canonicalFleetRuntimeJson(request.subject)) || receipt.target_repository !== expected.target
    || receipt.predecessor_receipt_sha256 !== expected.predecessorRawBodySha256
    || receipt.predecessor_receipt_raw_body_sha256 !== expected.predecessorRawBodySha256
    || receipt.predecessor_receipt_self_sha256 !== expected.predecessorSelfSha256
    || target.repository !== expected.target
    || typeof postimage.runtime_instance_id !== 'string' || postimage.runtime_instance_id.length === 0
    || !COMMIT.test(String(postimage.head_commit ?? '')) || !COMMIT.test(String(postimage.tree ?? ''))
    || receipt.duplicate_effect_count !== 0 || receipt.unauthorized_effect_count !== 0) {
    return providerFail('READBACK_INVALID', 'local receipt schema, subject, operation, target, predecessor, or postimage differs')
  }
  const selfDigest = computeFleetRuntimeReceiptDigest(receipt as unknown as FleetRuntimeEffectReceipt)
  if (receipt.receipt_sha256 !== selfDigest) return providerFail('READBACK_INVALID', 'local receipt self-digest differs')
  if (expected.operation === 'ROLLBACK' && receipt.forward_effect_receipt_sha256 !== receipt.predecessor_receipt_sha256) {
    return providerFail('READBACK_INVALID', 'rollback receipt does not bind its forward effect predecessor')
  }
  if (expected.operation === 'RECOVERY' && receipt.rollback_receipt_sha256 !== expected.predecessorSelfSha256) {
    return providerFail('READBACK_INVALID', 'recovery receipt does not bind its rollback predecessor self digest')
  }
  if (expected.operation === 'REAPPLY'
    && (!SHA256.test(String(receipt.rollback_receipt_sha256 ?? ''))
      || receipt.recovery_receipt_sha256 !== receipt.predecessor_receipt_sha256)) {
    return providerFail('READBACK_INVALID', 'reapply receipt does not bind rollback and recovery predecessors')
  }
  return receipt
}

function validateFleetRuntimePredecessorReceipt(
  request: FleetRuntimeRequest,
  rawBody: string,
): Record<string, unknown> {
  const receipt = parseCanonicalJson<Record<string, unknown>>(rawBody, 'immutable predecessor receipt')
  assertPlainRecord(receipt, 'immutable predecessor receipt')
  const operation = request.predecessor_receipt.operation
  if (!operation) return providerFail('READBACK_INVALID', 'effect predecessor operation is absent')
  const expectedSchema = operation === 'ROLLBACK'
    ? 'fleet-runtime-v1/rollback-receipt/v1'
    : operation === 'REAPPLY'
      ? 'fleet-runtime-v1/reapply-receipt/v1'
      : 'fleet-runtime-v1/effect-receipt/v1'
  const expectedKind = operation === 'ROLLBACK' ? 'ROLLBACK_RECEIPT'
    : operation === 'RECOVERY' ? 'RECOVERY_RECEIPT' : 'EFFECT_RECEIPT'
  assertExactKeys(receipt, localReceiptExactKeys(operation), 'immutable predecessor receipt')
  const perTarget = receipt.per_target
  const target = Array.isArray(perTarget) && perTarget.length === 1 ? perTarget[0] as Record<string, unknown> : null
  const postimage = target?.postimage as Record<string, unknown> | undefined
  if (request.predecessor_receipt.kind !== expectedKind
    || request.predecessor_receipt.node_id !== 'N40-P4-CANARY-VERIFY'
    || receipt.schema_version !== expectedSchema || receipt.operation !== operation || receipt.result !== request.predecessor_receipt.result
    || receipt.stage_id !== request.predecessor_receipt.node_id
    || receipt.subject_digest !== request.predecessor_receipt.subject_digest
    || receipt.target_repository !== 'watchout/kodama' || target?.repository !== 'watchout/kodama'
    || !String(receipt.request_id ?? '').startsWith('FRV1-N40-')
    || !SHA256.test(String(receipt.request_digest ?? '')) || !INVOCATION_KEY.test(String(receipt.idempotency_key ?? ''))
    || receipt.actor_agent_id !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.required_executor.actor_agent_id
    || receipt.active_function !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.required_executor.active_function
    || receipt.receipt_sha256 !== canonicalSelfDigest(receipt)
    || typeof postimage?.runtime_instance_id !== 'string' || postimage.runtime_instance_id.length === 0
    || !COMMIT.test(String(postimage.head_commit ?? '')) || !COMMIT.test(String(postimage.tree ?? ''))) {
    return providerFail('READBACK_INVALID', 'immutable predecessor receipt kind, node, operation, subject, tuple, or digest differs')
  }
  if ((operation === 'CANARY_COLD_START' || operation === 'ROLLBACK')
    && (!COMMIT.test(String(receipt.merge_commit ?? '')) || !COMMIT.test(String(receipt.merge_tree ?? ''))
      || !/^https:\/\/github\.com\/watchout\/kodama\/pull\/[1-9][0-9]*$/.test(String(receipt.pr_url ?? '')))) {
    return providerFail('READBACK_INVALID', 'immutable predecessor merge image is incomplete')
  }
  if (operation === 'RECOVERY' && !SHA256.test(String(receipt.rollback_receipt_sha256 ?? ''))) {
    return providerFail('READBACK_INVALID', 'immutable recovery predecessor lacks rollback self digest')
  }
  return receipt
}

export function validateFleetRuntimeImmutableSemantics(
  request: FleetRuntimeRequest,
  ownerBody: string,
  predecessorBody: string,
): void {
  const ownerSubject = yamlSection(ownerBody, 'subject')
  const canary = yamlSection(ownerBody, 'canary_selection')
  const release = yamlNestedSection(ownerSubject, 'release')
  const targetSet = yamlNestedSection(ownerSubject, 'target_set')
  const rollback = yamlSection(ownerBody, 'rollback_preimage')
  const rollbackRepository = yamlNestedSection(rollback, 'repository_preimage')
  if (yamlTopScalar(ownerBody, 'schema_version') !== 'shirube-v3/owner_decision/v1'
    || yamlTopScalar(ownerBody, 'decision') !== 'GO' || yamlTopScalar(ownerBody, 'result') !== request.owner_decision.result
    || yamlTopScalar(ownerBody, 'actor_identity') !== request.owner_decision.actor
    || yamlIndentedScalar(ownerSubject, 'graph_digest') !== request.subject.graph_digest
    || yamlIndentedScalar(ownerSubject, 'graph_generation') !== String(request.subject.graph_generation)
    || yamlIndentedScalar(ownerSubject, 'node_id') !== request.owner_decision.node_id
    || yamlIndentedScalar(ownerSubject, 'lease_epoch') !== request.subject.lease_epoch
    || yamlIndentedScalar(release, 'repository') !== request.subject.release_repository
    || yamlIndentedScalar(release, 'tag') !== request.subject.release_tag
    || yamlIndentedScalar(release, 'commit') !== request.subject.release_commit
    || yamlIndentedScalar(release, 'tree') !== request.subject.release_tree
    || yamlIndentedScalar(release, 'manifest_self_digest') !== request.subject.release_manifest_digest
    || canonicalFleetRuntimeJson(yamlList(targetSet, 'ordered')) !== canonicalFleetRuntimeJson(FLEET_RUNTIME_V1_TARGETS)
    || yamlIndentedScalar(targetSet, 'canonical_digest') !== request.subject.target_set_digest
    || yamlIndentedScalar(targetSet, 'payload_digest') !== request.subject.payload_digest
    || yamlIndentedScalar(canary, 'target') !== request.owner_decision.canary_target
    || yamlIndentedScalar(canary, 'explicit_owner_selection') !== 'true'
    || yamlIndentedScalar(canary, 'target_count') !== '1'
    || yamlIndentedScalar(rollback, 'target_repository') !== 'watchout/kodama'
    || yamlIndentedScalar(rollbackRepository, 'required_base_branch') !== request.preimages[0].required_base_branch
    || yamlIndentedScalar(rollbackRepository, 'head_commit') !== request.preimages[0].head_commit
    || yamlIndentedScalar(rollbackRepository, 'tree') !== request.preimages[0].tree
    || yamlIndentedScalar(rollbackRepository, 'runtime_surface_sha256') !== request.preimages[0].runtime_surface_sha256
    || yamlIndentedScalar(rollbackRepository, 'distribution_surface_sha256') !== request.preimages[0].distribution_surface_sha256
    || canonicalFleetRuntimeJson(parseOwnerStageMatrix(ownerBody)) !== canonicalFleetRuntimeJson(request.owner_decision.stage_authority_matrix)) {
    return providerFail('READBACK_INVALID', 'owner body semantics differ from the sealed request')
  }
  if (request.operation !== 'CANARY_COLD_START') {
    validateFleetRuntimePredecessorReceipt(request, predecessorBody)
    return
  }
  const exact = yamlSection(predecessorBody, 'exact_subject')
  if (yamlTopScalar(predecessorBody, 'schema_version') !== 'shirube-v3/node-result/v1'
    || yamlTopScalar(predecessorBody, 'node_id') !== request.predecessor_receipt.node_id
    || yamlTopScalar(predecessorBody, 'result') !== request.predecessor_receipt.result
    || yamlTopScalar(predecessorBody, 'verdict') !== 'PASS_EXACT_SUBJECT'
    || yamlIndentedScalar(exact, 'graph_digest') !== request.subject.graph_digest.replace(/^sha256:/, '')
    || yamlIndentedScalar(exact, 'release_tag') !== request.subject.release_tag
    || yamlIndentedScalar(exact, 'release_commit') !== request.subject.release_commit
    || yamlIndentedScalar(exact, 'release_tree') !== request.subject.release_tree
    || yamlIndentedScalar(exact, 'release_manifest_digest') !== request.subject.release_manifest_digest.replace(/^sha256:/, '')
    || yamlIndentedScalar(exact, 'target_set_digest') !== request.subject.target_set_digest.replace(/^sha256:/, '')
    || yamlIndentedScalar(exact, 'payload_digest') !== request.subject.payload_digest.replace(/^sha256:/, '')) {
    return providerFail('READBACK_INVALID', 'predecessor body semantics differ from the exact subject')
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function atomicWrite(root: string, path: string, value: unknown, exclusive = false): void {
  assertSafeStatePath(root, path)
  const parent = dirname(path)
  safeMkdir(root, parent)
  const body = `${canonicalFleetRuntimeJson(value)}\n`
  if (exclusive) {
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeFileSync(fd, body, { encoding: 'utf8' })
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    syncDirectory(parent)
    assertSafeStatePath(root, path)
    return
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, body, { encoding: 'utf8' })
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  syncDirectory(parent)
  assertSafeStatePath(root, path)
}

function readState<T>(root: string, path: string, label: string): T {
  assertSafeStatePath(root, path)
  if (lstatSync(path).isSymbolicLink()) return providerFail('STATE_RECORD_INVALID', `${label} cannot be a symlink`)
  return parseJson<T>(readFileSync(path, 'utf8'), label)
}

function assertInvocationStateShape(state: FleetRuntimeInvocationState): void {
  assertPlainRecord(state, 'invocation state')
  if (!INVOCATION_KEY.test(state.idempotency_key)
    || !SHA256.test(state.request_digest)
    || !['reserved', 'completed'].includes(state.status)
    || (state.status === 'reserved' && state.receipt !== null)
    || (state.status === 'completed' && state.receipt === null)) {
    return providerFail('STATE_RECORD_INVALID', 'invocation state has an invalid shape')
  }
  const owned = state as OwnedFleetRuntimeInvocationState
  if (owned.execution_owner !== undefined) {
    const owner = owned.execution_owner
    if (owner === null || typeof owner !== 'object' || typeof owner.owner_id !== 'string' || owner.owner_id.length === 0
      || typeof owner.host !== 'string' || owner.host.length === 0 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !Number.isFinite(Date.parse(owner.acquired_at)) || !Number.isFinite(Date.parse(owner.heartbeat_at))) {
      return providerFail('STATE_RECORD_INVALID', 'invocation execution owner has an invalid shape')
    }
  }
}

export interface FleetRuntimeExecutionOwner {
  owner_id: string
  host: string
  pid: number
  acquired_at: string
  heartbeat_at: string
}

interface OwnedFleetRuntimeInvocationState extends FleetRuntimeInvocationState {
  execution_owner?: FleetRuntimeExecutionOwner
}

export interface FleetRuntimePersistenceOptions {
  approvedRoot?: string
  ownerId?: string
  host?: string
  pid?: number
  nowMs?: () => number
  staleAfterMs?: number
  ownerAlive?: (owner: FleetRuntimeExecutionOwner) => boolean
}

/** Durable adapter persistence. It performs no filesystem mutation until reserve_once. */
export class FileFleetRuntimeV1Persistence implements FleetRuntimePersistencePort {
  readonly root: string
  readonly owner: FleetRuntimeExecutionOwner
  private readonly nowMs: () => number
  private readonly ownerAlive: (owner: FleetRuntimeExecutionOwner) => boolean
  private readonly staleAfterMs: number

  constructor(stateDirectory: string, options: FleetRuntimePersistenceOptions = {}) {
    this.root = assertApprovedRoot(stateDirectory, options.approvedRoot ?? FLEET_RUNTIME_V1_PRODUCTION_STATE_ROOT)
    this.nowMs = options.nowMs ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? 60_000
    const ownerId = options.ownerId ?? PROCESS_EXECUTION_OWNER_ID
    this.owner = {
      owner_id: ownerId,
      host: options.host ?? hostname(),
      pid: options.pid ?? process.pid,
      acquired_at: new Date(this.nowMs()).toISOString(),
      heartbeat_at: new Date(this.nowMs()).toISOString(),
    }
    this.ownerAlive = options.ownerAlive ?? (owner => {
      if (owner.host !== hostname()) return true
      try {
        process.kill(owner.pid, 0)
        return true
      } catch {
        return false
      }
    })
  }

  invocationDirectory(key: string): string {
    if (!INVOCATION_KEY.test(key)) return providerFail('STATE_RECORD_INVALID', 'invalid N40 idempotency key')
    return assertSafeStatePath(this.root, join(this.root, 'invocations', key))
  }

  private reservationPath(key: string): string {
    return join(this.invocationDirectory(key), 'reservation.json')
  }

  private completionPath(key: string): string {
    return join(this.invocationDirectory(key), 'completed.json')
  }

  async load(key: string): Promise<FleetRuntimeInvocationState | null> {
    const completed = this.completionPath(key)
    const reserved = this.reservationPath(key)
    const path = existsSync(completed) ? completed : existsSync(reserved) ? reserved : null
    if (!path) return null
    const state = readState<OwnedFleetRuntimeInvocationState>(this.root, path, 'invocation state')
    assertInvocationStateShape(state)
    return clone(state)
  }

  async reserve_once(state: FleetRuntimeInvocationState): Promise<{ acquired: boolean; state: FleetRuntimeInvocationState }> {
    assertInvocationStateShape(state)
    if (state.status !== 'reserved') return providerFail('STATE_RECORD_INVALID', 'reservation must use reserved state')
    assertApprovedRoot(this.root, this.root)
    safeMkdir(this.root, this.root)
    safeMkdir(this.root, this.invocationDirectory(state.idempotency_key))
    const owned: OwnedFleetRuntimeInvocationState = { ...state, execution_owner: clone(this.owner) }
    try {
      atomicWrite(this.root, this.reservationPath(state.idempotency_key), owned, true)
      return { acquired: true, state: clone(owned) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await this.load(state.idempotency_key)
      if (!existing) return providerFail('STATE_RECORD_INVALID', 'reservation disappeared after exclusive-create collision')
      if (existing.request_digest !== state.request_digest) {
        return providerFail('STATE_COLLISION', 'same idempotency key is bound to another request')
      }
      if (existing.status === 'completed') return { acquired: false, state: existing }
      const current = existing as OwnedFleetRuntimeInvocationState
      if (!current.execution_owner) return providerFail('STATE_RECORD_INVALID', 'reserved invocation lacks durable owner')
      if (current.execution_owner.owner_id === this.owner.owner_id) {
        await this.heartbeatOwner(state.idempotency_key)
        return { acquired: true, state: existing }
      }
      if (this.ownerAlive(current.execution_owner)) {
        return providerFail('IN_FLIGHT', `request is owned by live executor ${current.execution_owner.owner_id}`)
      }
      const heartbeat = Date.parse(current.execution_owner.heartbeat_at)
      if (!Number.isFinite(heartbeat) || this.nowMs() - heartbeat < this.staleAfterMs) {
        return providerFail('IN_FLIGHT', 'dead execution owner is not yet stale')
      }
      return this.takeover(state, current)
    }
  }

  private async takeover(
    state: FleetRuntimeInvocationState,
    observed: OwnedFleetRuntimeInvocationState,
    allowStaleLockBreak = true,
  ): Promise<{ acquired: boolean; state: FleetRuntimeInvocationState }> {
    const lock = join(this.invocationDirectory(state.idempotency_key), 'takeover.lock')
    try {
      atomicWrite(this.root, lock, { prior_owner: observed.execution_owner, next_owner: this.owner }, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lockState = readState<{ next_owner?: FleetRuntimeExecutionOwner }>(this.root, lock, 'takeover lock')
        const lockOwner = lockState.next_owner
        const heartbeat = Date.parse(String(lockOwner?.heartbeat_at ?? ''))
        if (allowStaleLockBreak && lockOwner && !this.ownerAlive(lockOwner)
          && Number.isFinite(heartbeat) && this.nowMs() - heartbeat >= this.staleAfterMs) {
          unlinkSync(lock)
          return this.takeover(state, observed, false)
        }
        return providerFail('IN_FLIGHT', 'another executor is taking over the stale owner')
      }
      throw error
    }
    try {
      const latest = await this.load(state.idempotency_key) as OwnedFleetRuntimeInvocationState | null
      if (!latest || latest.status !== 'reserved' || latest.request_digest !== state.request_digest
        || latest.execution_owner?.owner_id !== observed.execution_owner?.owner_id
        || this.ownerAlive(latest.execution_owner)) {
        return providerFail('IN_FLIGHT', 'reservation changed or its owner is live during takeover')
      }
      const heartbeat = Date.parse(latest.execution_owner.heartbeat_at)
      if (!Number.isFinite(heartbeat) || this.nowMs() - heartbeat < this.staleAfterMs) {
        return providerFail('IN_FLIGHT', 'reservation is not stale during takeover')
      }
      const replaced: OwnedFleetRuntimeInvocationState = { ...state, execution_owner: clone(this.owner) }
      atomicWrite(this.root, this.reservationPath(state.idempotency_key), replaced)
      return { acquired: true, state: clone(replaced) }
    } finally {
      if (existsSync(lock)) unlinkSync(lock)
    }
  }

  async heartbeatOwner(key: string): Promise<void> {
    const path = this.reservationPath(key)
    const state = readState<OwnedFleetRuntimeInvocationState>(this.root, path, 'reservation owner')
    if (state.status !== 'reserved' || state.execution_owner?.owner_id !== this.owner.owner_id) {
      return providerFail('IN_FLIGHT', 'current executor does not own the reservation')
    }
    state.execution_owner.heartbeat_at = new Date(this.nowMs()).toISOString()
    atomicWrite(this.root, path, state)
  }

  assertOwner(key: string): void {
    const path = this.reservationPath(key)
    if (!existsSync(path)) return providerFail('IN_FLIGHT', 'reservation no longer exists')
    const state = readState<OwnedFleetRuntimeInvocationState>(this.root, path, 'reservation owner')
    if (state.status !== 'reserved' || state.execution_owner?.owner_id !== this.owner.owner_id) {
      return providerFail('IN_FLIGHT', 'current executor no longer owns the durable reservation')
    }
  }

  async complete_once(state: FleetRuntimeInvocationState): Promise<FleetRuntimeInvocationState> {
    assertInvocationStateShape(state)
    if (state.status !== 'completed') return providerFail('STATE_RECORD_INVALID', 'completion must use completed state')
    const existing = await this.load(state.idempotency_key)
    if (!existing) return providerFail('STATE_RECORD_INVALID', 'cannot complete an unreserved invocation')
    if (existing.request_digest !== state.request_digest) return providerFail('STATE_COLLISION', 'completion request digest differs')
    if (existing.status === 'completed') {
      if (canonicalFleetRuntimeJson(existing) !== canonicalFleetRuntimeJson(state)) {
        return providerFail('STATE_COLLISION', 'completed receipt is immutable')
      }
      return existing
    }
    this.assertOwner(state.idempotency_key)
    atomicWrite(this.root, this.completionPath(state.idempotency_key), state)
    this.assertOwner(state.idempotency_key)
    return clone(state)
  }
}

export type FleetRuntimeLocalPhase =
  | 'PREPARE_CLEAN_CHECKOUT'
  | 'STAGE_EXACT_PAYLOAD'
  | 'VERIFY_EXACT_PAYLOAD'
  | 'CREATE_LOCAL_COMMIT'
  | 'PUSH_NORMAL_BRANCH'
  | 'CREATE_DRAFT_PR'
  | 'CREATE_LOCAL_REVERT'
  | 'VERIFY_EXTERNAL_MERGE'
  | 'PREPARE_MERGED_CHECKOUT'
  | 'VERIFY_EXACT_PREIMAGE'
  | 'COLD_START_DISCORD_KODAMA'
  | 'VERIFY_LIVE_IDENTITY'

const OPERATION_PHASES: Readonly<Record<'CANARY_COLD_START' | 'ROLLBACK' | 'RECOVERY' | 'REAPPLY', readonly FleetRuntimeLocalPhase[]>> = Object.freeze({
  CANARY_COLD_START: Object.freeze([
    'PREPARE_CLEAN_CHECKOUT', 'STAGE_EXACT_PAYLOAD', 'VERIFY_EXACT_PAYLOAD', 'CREATE_LOCAL_COMMIT',
    'PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR', 'VERIFY_EXTERNAL_MERGE', 'PREPARE_MERGED_CHECKOUT',
    'COLD_START_DISCORD_KODAMA', 'VERIFY_LIVE_IDENTITY',
  ]),
  ROLLBACK: Object.freeze([
    'PREPARE_CLEAN_CHECKOUT', 'CREATE_LOCAL_REVERT', 'PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR',
    'VERIFY_EXTERNAL_MERGE', 'PREPARE_MERGED_CHECKOUT', 'VERIFY_EXACT_PREIMAGE',
    'COLD_START_DISCORD_KODAMA', 'VERIFY_LIVE_IDENTITY',
  ]),
  RECOVERY: Object.freeze([
    'PREPARE_CLEAN_CHECKOUT', 'VERIFY_EXACT_PREIMAGE', 'COLD_START_DISCORD_KODAMA', 'VERIFY_LIVE_IDENTITY',
  ]),
  REAPPLY: Object.freeze([
    'PREPARE_CLEAN_CHECKOUT', 'STAGE_EXACT_PAYLOAD', 'VERIFY_EXACT_PAYLOAD', 'CREATE_LOCAL_COMMIT',
    'PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR', 'VERIFY_EXTERNAL_MERGE', 'PREPARE_MERGED_CHECKOUT',
    'COLD_START_DISCORD_KODAMA', 'VERIFY_LIVE_IDENTITY',
  ]),
})

const PROTECTED_PHASES = new Set<FleetRuntimeLocalPhase>([
  'PUSH_NORMAL_BRANCH',
  'CREATE_DRAFT_PR',
  'COLD_START_DISCORD_KODAMA',
])

export interface FleetRuntimeLocalPhaseState {
  status: 'started' | 'completed'
  started_at: string
  completed_at: string | null
  evidence: Record<string, unknown> | null
  intent: Record<string, unknown>
  protected_effect_count: number
  intent_sha256: string
  evidence_sha256: string | null
}

export interface FleetRuntimeLocalOperationState {
  schema_version: typeof STATE_SCHEMA
  request_id: string
  request_digest: string
  idempotency_key: string
  operation: FleetRuntimeOperation
  execution_owner_id: string
  phases: Partial<Record<FleetRuntimeLocalPhase, FleetRuntimeLocalPhaseState>>
}

export interface FleetRuntimeLocalPhaseContext {
  state_directory: string
  invocation_directory: string
  prior_evidence: Partial<Record<FleetRuntimeLocalPhase, Record<string, unknown>>>
  current_intent: Record<string, unknown>
  predecessor_receipt_raw_body: string
}

export interface FleetRuntimeLocalPhaseResult {
  evidence: Record<string, unknown>
  protected_effect_count: 0 | 1
}

export interface FleetRuntimeLocalReconcileResult {
  completed: boolean
  evidence: Record<string, unknown> | null
  protected_effect_count: 0 | 1
}

export interface FleetRuntimeLocalSystem {
  phaseIntent?(
    request: Readonly<FleetRuntimeRequest>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>
  inspect(request: Readonly<FleetRuntimeRequest>): Promise<FleetRuntimePreflightReceipt>
  performPhase(
    request: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalPhaseResult>
  reconcilePhase(
    request: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalReconcileResult>
  buildReceipt(
    request: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
    state: Readonly<FleetRuntimeLocalOperationState>,
  ): Promise<FleetRuntimeEffectReceipt>
}

function assertJournal(state: FleetRuntimeLocalOperationState, request: FleetRuntimeRequest, ownerId: string): void {
  assertPlainRecord(state, 'operation state')
  if (state.schema_version !== STATE_SCHEMA
    || state.request_id !== request.request_id
    || state.request_digest !== request.request_digest
    || state.idempotency_key !== request.idempotency_key
    || state.operation !== request.operation || state.execution_owner_id !== ownerId) {
    return providerFail('OPERATION_STATE_MISMATCH', 'operation journal is not bound to this exact request')
  }
  const expectedOrder = OPERATION_PHASES[request.operation as keyof typeof OPERATION_PHASES] ?? []
  const actualKeys = Object.keys(state.phases)
  const admittedPrefix = expectedOrder.slice(0, actualKeys.length)
  if (actualKeys.length !== new Set(actualKeys).size || actualKeys.some(key => !admittedPrefix.includes(key as FleetRuntimeLocalPhase))
    || admittedPrefix.some(key => !Object.hasOwn(state.phases, key))) {
    return providerFail('STATE_RECORD_INVALID', 'operation phases are missing, extra, duplicate, or out of order')
  }
  for (const phaseName of admittedPrefix) {
    const phase = state.phases[phaseName]!
    if (!phase || phase.intent === null || typeof phase.intent !== 'object' || Array.isArray(phase.intent)) {
      return providerFail('STATE_RECORD_INVALID', 'operation phase lacks an immutable intent')
    }
    if (phase.intent_sha256 !== sha256(canonicalFleetRuntimeJson(phase.intent))
      || (phase.status === 'started' && (phase.completed_at !== null || phase.evidence !== null || phase.evidence_sha256 !== null))
      || (phase.status === 'completed' && (!phase.completed_at || !phase.evidence || phase.evidence_sha256 !== sha256(canonicalFleetRuntimeJson(phase.evidence))))
      || phase.protected_effect_count !== (phase.status === 'completed' && PROTECTED_PHASES.has(phaseName) ? 1 : 0)) {
      return providerFail('STATE_RECORD_INVALID', 'operation phase intent, evidence, status, or protected-effect count is invalid')
    }
  }
}

class FleetRuntimeLocalEffectPort {
  constructor(
    private readonly persistence: FileFleetRuntimeV1Persistence,
    private readonly system: FleetRuntimeLocalSystem,
    private readonly now: () => string,
  ) {}

  private journalPath(request: FleetRuntimeRequest): string {
    return join(this.persistence.invocationDirectory(request.idempotency_key), 'operation-state.json')
  }

  private loadJournal(request: FleetRuntimeRequest): FleetRuntimeLocalOperationState {
    const path = this.journalPath(request)
    if (!existsSync(path)) {
      return {
        schema_version: STATE_SCHEMA,
        request_id: request.request_id,
        request_digest: request.request_digest,
        idempotency_key: request.idempotency_key,
        operation: request.operation,
        execution_owner_id: this.persistence.owner.owner_id,
        phases: {},
      }
    }
    const state = readState<FleetRuntimeLocalOperationState>(this.persistence.root, path, 'operation state')
    assertJournal(state, request, state.execution_owner_id)
    if (state.execution_owner_id !== this.persistence.owner.owner_id) {
      this.persistence.assertOwner(request.idempotency_key)
      state.execution_owner_id = this.persistence.owner.owner_id
      atomicWrite(this.persistence.root, path, state)
    }
    return state
  }

  private context(
    request: FleetRuntimeRequest,
    state: FleetRuntimeLocalOperationState,
    currentIntent: Record<string, unknown> = {},
    predecessorRawBody = '',
  ): FleetRuntimeLocalPhaseContext {
    return {
      state_directory: this.persistence.root,
      invocation_directory: this.persistence.invocationDirectory(request.idempotency_key),
      prior_evidence: Object.fromEntries(
        Object.entries(state.phases)
          .filter((entry): entry is [FleetRuntimeLocalPhase, FleetRuntimeLocalPhaseState] => entry[1]?.status === 'completed')
          .map(([phase, entry]) => [phase, clone(entry.evidence ?? {})]),
      ),
      current_intent: clone(currentIntent),
      predecessor_receipt_raw_body: predecessorRawBody,
    }
  }

  async perform_once(
    readonlyRequest: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
  ): Promise<FleetRuntimeEffectReceipt> {
    const request = readonlyRequest as FleetRuntimeRequest
    if (request.stage_id !== 'N40-P4-CANARY-VERIFY'
      || request.target_scope.repositories.length !== 1
      || request.target_scope.repositories[0] !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.target_repository) {
      return providerFail('TARGET_NOT_ADMITTED', 'local provider admits only the exact N40 Kodama canary')
    }
    const phases = OPERATION_PHASES[request.operation as keyof typeof OPERATION_PHASES]
    if (!phases) return providerFail('TARGET_NOT_ADMITTED', 'local provider admits only the four N40 operations')
    const state = this.loadJournal(request)
    assertJournal(state, request, this.persistence.owner.owner_id)

    for (const phase of phases) {
      const prior = state.phases[phase]
      if (prior?.status === 'completed') continue
      if (prior?.status === 'started') {
        await this.persistence.heartbeatOwner(request.idempotency_key)
        const reconciled = await this.system.reconcilePhase(request, preflight, phase, this.context(request, state, prior.intent, preflight.predecessor_receipt_raw_body))
        if (!reconciled.completed || !reconciled.evidence) {
          return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', `${phase} started but cannot be proven complete; it will not be repeated`)
        }
        prior.status = 'completed'
        prior.completed_at = this.now()
        prior.evidence = clone(reconciled.evidence)
        prior.evidence_sha256 = sha256(canonicalFleetRuntimeJson(prior.evidence))
        prior.protected_effect_count = reconciled.protected_effect_count
        this.persistence.assertOwner(request.idempotency_key)
        atomicWrite(this.persistence.root, this.journalPath(request), state)
        this.persistence.assertOwner(request.idempotency_key)
        continue
      }

      const intentContext = this.context(request, state, {}, preflight.predecessor_receipt_raw_body)
      const intent = this.system.phaseIntent ? await this.system.phaseIntent(request, phase, intentContext) : {}
      state.phases[phase] = {
        status: 'started',
        started_at: this.now(),
        completed_at: null,
        evidence: null,
        intent: clone(intent),
        protected_effect_count: 0,
        intent_sha256: sha256(canonicalFleetRuntimeJson(intent)),
        evidence_sha256: null,
      }
      this.persistence.assertOwner(request.idempotency_key)
      atomicWrite(this.persistence.root, this.journalPath(request), state)
      this.persistence.assertOwner(request.idempotency_key)
      await this.persistence.heartbeatOwner(request.idempotency_key)
      const result = await this.system.performPhase(request, preflight, phase, this.context(request, state, intent, preflight.predecessor_receipt_raw_body))
      this.persistence.assertOwner(request.idempotency_key)
      if (PROTECTED_PHASES.has(phase) && result.protected_effect_count !== 1) {
        return providerFail('STATE_RECORD_INVALID', `${phase} must report exactly one protected subeffect`)
      }
      if (!PROTECTED_PHASES.has(phase) && result.protected_effect_count !== 0) {
        return providerFail('STATE_RECORD_INVALID', `${phase} reported an unauthorized protected subeffect`)
      }
      state.phases[phase] = {
        status: 'completed',
        started_at: state.phases[phase]!.started_at,
        completed_at: this.now(),
        evidence: clone(result.evidence),
        intent: clone(intent),
        protected_effect_count: result.protected_effect_count,
        intent_sha256: sha256(canonicalFleetRuntimeJson(intent)),
        evidence_sha256: sha256(canonicalFleetRuntimeJson(result.evidence)),
      }
      atomicWrite(this.persistence.root, this.journalPath(request), state)
      this.persistence.assertOwner(request.idempotency_key)
    }
    return this.system.buildReceipt(request, preflight, state)
  }
}

export interface FleetRuntimeV1DryRunReceipt {
  schema_version: 'fleet-runtime-v1/typed-block-receipt/v1'
  request_id: string
  request_digest: string
  stage_id: string
  operation: string
  code: 'PROTECTED_EFFECTS_DISABLED'
  detail: string
  effect_started: false
  filesystem_write_count: 0
  database_write_count: 0
  queue_write_count: 0
  protected_effect_count: 0
  observed_at: string
}

/** Deterministic and side-effect free. It validates through the audited adapter before returning. */
export function buildFleetRuntimeV1DryRunReceipt(untrustedRequest: FleetRuntimeRequest): FleetRuntimeV1DryRunReceipt {
  const request = prepareFleetRuntimeV1Request(untrustedRequest)
  return {
    schema_version: 'fleet-runtime-v1/typed-block-receipt/v1',
    request_id: request.request_id,
    request_digest: request.request_digest,
    stage_id: request.stage_id,
    operation: request.operation,
    code: 'PROTECTED_EFFECTS_DISABLED',
    detail: 'Re-run only under the separately authorized executor binding with --execute-protected-effects.',
    effect_started: false,
    filesystem_write_count: 0,
    database_write_count: 0,
    queue_write_count: 0,
    protected_effect_count: 0,
    observed_at: request.queue_precheck.observed_at,
  }
}

export async function executeLocalFleetRuntimeV1(input: {
  request: FleetRuntimeRequest
  stateDirectory: string
  approvedStateRoot?: string
  executeProtectedEffects: boolean
  system: FleetRuntimeLocalSystem
  now?: () => string
  persistenceOptions?: Omit<FleetRuntimePersistenceOptions, 'approvedRoot'>
}): Promise<FleetRuntimeEffectReceipt | FleetRuntimeV1DryRunReceipt> {
  if (!input.executeProtectedEffects) return buildFleetRuntimeV1DryRunReceipt(input.request)
  if (input.request.executor_identity.actor_agent_id !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.required_executor.actor_agent_id
    || input.request.executor_identity.active_function !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.required_executor.active_function) {
    return providerFail('EXECUTOR_BINDING_MISMATCH', 'protected execution requires the exact registered executor binding')
  }
  const persistence = new FileFleetRuntimeV1Persistence(input.stateDirectory, {
    ...input.persistenceOptions,
    approvedRoot: input.approvedStateRoot ?? FLEET_RUNTIME_V1_PRODUCTION_STATE_ROOT,
  })
  const effect = new FleetRuntimeLocalEffectPort(persistence, input.system, input.now ?? (() => new Date().toISOString()))
  if (ACTIVE_LOCAL_INVOCATIONS.has(input.request.idempotency_key)) {
    return providerFail('IN_FLIGHT', 'the invocation is already active in this executor process')
  }
  ACTIVE_LOCAL_INVOCATIONS.add(input.request.idempotency_key)
  try {
    return await executeFleetRuntimeV1(input.request, {
      preflight: { inspect: request => input.system.inspect(request) },
      persistence,
      effect,
    })
  } finally {
    ACTIVE_LOCAL_INVOCATIONS.delete(input.request.idempotency_key)
  }
}

export interface FleetRuntimeArgvResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface FleetRuntimeArgvRunner {
  run(argv: readonly string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<FleetRuntimeArgvResult>
}

export const bunFleetRuntimeArgvRunner: FleetRuntimeArgvRunner = {
  async run(argv, options = {}) {
    if (argv.length === 0 || argv.some(argument => argument.includes('\0'))) {
      return providerFail('COMMAND_FAILED', 'argv must be nonempty and cannot contain NUL')
    }
    const child = Bun.spawn({
      cmd: [...argv],
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { exitCode, stdout, stderr }
  },
}

interface GitHubCommentReadback {
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}

interface GitTreeEntry {
  path: string
  mode: string
  type: string
  size?: number
  sha: string
}

interface FleetRuntimePayloadManifest {
  files: Array<{ path: string; bytes: number; sha256: string }>
  payload_records_sha256: string
  path_count: number
}

function commentId(url: string): string {
  const matched = url.match(/#issuecomment-([1-9][0-9]*)$/)
  if (!matched) return providerFail('READBACK_INVALID', 'evidence URL is not an immutable issue comment')
  return matched[1]
}

function normalizeTreeEntry(entry: GitTreeEntry): { path: string; mode: string; type: string; size: number | null; sha: string } {
  return { path: entry.path, mode: entry.mode, type: entry.type, size: entry.size ?? null, sha: entry.sha }
}

function surfaceDigest(entries: GitTreeEntry[], runtime: boolean): { count: number; digest: string } {
  const selected = entries
    .filter(entry => entry.type === 'blob')
    .filter(entry => runtime
      ? entry.path === '.github/workflows/shirube-rapid-lite-gates-report.yml' || entry.path.startsWith('.shirube/runtime/rapid-lite/')
      : entry.path === '.github/workflows/shirube-rapid-lite-gates-report.yml' || entry.path.startsWith('.shirube/') || entry.path.startsWith('docs/shirube/'))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(normalizeTreeEntry)
  return { count: selected.length, digest: sha256(canonicalFleetRuntimeJson(selected)) }
}

function recursiveRelativeFiles(root: string, cursor = root): string[] {
  if (!existsSync(cursor)) return []
  const files: string[] = []
  for (const name of readdirSync(cursor).sort()) {
    const path = join(cursor, name)
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) return providerFail('PAYLOAD_VERIFICATION_FAILED', `payload path is a symlink: ${path}`)
    if (metadata.isDirectory()) files.push(...recursiveRelativeFiles(root, path))
    else if (metadata.isFile()) files.push(relative(root, path).split(sep).join('/'))
    else return providerFail('PAYLOAD_VERIFICATION_FAILED', `payload path is not a regular file: ${path}`)
  }
  return files
}

function commandError(argv: readonly string[], result: FleetRuntimeArgvResult): never {
  const diagnostic = result.stderr.trim().slice(0, 400).replace(/[\r\n]+/g, ' ')
  return providerFail('COMMAND_FAILED', `${argv[0]} exited ${result.exitCode}${diagnostic ? `: ${diagnostic}` : ''}`)
}

/**
 * The production system is intentionally argv-only. Protected execution is
 * unreachable unless the caller supplies the explicit flag and the adapter
 * admits the exact owner-bound executor/request.
 */
export class ConcreteFleetRuntimeV1LocalSystem implements FleetRuntimeLocalSystem {
  constructor(
    private readonly runner: FleetRuntimeArgvRunner = bunFleetRuntimeArgvRunner,
    private readonly providerRepositoryRoot: string = resolve(import.meta.dir, '..'),
    private readonly nowMs: () => number = Date.now,
  ) {}

  private async run(argv: readonly string[], cwd?: string): Promise<string> {
    const result = await this.runner.run(argv, { cwd })
    if (result.exitCode !== 0) return commandError(argv, result)
    return result.stdout
  }

  private async ghJson<T>(path: string): Promise<T> {
    return parseJson<T>(await this.run(['gh', 'api', path]), `gh api ${path}`)
  }

  private async comment(url: string): Promise<GitHubCommentReadback> {
    return this.ghJson<GitHubCommentReadback>(`repos/watchout/ai-dev-framework/issues/comments/${commentId(url)}`)
  }

  private async remotePreimage(request: FleetRuntimeRequest) {
    const expected = request.preimages[0]
    const observed = await this.remoteSurface(expected.required_base_branch)
    return {
      repository: 'watchout/kodama' as const,
      required_base_branch: expected.required_base_branch,
      ...observed,
    }
  }

  private async remoteSurface(branch: string) {
    const ref = await this.ghJson<{ object: { sha: string } }>(`repos/watchout/kodama/git/ref/heads/${branch}`)
    const commit = await this.ghJson<{ sha: string; tree: { sha: string } }>(`repos/watchout/kodama/git/commits/${ref.object.sha}`)
    const tree = await this.ghJson<{ truncated: boolean; tree: GitTreeEntry[] }>(`repos/watchout/kodama/git/trees/${commit.tree.sha}?recursive=1`)
    if (tree.truncated) return providerFail('READBACK_INVALID', 'remote recursive tree readback was truncated')
    const runtime = surfaceDigest(tree.tree, true)
    const distribution = surfaceDigest(tree.tree, false)
    return {
      head_commit: commit.sha,
      tree: commit.tree.sha,
      runtime_surface_entry_count: runtime.count,
      runtime_surface_sha256: runtime.digest,
      distribution_surface_entry_count: distribution.count,
      distribution_surface_sha256: distribution.digest,
    }
  }

  private queueFromStatus(report: unknown, request: FleetRuntimeRequest): FleetRuntimeRequest['queue_precheck'] {
    const parsed = parseFleetRuntimeQueueStatus(report, this.nowMs())
    if (parsed.observed_at !== request.queue_precheck.observed_at) {
      return providerFail('READBACK_INVALID', 'official queue timestamp differs from the sealed request')
    }
    return parsed
  }

  async inspect(readonlyRequest: Readonly<FleetRuntimeRequest>): Promise<FleetRuntimePreflightReceipt> {
    const request = readonlyRequest as FleetRuntimeRequest
    const [owner, predecessor, preimage, statusRaw, rootRaw, inventoryRaw, executorProfileRaw] = await Promise.all([
      this.comment(request.owner_decision.url),
      this.comment(request.predecessor_receipt.url),
      this.remotePreimage(request),
      this.run([process.execPath, 'cli/index.ts', 'status', '--format', 'json'], this.providerRepositoryRoot),
      this.run([
        'node', 'dist/cli/index.js', 'goal-runtime', 'status', '--store',
        '/Users/yuji/Developer/kodama/.framework/runtime/goal-convergence.json', '--format', 'json',
      ], '/Users/yuji/Developer/ai-dev-framework'),
      this.run([process.execPath, 'cli/index.ts', 'runtime', 'inventory', '--format', 'json'], this.providerRepositoryRoot),
      this.run([
        process.execPath, 'cli/index.ts', 'agent', 'profile', 'get',
        FLEET_RUNTIME_V1_LOCAL_PROVIDER.required_executor.actor_agent_id,
      ], this.providerRepositoryRoot),
    ])
    if (owner.user.login !== request.owner_decision.actor
      || owner.created_at !== request.owner_decision.created_at
      || owner.updated_at !== request.owner_decision.updated_at
      || sha256(owner.body) !== request.owner_decision.raw_api_body_sha256) {
      return providerFail('READBACK_INVALID', 'immutable owner readback differs')
    }
    if (sha256(predecessor.body) !== request.predecessor_receipt.sha256) {
      return providerFail('READBACK_INVALID', 'predecessor raw-body digest differs')
    }
    validateFleetRuntimeImmutableSemantics(request, owner.body, predecessor.body)
    const queue = this.queueFromStatus(parseJson(statusRaw, 'official queue status'), request)
    if (canonicalFleetRuntimeJson(queue) !== canonicalFleetRuntimeJson(request.queue_precheck)) {
      return providerFail('READBACK_INVALID', 'fresh official queue receipt differs from request')
    }
    const inventory = parseJson<Record<string, unknown>>(inventoryRaw, 'runtime inventory')
    if (!canonicalFleetRuntimeJson(inventory).includes('kodama')) {
      return providerFail('READBACK_INVALID', 'runtime inventory omitted kodama')
    }
    const executorProfileEnvelope = parseJson<Record<string, unknown>>(executorProfileRaw, 'executor profile')
    const executorProfile = executorProfileEnvelope.profile as Record<string, unknown> | undefined
    if (executorProfileEnvelope.ok !== true
      || executorProfile?.agent_id !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.required_executor.actor_agent_id
      || executorProfile.profile_enabled !== true || executorProfile.status === 'disabled') {
      return providerFail('EXECUTOR_BINDING_MISMATCH', 'registered executor profile is absent, disabled, or drifted')
    }
    return {
      schema_version: 'fleet-runtime-v1/preflight-receipt/v1',
      request_digest: request.request_digest,
      observed_at: request.queue_precheck.observed_at,
      owner_decision_readback: clone(request.owner_decision),
      owner_decision_raw_body: owner.body,
      predecessor_receipt_readback: clone(request.predecessor_receipt),
      predecessor_receipt_raw_body: predecessor.body,
      target_preimages: [preimage],
      queue_precheck: queue,
      root_goal_readbacks: [parseFleetRuntimeRootGoalReadback(parseJson(rootRaw, 'root-goal status'))],
      filesystem_write_count: 0,
      database_write_count: 0,
      queue_write_count: 0,
      protected_effect_count: 0,
    }
  }

  private checkoutPath(context: FleetRuntimeLocalPhaseContext): string {
    return assertSafeStatePath(context.state_directory, join(context.invocation_directory, 'checkout'))
  }

  private async verifyCheckout(
    path: string,
    stateDirectory: string,
    expectedHead?: string,
    expectedTree?: string,
  ): Promise<Record<string, unknown>> {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) {
      return providerFail('UNSAFE_CHECKOUT', 'checkout must be a real, dedicated directory')
    }
    const remote = (await this.run(['git', 'remote', 'get-url', 'origin'], path)).trim()
    const head = (await this.run(['git', 'rev-parse', 'HEAD'], path)).trim()
    const tree = (await this.run(['git', 'rev-parse', 'HEAD^{tree}'], path)).trim()
    const status = await this.run(['git', 'status', '--porcelain=v1'], path)
    validateFleetRuntimeCheckoutReadback({
      checkout_path: path,
      state_directory: stateDirectory,
      canonical_path: '/Users/yuji/Developer/kodama',
      remote,
      head,
      tree,
      status_porcelain: status,
      expected_head: expectedHead,
      expected_tree: expectedTree,
    })
    return { checkout_path: path, remote, head, tree, clean: true }
  }

  private async verifyReleaseCheckout(path: string, stateDirectory: string): Promise<Record<string, unknown>> {
    assertSafeStatePath(stateDirectory, path)
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path
      || path === '/Users/yuji/Developer/ai-dev-framework') {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'release checkout must be a dedicated real state descendant')
    }
    const remote = (await this.run(['git', 'remote', 'get-url', 'origin'], path)).trim()
    const head = (await this.run(['git', 'rev-parse', 'HEAD'], path)).trim()
    const tree = (await this.run(['git', 'rev-parse', 'HEAD^{tree}'], path)).trim()
    const status = await this.run(['git', 'status', '--porcelain=v1'], path)
    const branch = (await this.run(['git', 'branch', '--show-current'], path)).trim()
    if (!new Set(['https://github.com/watchout/ai-dev-framework.git', 'git@github.com:watchout/ai-dev-framework.git']).has(remote)
      || head !== FLEET_RUNTIME_V1_CONTRACT.release_commit || tree !== FLEET_RUNTIME_V1_CONTRACT.release_tree
      || status !== '' || branch !== '') {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'release checkout origin, image, detached state, or cleanliness differs')
    }
    return { checkout_path: path, remote, head, tree, clean: true, detached: true }
  }

  phaseIntent(
    readonlyRequest: Readonly<FleetRuntimeRequest>,
    phase: FleetRuntimeLocalPhase,
    readonlyContext: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Record<string, unknown> {
    const request = readonlyRequest as FleetRuntimeRequest
    const context = readonlyContext as FleetRuntimeLocalPhaseContext
    const prepared = context.prior_evidence.PREPARE_CLEAN_CHECKOUT
    const merged = context.prior_evidence.VERIFY_EXTERNAL_MERGE
    const local = context.prior_evidence.CREATE_LOCAL_COMMIT ?? context.prior_evidence.CREATE_LOCAL_REVERT
    const pushed = context.prior_evidence.PUSH_NORMAL_BRANCH
    const created = context.prior_evidence.CREATE_DRAFT_PR
    if (phase === 'PREPARE_CLEAN_CHECKOUT') {
      const input = this.operationInputReceipt(request, context)
      return {
        expected_head: request.operation === 'ROLLBACK' || request.operation === 'RECOVERY'
          ? String(input?.merge_commit ?? '') : request.preimages[0].head_commit,
        expected_tree: request.operation === 'ROLLBACK' || request.operation === 'RECOVERY'
          ? String(input?.merge_tree ?? '') : request.preimages[0].tree,
      }
    }
    if (phase === 'PREPARE_MERGED_CHECKOUT') {
      return { expected_head: merged?.merge_commit, expected_tree: merged?.merge_tree }
    }
    if (phase === 'VERIFY_EXACT_PREIMAGE') {
      return request.operation === 'ROLLBACK'
        ? { expected_head: merged?.merge_commit, expected_tree: request.preimages[0].tree }
        : { expected_head: prepared?.head, expected_tree: request.preimages[0].tree }
    }
    if (phase === 'PUSH_NORMAL_BRANCH') return { branch: local?.branch, head: local?.head, force: false }
    if (phase === 'CREATE_DRAFT_PR') {
      return { repository: 'watchout/kodama', base: request.preimages[0].required_base_branch, branch: pushed?.branch, head: pushed?.head }
    }
    if (phase === 'VERIFY_EXTERNAL_MERGE') {
      return {
        repository: 'watchout/kodama', operation: request.operation, request_digest: request.request_digest,
        pr_url: created?.pr_url, pushed_head: pushed?.head, base: request.preimages[0].required_base_branch,
      }
    }
    if (phase === 'COLD_START_DISCORD_KODAMA' || phase === 'VERIFY_LIVE_IDENTITY') {
      return {
        checkout_path: this.checkoutPath(context), session: FLEET_RUNTIME_V1_LOCAL_PROVIDER.target_session,
        port: FLEET_RUNTIME_V1_LOCAL_PROVIDER.target_port,
        expected_head: merged?.merge_commit ?? prepared?.head,
        expected_tree: merged?.merge_tree ?? (request.operation === 'RECOVERY' ? request.preimages[0].tree : prepared?.tree),
      }
    }
    return {}
  }

  private operationInputReceipt(
    request: FleetRuntimeRequest,
    context: FleetRuntimeLocalPhaseContext,
  ): Record<string, unknown> | null {
    if (request.operation === 'CANARY_COLD_START') return null
    if (!context.predecessor_receipt_raw_body) {
      return providerFail('READBACK_INVALID', `${request.operation} requires immutable predecessor bytes`)
    }
    return validateFleetRuntimePredecessorReceipt(request, context.predecessor_receipt_raw_body)
  }

  private async prepareCheckout(request: FleetRuntimeRequest, context: FleetRuntimeLocalPhaseContext): Promise<Record<string, unknown>> {
    const path = this.checkoutPath(context)
    const operationInput = this.operationInputReceipt(request, context)
    const inputHead = request.operation === 'ROLLBACK' || request.operation === 'RECOVERY'
      ? String(operationInput!.merge_commit)
      : request.preimages[0].head_commit
    const inputTree = request.operation === 'ROLLBACK' || request.operation === 'RECOVERY'
      ? String(operationInput!.merge_tree)
      : request.preimages[0].tree
    if (!existsSync(path)) {
      await this.run(['git', 'clone', '--no-checkout', 'https://github.com/watchout/kodama.git', path])
      await this.run(['git', 'checkout', '--detach', inputHead], path)
    }
    const evidence = await this.verifyCheckout(path, context.state_directory, inputHead, inputTree)
    if (request.operation === 'RECOVERY' && inputTree !== request.preimages[0].tree) {
      return providerFail('READBACK_INVALID', 'recovery input tree is not the exact frozen preimage tree')
    }
    const inventory = parseJson<Record<string, unknown>>(await this.run([
      process.execPath, 'cli/index.ts', 'runtime', 'inventory', '--format', 'json',
    ], this.providerRepositoryRoot), 'baseline runtime inventory')
    const baseline = findAgentRecord(inventory, 'kodama')
    return {
      ...evidence,
      baseline_runtime_instance_id: baseline?.latest_runtime_instance_id ?? baseline?.runtime_instance_id ?? null,
      ...(request.operation === 'REAPPLY' ? { rollback_receipt_sha256: operationInput!.rollback_receipt_sha256 } : {}),
    }
  }

  private async externalMerge(request: FleetRuntimeRequest, context: FleetRuntimeLocalPhaseContext): Promise<Record<string, unknown>> {
    const path = join(context.invocation_directory, 'external-merge-receipt.json')
    if (!existsSync(path)) return providerFail('WAITING_INDEPENDENT_MERGE', 'exact external merge receipt is not present')
    assertSafeStatePath(context.state_directory, path)
    const raw = readFileSync(path, 'utf8')
    const receipt = parseJson<Record<string, unknown>>(raw, 'external merge receipt')
    if (raw !== `${canonicalFleetRuntimeJson(receipt)}\n`) {
      return providerFail('READBACK_INVALID', 'external merge receipt bytes are not canonical JSON plus LF')
    }
    if (receipt.request_digest !== request.request_digest || receipt.operation !== request.operation
      || receipt.repository !== 'watchout/kodama' || receipt.base !== request.preimages[0].required_base_branch
      || typeof receipt.pr_url !== 'string' || !COMMIT.test(String(receipt.merge_commit)) || !COMMIT.test(String(receipt.merge_tree))) {
      return providerFail('READBACK_INVALID', 'external merge receipt binding is invalid')
    }
    const pr = parseJson<Record<string, unknown>>(await this.run([
      'gh', 'pr', 'view', String(receipt.pr_url), '--repo', 'watchout/kodama',
      '--json', 'url,state,mergedAt,mergeCommit,headRefOid,baseRefName,isDraft',
    ]), 'merged PR readback')
    const commit = await this.ghJson<{ tree: { sha: string } }>(`repos/watchout/kodama/git/commits/${String(receipt.merge_commit)}`)
    validateFleetRuntimeExternalMergeBinding({
      request,
      receipt,
      pr,
      createdPrUrl: String(context.current_intent.pr_url ?? ''),
      pushedHead: String(context.current_intent.pushed_head ?? ''),
      observedMergeTree: commit.tree.sha,
    })
    return clone(receipt)
  }

  private async payloadManifest(request: FleetRuntimeRequest): Promise<FleetRuntimePayloadManifest> {
    const envelope = await this.ghJson<{ encoding: string; content: string }>(
      'repos/watchout/ai-dev-framework/contents/releases/shirube-v4.1/target-payload-manifest.json?ref=9ab2be2476735d7ccc8bafb105a1dd0e7bff9df3',
    )
    if (envelope.encoding !== 'base64' || typeof envelope.content !== 'string') {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'payload manifest API encoding differs')
    }
    const manifest = parseJson<FleetRuntimePayloadManifest>(
      Buffer.from(envelope.content.replace(/\s+/g, ''), 'base64').toString('utf8'),
      'payload manifest',
    )
    if (!Array.isArray(manifest.files)) return providerFail('PAYLOAD_VERIFICATION_FAILED', 'payload manifest files are absent')
    const paths = manifest.files.map(file => file.path)
    assertExactFleetRuntimePathSet([...paths].sort(), paths, 'manifest ordering')
    if (manifest.path_count !== 24 || manifest.files.some(file => !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA256.test(file.sha256))
      || sha256(canonicalFleetRuntimeJson(manifest.files)) !== request.payload_digest) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'aggregate payload manifest differs')
    }
    return manifest
  }

  async performPhase(
    readonlyRequest: Readonly<FleetRuntimeRequest>,
    _preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalPhaseResult> {
    const request = readonlyRequest as FleetRuntimeRequest
    const mutableContext = context as FleetRuntimeLocalPhaseContext
    const checkout = this.checkoutPath(mutableContext)
    if (phase === 'PREPARE_CLEAN_CHECKOUT') {
      return { evidence: await this.prepareCheckout(request, mutableContext), protected_effect_count: 0 }
    }
    if (phase === 'VERIFY_EXTERNAL_MERGE') {
      return { evidence: await this.externalMerge(request, mutableContext), protected_effect_count: 0 }
    }
    if (phase === 'PREPARE_MERGED_CHECKOUT') {
      const receipt = context.prior_evidence.VERIFY_EXTERNAL_MERGE
      const mergeCommit = String(receipt?.merge_commit ?? '')
      const mergeTree = String(receipt?.merge_tree ?? '')
      await this.run(['git', 'fetch', 'origin', mergeCommit], checkout)
      await this.run(['git', 'checkout', '--detach', mergeCommit], checkout)
      return { evidence: await this.verifyCheckout(checkout, context.state_directory, mergeCommit, mergeTree), protected_effect_count: 0 }
    }
    if (phase === 'VERIFY_EXACT_PREIMAGE') {
      return { evidence: await this.verifyCheckout(checkout, context.state_directory, String(context.current_intent.expected_head ?? '') || undefined, String(context.current_intent.expected_tree ?? '') || undefined), protected_effect_count: 0 }
    }
    if (phase === 'STAGE_EXACT_PAYLOAD' || phase === 'VERIFY_EXACT_PAYLOAD') {
      // The released renderer is the sole byte source. It is invoked with its
      // frozen argv contract; the selected 24 records are then checked by the
      // immutable payload manifest before any push is admitted.
      const out = join(context.invocation_directory, 'rendered')
      if (phase === 'STAGE_EXACT_PAYLOAD') {
        const manifest = await this.payloadManifest(request)
        const payloadPaths = manifest.files.map(file => file.path)
        const releaseCheckout = join(context.invocation_directory, 'adf-release')
        if (!existsSync(releaseCheckout)) {
          await this.run(['git', 'clone', '--no-checkout', 'https://github.com/watchout/ai-dev-framework.git', releaseCheckout])
          await this.run(['git', 'checkout', '--detach', FLEET_RUNTIME_V1_CONTRACT.release_commit], releaseCheckout)
        }
        const releaseBefore = await this.verifyReleaseCheckout(releaseCheckout, context.state_directory)
        safeMkdir(context.state_directory, out)
        await this.run([
          'node', 'scripts/shirube/render-adoption-pack.mjs', '--profile', 'hotel-lite',
          '--target-repo', 'watchout/kodama', '--product', 'Kodama',
          '--source-control', 'watchout/ai-dev-framework#576',
          '--framework-ref', `watchout/ai-dev-framework@${FLEET_RUNTIME_V1_CONTRACT.release_commit}`,
          '--owner-actor', 'watchout',
          '--owner-confirmation-ref', 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-5260213858',
          '--cell-id', 'N40-P4-CANARY-VERIFY', '--mode', 'render', '--out', out, '--format', 'json',
          '--generated-at', '2026-08-12T00:00:00.000Z', '--fetched-at', '2026-08-12T00:00:00.000Z',
          '--generated-by', 'codex-cto', '--include-workflow-caller',
        ], releaseCheckout)
        const releaseAfter = await this.verifyReleaseCheckout(releaseCheckout, context.state_directory)
        if (realpathSync(out) !== out) return providerFail('PAYLOAD_VERIFICATION_FAILED', 'render output path is not real')
        assertExactFleetRuntimePathSet(payloadPaths, recursiveRelativeFiles(out), 'renderer output')
        const renderedBlobs: Record<string, { bytes: number; sha256: string }> = {}
        const renderedRows: Array<{ path: string; bytes: number; sha256: string }> = []
        for (const file of manifest.files) {
          const payloadPath = file.path
          const source = assertSafeStatePath(context.state_directory, join(out, payloadPath))
          const target = assertSafeStatePath(context.state_directory, join(checkout, payloadPath))
          const bytes = readFileSync(source)
          if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
            return providerFail('PAYLOAD_VERIFICATION_FAILED', `renderer bytes differ at ${payloadPath}`)
          }
          safeMkdir(context.state_directory, dirname(target))
          copyFileSync(source, target)
          renderedBlobs[payloadPath] = { bytes: bytes.byteLength, sha256: sha256(bytes) }
          renderedRows.push({ path: payloadPath, bytes: bytes.byteLength, sha256: sha256(bytes) })
        }
        validateFleetRuntimePayloadBlobLayer(manifest.files, renderedRows, 'renderer output blobs')
        return {
          evidence: {
            rendered_path: out, release_checkout_before: releaseBefore, release_checkout_after: releaseAfter,
            checkout_path: checkout, path_count: 24, payload_paths: payloadPaths, rendered_blobs: renderedBlobs,
          },
          protected_effect_count: 0,
        }
      }
      const manifest = await this.payloadManifest(request)
      const expectedPaths = manifest.files.map(file => file.path)
      const stagedPaths = context.prior_evidence.STAGE_EXACT_PAYLOAD?.payload_paths
      if (!Array.isArray(stagedPaths) || stagedPaths.some(path => typeof path !== 'string')) {
        return providerFail('PAYLOAD_VERIFICATION_FAILED', 'stage evidence lacks exact payload paths')
      }
      assertExactFleetRuntimePathSet(expectedPaths, stagedPaths as string[], 'stage evidence')
      const checkoutRows: Array<{ path: string; bytes: number; sha256: string }> = []
      for (const file of manifest.files) {
        const bytes = readFileSync(join(checkout, file.path))
        if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
          return providerFail('PAYLOAD_VERIFICATION_FAILED', `payload bytes differ at ${file.path}`)
        }
        checkoutRows.push({ path: file.path, bytes: bytes.byteLength, sha256: sha256(bytes) })
      }
      validateFleetRuntimePayloadBlobLayer(manifest.files, checkoutRows, 'checkout payload blobs')
      return { evidence: { payload_digest: request.payload_digest, path_count: 24, payload_paths: expectedPaths }, protected_effect_count: 0 }
    }
    if (phase === 'CREATE_LOCAL_COMMIT') {
      const branch = `shirube-v41-${request.operation.toLowerCase().replaceAll('_', '-')}-${request.request_digest.slice(-12)}`
      const paths = context.prior_evidence.VERIFY_EXACT_PAYLOAD?.payload_paths
      if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
        return providerFail('PAYLOAD_VERIFICATION_FAILED', 'verified payload path evidence is absent')
      }
      assertExactFleetRuntimePathSet([...paths as string[]].sort(), paths as string[], 'commit path evidence')
      await this.run(['git', 'switch', '-c', branch], checkout)
      await this.run(['git', 'add', '--', ...paths as string[]], checkout)
      const staged = (await this.run(['git', 'diff', '--cached', '--name-only'], checkout)).trim().split('\n').filter(Boolean).sort()
      assertExactFleetRuntimePathSet(paths as string[], staged, 'staged index')
      const manifest = await this.payloadManifest(request)
      const indexBlobs: Record<string, string> = {}
      const indexRows: Array<{ path: string; bytes: number; sha256: string }> = []
      for (const file of manifest.files) {
        const blob = (await this.run(['git', 'rev-parse', `:${file.path}`], checkout)).trim()
        const bytes = Buffer.from(await this.run(['git', 'cat-file', 'blob', blob], checkout))
        if (!COMMIT.test(blob) || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
          return providerFail('PAYLOAD_VERIFICATION_FAILED', `staged blob differs at ${file.path}`)
        }
        indexBlobs[file.path] = blob
        indexRows.push({ path: file.path, bytes: bytes.byteLength, sha256: sha256(bytes) })
      }
      validateFleetRuntimePayloadBlobLayer(manifest.files, indexRows, 'staged index blobs')
      await this.run(['git', 'commit', '-m', `chore(shirube): ${request.operation.toLowerCase().replaceAll('_', ' ')}`], checkout)
      const head = (await this.run(['git', 'rev-parse', 'HEAD'], checkout)).trim()
      const committed = (await this.run(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', head], checkout)).trim().split('\n').filter(Boolean).sort()
      assertExactFleetRuntimePathSet(paths as string[], committed, 'commit diff')
      const commitRows: Array<{ path: string; bytes: number; sha256: string }> = []
      for (const file of manifest.files) {
        const committedBlob = (await this.run(['git', 'rev-parse', `${head}:${file.path}`], checkout)).trim()
        if (committedBlob !== indexBlobs[file.path]) {
          return providerFail('PAYLOAD_VERIFICATION_FAILED', `committed blob differs from index at ${file.path}`)
        }
        const bytes = Buffer.from(await this.run(['git', 'cat-file', 'blob', committedBlob], checkout))
        commitRows.push({ path: file.path, bytes: bytes.byteLength, sha256: sha256(bytes) })
      }
      validateFleetRuntimePayloadBlobLayer(manifest.files, commitRows, 'committed payload blobs')
      return { evidence: { branch, head, payload_paths: paths, index_blobs: indexBlobs }, protected_effect_count: 0 }
    }
    if (phase === 'CREATE_LOCAL_REVERT') {
      const prior = this.operationInputReceipt(request, mutableContext)!
      const mergeCommit = String(prior.merge_commit ?? '')
      if (!COMMIT.test(mergeCommit)) return providerFail('READBACK_INVALID', 'canary merge commit is invalid')
      await this.run(['git', 'fetch', 'origin', mergeCommit], checkout)
      await this.run(['git', 'checkout', '--detach', mergeCommit], checkout)
      const branch = `shirube-v41-rollback-${request.request_digest.slice(-12)}`
      await this.run(['git', 'switch', '-c', branch], checkout)
      await this.run(['git', 'revert', '--no-edit', mergeCommit], checkout)
      const head = (await this.run(['git', 'rev-parse', 'HEAD'], checkout)).trim()
      return { evidence: { branch, head, reverted_merge: mergeCommit }, protected_effect_count: 0 }
    }
    if (phase === 'PUSH_NORMAL_BRANCH') {
      const local = context.prior_evidence.CREATE_LOCAL_COMMIT ?? context.prior_evidence.CREATE_LOCAL_REVERT
      const branch = String(local?.branch ?? '')
      const head = String(local?.head ?? '')
      if (!branch || !COMMIT.test(head)) return providerFail('READBACK_INVALID', 'local commit evidence is missing')
      await this.run(['git', 'push', 'origin', `${head}:refs/heads/${branch}`], checkout)
      return { evidence: { branch, head, force: false }, protected_effect_count: 1 }
    }
    if (phase === 'CREATE_DRAFT_PR') {
      const pushed = context.prior_evidence.PUSH_NORMAL_BRANCH
      const branch = String(pushed?.branch ?? '')
      const output = await this.run([
        'gh', 'pr', 'create', '--repo', 'watchout/kodama', '--draft', '--base', request.preimages[0].required_base_branch,
        '--head', branch, '--title', `Shirube V4.1 ${request.operation}`, '--body',
        `N40 provider request ${request.request_id}\n\nRequest digest: ${request.request_digest}\n\nRequires independent owner merge.`,
      ], checkout)
      const prUrl = output.trim().split(/\s+/).find(value => /^https:\/\/github\.com\/watchout\/kodama\/pull\/[1-9][0-9]*$/.test(value))
      if (!prUrl) return providerFail('READBACK_INVALID', 'gh did not return an exact Kodama PR URL')
      return { evidence: { pr_url: prUrl, branch, draft: true }, protected_effect_count: 1 }
    }
    if (phase === 'COLD_START_DISCORD_KODAMA') {
      const clean = await this.verifyCheckout(
        checkout,
        context.state_directory,
        String(context.current_intent.expected_head ?? '') || undefined,
        String(context.current_intent.expected_tree ?? '') || undefined,
      )
      const session = FLEET_RUNTIME_V1_LOCAL_PROVIDER.target_session
      await this.run(['tmux', 'kill-session', '-t', session]).catch(error => {
        if (!(error instanceof FleetRuntimeLocalProviderError)) throw error
      })
      const serverPath = join(this.providerRepositoryRoot, 'server.ts')
      const command = [
        'codex', '--dangerously-bypass-approvals-and-sandbox',
        '-c', 'mcp_servers.aun.enabled=true',
        '-c', `mcp_servers.aun.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.aun.args=${JSON.stringify(['run', serverPath])}`,
        '-c', 'mcp_servers.aun.env.AGENT_ID="kodama"',
        '-c', 'mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID="kodama"',
        '-c', 'mcp_servers.aun.env.WEBHOOK_PORT="8803"',
      ]
      await this.run(['tmux', 'new-session', '-d', '-s', session, '-c', checkout, ...command])
      return { evidence: { ...clean, session, port: 8803, argv: command }, protected_effect_count: 1 }
    }
    if (phase === 'VERIFY_LIVE_IDENTITY') {
      const checkoutImage = await this.verifyCheckout(
        checkout,
        context.state_directory,
        String(context.current_intent.expected_head ?? '') || undefined,
        String(context.current_intent.expected_tree ?? '') || undefined,
      )
      const inventory = parseJson<Record<string, unknown>>(await this.run([
        process.execPath, 'cli/index.ts', 'runtime', 'inventory', '--format', 'json',
      ], this.providerRepositoryRoot), 'runtime inventory')
      const status = parseJson<Record<string, unknown>>(await this.run([
        process.execPath, 'cli/index.ts', 'status', '--format', 'json',
      ], this.providerRepositoryRoot), 'official queue status')
      const queue = this.queueFromStatus(status, request)
      if (queue.entries[0].pending_count !== 0 || queue.entries[0].active_count !== 0) {
        return providerFail('READBACK_INVALID', 'queue changed during the protected operation')
      }
      const live = findAgentRecord(inventory, 'kodama')
      if (!live) return providerFail('READBACK_INVALID', 'live inventory lacks Kodama')
      const runtimeInstance = String(live.latest_runtime_instance_id ?? live.runtime_instance_id ?? '')
      const session = String(live.session_name ?? live.tmux_session ?? '')
      const port = Number(live.port ?? live.channel_port ?? 0)
      const checkoutPath = String(live.checkout_path ?? live.workspace ?? '')
      if (!runtimeInstance || session !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.target_session
        || port !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.target_port || checkoutPath !== checkout) {
        return providerFail('READBACK_INVALID', 'live runtime instance, session, port, or checkout differs')
      }
      const remoteImage = await this.remoteSurface(request.preimages[0].required_base_branch)
      const merged = context.prior_evidence.VERIFY_EXTERNAL_MERGE
      const prepared = context.prior_evidence.PREPARE_CLEAN_CHECKOUT
      const expectedHead = request.operation === 'RECOVERY'
        ? String(prepared?.head ?? '')
        : String(merged?.merge_commit ?? '')
      const expectedTree = request.operation === 'RECOVERY'
        ? request.preimages[0].tree
        : String(merged?.merge_tree ?? '')
      const baselineInstance = prepared?.baseline_runtime_instance_id
      if (typeof baselineInstance === 'string' && baselineInstance === runtimeInstance) {
        return providerFail('READBACK_INVALID', 'cold start did not create a fresh runtime_instance_id')
      }
      if (remoteImage.head_commit !== expectedHead || remoteImage.tree !== expectedTree) {
        return providerFail('READBACK_INVALID', 'live default-branch head/tree differs from the admitted operation image')
      }
      return {
        evidence: {
          inventory,
          local_checkout: checkoutImage,
          runtime_instance_id: runtimeInstance,
          remote_image: remoteImage,
          queue_unchanged: true,
          duplicate_effect_count: 0,
          unauthorized_effect_count: 0,
        },
        protected_effect_count: 0,
      }
    }
    return providerFail('COMMAND_FAILED', `unsupported phase ${phase}`)
  }

  async reconcilePhase(
    request: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalReconcileResult> {
    // Read-only reconciliation is explicit for every phase. A phase is never
    // blindly repeated after process loss.
    if (phase === 'VERIFY_EXTERNAL_MERGE') {
      const evidence = await this.externalMerge(request as FleetRuntimeRequest, context as FleetRuntimeLocalPhaseContext)
      return { completed: true, evidence, protected_effect_count: 0 }
    }
    if (phase === 'PREPARE_CLEAN_CHECKOUT' || phase === 'PREPARE_MERGED_CHECKOUT' || phase === 'VERIFY_EXACT_PREIMAGE') {
      const mutable = context as FleetRuntimeLocalPhaseContext
      const expectedHead = String(mutable.current_intent.expected_head ?? '')
      const expectedTree = String(mutable.current_intent.expected_tree ?? '')
      if (!COMMIT.test(expectedHead) || !COMMIT.test(expectedTree)) {
        return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', `${phase} persisted intent lacks exact head/tree`)
      }
      const evidence = await this.verifyCheckout(this.checkoutPath(mutable), mutable.state_directory, expectedHead, expectedTree)
      return { completed: true, evidence, protected_effect_count: 0 }
    }
    if (phase === 'VERIFY_EXACT_PAYLOAD' || phase === 'VERIFY_LIVE_IDENTITY') {
      const result = await this.performPhase(request, preflight, phase, context)
      return { completed: true, ...result }
    }
    if (phase === 'PUSH_NORMAL_BRANCH') {
      const branch = String(context.current_intent.branch ?? '')
      const head = String(context.current_intent.head ?? '')
      if (!branch || !COMMIT.test(head)) return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', 'push intent is incomplete')
      const observed = (await this.run(['git', 'ls-remote', '--heads', 'https://github.com/watchout/kodama.git', `refs/heads/${branch}`])).trim()
      if (observed !== `${head}\trefs/heads/${branch}`) return { completed: false, evidence: null, protected_effect_count: 1 }
      return { completed: true, evidence: { branch, head, force: false, reconciled: true }, protected_effect_count: 1 }
    }
    if (phase === 'CREATE_DRAFT_PR') {
      const branch = String(context.current_intent.branch ?? '')
      const head = String(context.current_intent.head ?? '')
      const base = String(context.current_intent.base ?? '')
      const rows = parseJson<Record<string, unknown>[]>(await this.run([
        'gh', 'pr', 'list', '--repo', 'watchout/kodama', '--state', 'all', '--head', branch,
        '--json', 'url,isDraft,headRefOid,baseRefName',
      ]), 'draft PR reconciliation')
      const exact = rows.filter(row => row.isDraft === true && row.headRefOid === head && row.baseRefName === base
        && /^https:\/\/github\.com\/watchout\/kodama\/pull\/[1-9][0-9]*$/.test(String(row.url)))
      if (exact.length !== 1) return { completed: false, evidence: null, protected_effect_count: 1 }
      return { completed: true, evidence: { pr_url: exact[0].url, branch, draft: true, reconciled: true }, protected_effect_count: 1 }
    }
    if (phase === 'COLD_START_DISCORD_KODAMA') {
      const mutable = context as FleetRuntimeLocalPhaseContext
      const expectedHead = String(mutable.current_intent.expected_head ?? '')
      const expectedTree = String(mutable.current_intent.expected_tree ?? '')
      if (!COMMIT.test(expectedHead) || !COMMIT.test(expectedTree)) {
        return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', 'cold-start intent lacks exact checkout image')
      }
      await this.verifyCheckout(this.checkoutPath(mutable), mutable.state_directory, expectedHead, expectedTree)
      const inventory = parseJson<Record<string, unknown>>(await this.run([
        process.execPath, 'cli/index.ts', 'runtime', 'inventory', '--format', 'json',
      ], this.providerRepositoryRoot), 'cold-start reconciliation inventory')
      const live = findAgentRecord(inventory, 'kodama')
      if (String(live?.session_name ?? live?.tmux_session ?? '') !== mutable.current_intent.session
        || Number(live?.port ?? live?.channel_port ?? 0) !== mutable.current_intent.port
        || String(live?.checkout_path ?? live?.workspace ?? '') !== mutable.current_intent.checkout_path) {
        return { completed: false, evidence: null, protected_effect_count: 1 }
      }
      return {
        completed: true,
        evidence: { checkout_path: mutable.current_intent.checkout_path, session: mutable.current_intent.session, port: mutable.current_intent.port, reconciled: true },
        protected_effect_count: 1,
      }
    }
    return { completed: false, evidence: null, protected_effect_count: PROTECTED_PHASES.has(phase) ? 1 : 0 }
  }

  async buildReceipt(
    readonlyRequest: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
    state: Readonly<FleetRuntimeLocalOperationState>,
  ): Promise<FleetRuntimeEffectReceipt> {
    const request = readonlyRequest as FleetRuntimeRequest
    const live = state.phases.VERIFY_LIVE_IDENTITY?.evidence
    const inventory = live?.inventory ?? null
    const remoteImage = live?.remote_image as Record<string, unknown> | undefined
    const merge = state.phases.VERIFY_EXTERNAL_MERGE?.evidence
    const image = {
      head_commit: typeof remoteImage?.head_commit === 'string'
        ? remoteImage.head_commit
        : typeof merge?.merge_commit === 'string' ? merge.merge_commit : request.preimages[0].head_commit,
      tree: typeof remoteImage?.tree === 'string'
        ? remoteImage.tree
        : typeof merge?.merge_tree === 'string' ? merge.merge_tree : request.preimages[0].tree,
      runtime_surface_sha256: typeof remoteImage?.runtime_surface_sha256 === 'string'
        ? remoteImage.runtime_surface_sha256
        : request.preimages[0].runtime_surface_sha256,
      distribution_surface_sha256: typeof remoteImage?.distribution_surface_sha256 === 'string'
        ? remoteImage.distribution_surface_sha256
        : request.preimages[0].distribution_surface_sha256,
      release: { commit: request.subject.release_commit, tree: request.subject.release_tree },
      config: { target: 'watchout/kodama' },
      policy: { executor: clone(request.executor_identity) },
      root: preflight.root_goal_readbacks[0].root,
      goal: { verdict: preflight.root_goal_readbacks[0].verdict },
      runtime_digest: preflight.root_goal_readbacks[0].runtime_digest,
      runtime_instance_id: typeof live?.runtime_instance_id === 'string'
        ? live.runtime_instance_id
        : sha256(canonicalFleetRuntimeJson(inventory)),
    }
    const started = Object.values(state.phases).map(item => item!.started_at).sort()[0]
    const completed = Object.values(state.phases).map(item => item!.completed_at!).sort().at(-1)!
    const receipt: FleetRuntimeEffectReceipt = {
      schema_version: request.operation === 'ROLLBACK'
        ? 'fleet-runtime-v1/rollback-receipt/v1'
        : request.operation === 'REAPPLY'
          ? 'fleet-runtime-v1/reapply-receipt/v1'
          : 'fleet-runtime-v1/effect-receipt/v1',
      receipt_id: `LOCAL-${request.request_id}`,
      receipt_sha256: `sha256:${'0'.repeat(64)}`,
      request_id: request.request_id,
      request_digest: request.request_digest,
      idempotency_key: request.idempotency_key,
      stage_id: request.stage_id,
      operation: request.operation,
      effect_id: `LOCAL-EFFECT-${request.idempotency_key.slice(-16)}`,
      actor_agent_id: request.executor_identity.actor_agent_id,
      active_function: request.executor_identity.active_function,
      started_at: started,
      completed_at: completed,
      result: 'PASS',
      per_target: [{
        repository: 'watchout/kodama',
        preimage: clone(request.preimages[0]),
        postimage: image,
        queue_precheck: clone(request.queue_precheck.entries[0]),
        root_goal_readback: clone(preflight.root_goal_readbacks[0]),
      }],
      duplicate_effect_count: 0,
      unauthorized_effect_count: 0,
    }
    const boundReceipt = receipt as FleetRuntimeEffectReceipt & Record<string, unknown>
    const predecessorSelf = request.operation === 'CANARY_COLD_START'
      ? null
      : validateFleetRuntimePredecessorReceipt(request, preflight.predecessor_receipt_raw_body).receipt_sha256 as string
    boundReceipt.subject_digest = sha256(canonicalFleetRuntimeJson(request.subject))
    boundReceipt.predecessor_receipt_sha256 = request.predecessor_receipt.sha256
    boundReceipt.predecessor_receipt_raw_body_sha256 = request.predecessor_receipt.sha256
    boundReceipt.predecessor_receipt_self_sha256 = predecessorSelf
    boundReceipt.target_repository = 'watchout/kodama'
    if (merge) {
      boundReceipt.merge_commit = merge.merge_commit
      boundReceipt.merge_tree = merge.merge_tree
      boundReceipt.pr_url = merge.pr_url
    }
    if (request.operation === 'ROLLBACK') {
      receipt.forward_effect_receipt_sha256 = request.predecessor_receipt.sha256
      receipt.target_repository = 'watchout/kodama'
      receipt.restored_preimage = clone(request.preimages[0])
      receipt.fresh_runtime_instance_readback = true
      receipt.queue_counts_unchanged = true
    }
    if (request.operation === 'RECOVERY') {
      boundReceipt.rollback_receipt_sha256 = predecessorSelf
    }
    if (request.operation === 'REAPPLY') {
      const rollbackDigest = state.phases.PREPARE_CLEAN_CHECKOUT?.evidence?.rollback_receipt_sha256
      if (!SHA256.test(String(rollbackDigest ?? ''))) {
        return providerFail('READBACK_INVALID', 'reapply journal lacks the exact rollback receipt digest')
      }
      receipt.rollback_receipt_sha256 = String(rollbackDigest)
      receipt.recovery_receipt_sha256 = request.predecessor_receipt.sha256
      receipt.target_repository = 'watchout/kodama'
      receipt.payload_digest = request.payload_digest
      receipt.postimage = clone(image)
    }
    receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt)
    validateFleetRuntimeLocalReceipt(receipt as FleetRuntimeEffectReceipt & Record<string, unknown>, {
      request,
      operation: request.operation,
      target: 'watchout/kodama',
      predecessorRawBodySha256: request.predecessor_receipt.sha256,
      predecessorSelfSha256: predecessorSelf,
    })
    return receipt
  }
}
