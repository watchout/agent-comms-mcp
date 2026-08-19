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
  rmdirSync,
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
import {
  assertFleetRuntimePreToPostObservation,
  assertFleetRuntimeQueueObservationV2,
  assertFleetRuntimeSealToPreObservation,
  type FleetRuntimeQueueObservationV2,
} from './fleet-runtime-v1-queue-observation'

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

export const FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT = Object.freeze({
  repository: 'watchout/ai-dev-framework',
  ref: 'd3c3be1394f509839db83c6ed57482178ebbaecd',
  tree: '45c288c35ef0af137b4d313555d7c86bf44b81aa',
  path: 'releases/shirube-v4.1/target-payload-amendment-20260819-001.json',
  schema_version: 'shirube-v4.1/target-payload-amendment/v1',
  artifact_state: 'FINAL_IMMUTABLE',
  amendment_id: 'TARGET-PAYLOAD-AMENDMENT-20260819-001',
  amendment_sha256: 'sha256:ab1c6f434637f946172fee97be3b5c084e6cbfde6a82dd9eaaca728c12f21134',
  amendment_byte_sha256: 'sha256:b9326f5f2eb1b56bed957ee2a0ea36da3beea651dff679c00f79bded9c1f0c55',
  previous_payload_digest: 'sha256:58eb8e4f49a8c2f42087ce17956bbef571d4650321e9c25e15726c0529c58973',
  effective_path_manifest_sha256: 'sha256:c50f3ef1e15d31e57a11c19278607ac70b5a7d59bbf11c1ee87e237f7001fec9',
  effective_payload_digest: FLEET_RUNTIME_V1_CONTRACT.payload_digest,
  renderer_path: 'scripts/shirube/render-adoption-pack.mjs',
  renderer_content_sha256: 'sha256:5a5c0f1723bb13f6f19c27860a917dde8c0e44cee2559db3ffe568c3d53d7061',
  renderer_blob: 'c3582da60dd8f005f5edbe2277cdc42636c5ec1a',
  workflow_template_path: 'templates/adoption-pack/hotel-lite/workflow-caller.yml',
  workflow_template_sha256: 'sha256:33d4c5d911affdca44ab5cf587f8bde556c9732809fc9745048f08050091ee48',
  workflow_template_blob: '184fadec14095f2ca4420b9fafad2fac2fc2e415',
  original_immutable_artifacts: Object.freeze([
    Object.freeze({ path: 'releases/shirube-v4.1/release-manifest.json', byte_sha256: 'sha256:f7c5a8b6012b39f94a1e26ad7a6c120a9330cff185a6bbf1af2b2dc168557a36' }),
    Object.freeze({ path: 'releases/shirube-v4.1/target-payload-manifest.json', byte_sha256: 'sha256:6a7bce4ab348d3cd4ccc290aed06fe41dff7db4b7c690cd0b031b7ddc30b63a9' }),
    Object.freeze({ path: 'releases/shirube-v4.1/fleet-runtime-v1-contract.json', byte_sha256: 'sha256:7936bd8d92c73f54f71c67c744a4e8fb5339f69c7070f709449fba178dd73ebd' }),
  ]),
})

export const FLEET_RUNTIME_V1_ADF_READBACK_RELEASE = Object.freeze({
  root: '/Users/yuji/.local/share/shirube/releases/07640c9c173b36930434847e1cb6838d56b993c0',
  origin_allowed: Object.freeze([
    'git@github.com:watchout/ai-dev-framework.git',
    'https://github.com/watchout/ai-dev-framework.git',
  ]),
  head: '07640c9c173b36930434847e1cb6838d56b993c0',
  tree: '10ffb6acb558d9eecaedab7ce3c97ea447a2b1e5',
  source_path: 'src/cli/commands/goal-runtime.ts',
  source_sha256: '5c8cbc0bb0e33c1a5e6c5892a50c03e98a60f78cd2f5e9baa8a5fd3b3724e0de',
  dist_path: 'dist/cli/index.js',
  dist_sha256: 'ba396b5a7b1d27bdab2fcb3534bbda5fb33a10e388f9dbfc199b2769fb92250f',
  store_path: '/Users/yuji/Developer/kodama/.framework/runtime/goal-convergence.json',
})

export const FLEET_RUNTIME_V1_PAYLOAD_MANIFEST_FILES = Object.freeze([
  { bytes: 10912, path: '.github/workflows/shirube-rapid-lite-gates-report.yml', sha256: 'sha256:33d4c5d911affdca44ab5cf587f8bde556c9732809fc9745048f08050091ee48' },
  { bytes: 12331, path: '.shirube/runtime/rapid-lite/build-review-plan.mjs', sha256: 'sha256:e6a152a4bf79ad2dfdb6698ee746256205cdff644a81559efb68da45c79dcf85' },
  { bytes: 25234, path: '.shirube/runtime/rapid-lite/check-adoption.mjs', sha256: 'sha256:80c35f811abdb2d5b5c5653a56eea189244b41c70d0195953b13a4bd6b6369b3' },
  { bytes: 19515, path: '.shirube/runtime/rapid-lite/check-audit-checklist.mjs', sha256: 'sha256:6ac7d94098a2b77a28e52e2b99498def9e8753920604ecb89eb6752bea2c300e' },
  { bytes: 58514, path: '.shirube/runtime/rapid-lite/check-control-state-completeness.mjs', sha256: 'sha256:7f79d27d899728941fea5ecf119c1fe68fb000351b2202eb8820d96f59413277' },
  { bytes: 24039, path: '.shirube/runtime/rapid-lite/check-design-rules.mjs', sha256: 'sha256:42d7139410bb2e75e6e28e8a12f02700c4fca0e9b9afc8a742124aadf50646e5' },
  { bytes: 15557, path: '.shirube/runtime/rapid-lite/check-enforcement-policy.mjs', sha256: 'sha256:1565310d6c57dd1ba3a02a2174183584fc488bed172279e95d4d2ba08f345743' },
  { bytes: 19490, path: '.shirube/runtime/rapid-lite/check-execution-context.mjs', sha256: 'sha256:6febe7ee73ac68b8f768fad7ed9e9ff8e6c672acaa49125124d379c73eb53f1c' },
  { bytes: 15032, path: '.shirube/runtime/rapid-lite/check-flow-safety.mjs', sha256: 'sha256:b223d2747c1265af5f29c624750811a99cf26033a0140bbbcb760e94b277ed72' },
  { bytes: 35285, path: '.shirube/runtime/rapid-lite/check-gate-contract.mjs', sha256: 'sha256:53ef0c1292a44d867f01f306f096afcc7c31960b36017edb77b5b030c79b610d' },
  { bytes: 30173, path: '.shirube/runtime/rapid-lite/check-lifecycle.mjs', sha256: 'sha256:5a02fc65c1dda4e73990d1ab9c50063602c4bca40379aea814e97dd7c8b2a2a2' },
  { bytes: 11400, path: '.shirube/runtime/rapid-lite/check-review-plan.mjs', sha256: 'sha256:fba44cf2f2a03e03462ac3fe2a08cd865175774e9bfb249dd42f8bf721917578' },
  { bytes: 11195, path: '.shirube/runtime/rapid-lite/generate-audit-checklist.mjs', sha256: 'sha256:fd7a76311345706889bcbb12a48693b0bdc957bd1b325eb215e93a76a9c60a1a' },
  { bytes: 12493, path: '.shirube/runtime/rapid-lite/lib.mjs', sha256: 'sha256:882fd47548aac062ba72d276fb7b69e14b5ed53b98314547881f1f712549c39a' },
  { bytes: 2373, path: '.shirube/runtime/rapid-lite/manifest.json', sha256: 'sha256:0f5bc1907847af28e96250f84289b22320e114e39a904f457e8ebce16df535b4' },
  { bytes: 45786, path: '.shirube/runtime/rapid-lite/next-action-sequencing.mjs', sha256: 'sha256:67fe879ace62f96429b91cb23167897a6a2bbdc8d7d789cff09b1312c48ebd33' },
  { bytes: 6879, path: '.shirube/runtime/rapid-lite/normalize-control-handoff.mjs', sha256: 'sha256:47deccdf4bc633cc0b493f0df44f017d801933430cbd16b5ff0548b3656726c4' },
  { bytes: 22314, path: '.shirube/runtime/rapid-lite/resolve-additional-review-ref.mjs', sha256: 'sha256:faba408ce66c6d450184043076044b11899ab8a6306323f1b4dde28faa33ed28' },
  { bytes: 14063, path: '.shirube/runtime/rapid-lite/resolve-control-handoff-ref.mjs', sha256: 'sha256:0395f6881458e22090073d2521398bcde6d777840ee30e51411ee34b1b84c579' },
  { bytes: 18196, path: '.shirube/runtime/rapid-lite/resolve-structured-audit-ref.mjs', sha256: 'sha256:5a09843d10fe6e7ee7e4c39f8a2c810e406bb30fe99b9c626dda4efa060e17d6' },
  { bytes: 69235, path: '.shirube/runtime/rapid-lite/run-rapid-lite-report.mjs', sha256: 'sha256:7057375536bf9c295a1b2cdc19e5cf47d2095c7c7ed128bbc626fce7123b5bf5' },
  { bytes: 10299, path: '.shirube/runtime/rapid-lite/run-rapid-lite-workflow.mjs', sha256: 'sha256:6b097974235d15607112f30fee5e4b5cecb5cc7d399f67b9eba635cfa8a0482e' },
  { bytes: 4931, path: '.shirube/runtime/rapid-lite/shirube-default-design-rules.yaml', sha256: 'sha256:d6a5e1ababaa6dd8b8ce7b53cde13737f204c09054f0793cb700ff74745301df' },
  { bytes: 20091, path: '.shirube/runtime/rapid-lite/shirube-v3-rapid-lite-gate-contract-matrix.yaml', sha256: 'sha256:cc6cc4b39131847a606cd2aeec29f8e0d76ed330aae23dcadedbaf34317db049' },
] as const)

const FLEET_RUNTIME_V1_RENDERER_TARGET_POLICY = Object.freeze({
  allowed_paths: Object.freeze(['.shirube/**', 'docs/shirube/**', '.github/workflows/shirube-rapid-lite-gates-report.yml']),
  forbidden_paths: Object.freeze([
    'scripts/shirube/**', 'src/**', 'app/**', 'api/**', 'lib/**', 'db/**', 'migrations/**',
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.env*', 'deploy/**', 'deployment/**',
    '.github/branch-protection/**', '.github/rulesets/**',
  ]),
  workflow_caller_generated: true,
  workflow_caller_path: '.github/workflows/shirube-rapid-lite-gates-report.yml',
  application_runtime_changes_allowed: false,
  shirube_control_runtime_bundle_generated: true,
  package_changes_allowed: false,
  branch_protection_changes_allowed: false,
  required_check_activation_allowed: false,
  external_repo_mutation_allowed: false,
})

const FLEET_RUNTIME_V1_RENDERER_REQUIRED_ACTIONS = Object.freeze([
  'Open a target-repo adoption PR containing only the generated overlay files.',
  'Owner must fill exact-head decision evidence before merge if any gate would block.',
  'The generated fail-closed workflow and immutable local runtime bundle must be updated together from an audited Shirube release; required-check activation remains separately authorized.',
  'Do not mix runtime, API, DB, package, deploy, branch protection, ruleset, or required-check changes into the adoption PR.',
])

export const FLEET_RUNTIME_V1_PRODUCTION_STATE_ROOT = '/Users/yuji/Library/Application Support/agent-comms-mcp/fleet-runtime-v1'

const STATE_SCHEMA = 'fleet-runtime-v1/local-operation-state/v2' as const
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
  branch: string
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
    || input.branch !== ''
    || (input.expected_head !== undefined && input.head !== input.expected_head)
    || (input.expected_tree !== undefined && input.tree !== input.expected_tree)) {
    return providerFail('UNSAFE_CHECKOUT', 'checkout repository, head, tree, cleanliness, or detached state differs')
  }
}

export function parseFleetRuntimeQueueStatus(
  report: unknown,
  observedNowMs: number,
  maxAgeMs = 5 * 60_000,
): FleetRuntimeQueueObservationV2 {
  try {
    assertFleetRuntimeQueueObservationV2(report)
  } catch (error) {
    return providerFail('READBACK_INVALID', `official v2 observation is invalid: ${(error as Error).message}`)
  }
  const observedAtMs = Date.parse(report.observed_at)
  if (observedAtMs > observedNowMs + 30_000 || observedNowMs - observedAtMs > maxAgeMs) {
    return providerFail('READBACK_INVALID', 'official queue observed_at is invalid or stale')
  }
  return clone(report)
}

export function parseFleetRuntimeRootGoalReadback(raw: unknown): FleetRuntimeRootGoalReadback {
  assertPlainRecord(raw, 'root-goal status')
  assertExactKeys(raw, [
    'schema', 'verdict', 'command', 'store_path', 'store_code', 'runner_code', 'disposition',
    'persisted', 'write_count', 'root', 'runtime_digest', 'checkpoint', 'proposed_effect', 'counters',
    'effect_delivery_performed',
  ], 'root-goal status')
  assertPlainRecord(raw.counters, 'root-goal status counters')
  assertExactKeys(raw.counters, [
    'state_mutations', 'effect_count', 'dispatch_count', 'model_calls', 'polling_count',
  ], 'root-goal status counters')
  const countersAreZero = Object.values(raw.counters).every(value => value === 0)
  const commonStatus = raw.schema === 'shirube-goal-runtime-command/v1'
    && raw.command === 'status'
    && raw.store_path === FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.store_path
    && raw.runner_code === null
    && raw.disposition === null
    && raw.persisted === false
    && raw.write_count === 0
    && raw.proposed_effect === null
    && countersAreZero
    && raw.effect_delivery_performed === false
  if (!commonStatus) {
    return providerFail('READBACK_INVALID', 'root-goal status identity or zero-effect proof differs')
  }
  const pass = raw.verdict === 'PASS' && raw.store_code === 'RESTORED'
    && SHA256.test(String(raw.runtime_digest ?? '')) && raw.root !== null && typeof raw.root === 'object' && !Array.isArray(raw.root)
    && raw.checkpoint !== null && typeof raw.checkpoint === 'object' && !Array.isArray(raw.checkpoint)
  const blocked = raw.verdict === 'BLOCKED' && raw.store_code === 'STORE_NOT_CREATED'
    && raw.runtime_digest === null && raw.root === null && raw.checkpoint === null
  if (!pass && !blocked) {
    return providerFail('READBACK_INVALID', 'root-goal status schema, verdict, store state, or zero-effect proof differs')
  }
  if (pass) {
    const root = raw.root as Record<string, unknown>
    assertExactKeys(root, [
      'root_goal_run_id', 'status', 'generation', 'objective_digest', 'acceptance_digest',
      'target_digest', 'state_digest',
    ], 'root-goal status root')
    const statuses = ['DRAFT', 'ACTIVE', 'BLOCKED', 'VERIFIED_COMPLETE', 'CANCELLED', 'SUPERSEDED']
    if (typeof root.root_goal_run_id !== 'string' || root.root_goal_run_id.length === 0
      || !statuses.includes(String(root.status))
      || !Number.isSafeInteger(root.generation) || Number(root.generation) < 0
      || !SHA256.test(String(root.objective_digest ?? ''))
      || !SHA256.test(String(root.acceptance_digest ?? ''))
      || !SHA256.test(String(root.target_digest ?? ''))
      || !SHA256.test(String(root.state_digest ?? ''))) {
      return providerFail('READBACK_INVALID', 'root-goal status root differs from the released status shape')
    }
    const checkpoint = raw.checkpoint as Record<string, unknown>
    assertExactKeys(checkpoint, [
      'accepted_event_count', 'idempotency_key_count', 'continuation_effect_id', 'wait_event_key',
      'protected_pause_key', 'target_evidence_count', 'delivery_ledger_digest', 'watchdog_stall_count',
      'watchdog_replan_count',
    ], 'root-goal status checkpoint')
    const nullableString = (value: unknown): boolean => value === null || (typeof value === 'string' && value.length > 0)
    if (!Number.isSafeInteger(checkpoint.accepted_event_count) || Number(checkpoint.accepted_event_count) < 0
      || !Number.isSafeInteger(checkpoint.idempotency_key_count) || Number(checkpoint.idempotency_key_count) < 0
      || !nullableString(checkpoint.continuation_effect_id)
      || !nullableString(checkpoint.wait_event_key)
      || !nullableString(checkpoint.protected_pause_key)
      || !Number.isSafeInteger(checkpoint.target_evidence_count) || Number(checkpoint.target_evidence_count) < 0
      || !SHA256.test(String(checkpoint.delivery_ledger_digest ?? ''))
      || !Number.isSafeInteger(checkpoint.watchdog_stall_count) || Number(checkpoint.watchdog_stall_count) < 0
      || !Number.isSafeInteger(checkpoint.watchdog_replan_count) || Number(checkpoint.watchdog_replan_count) < 0) {
      return providerFail('READBACK_INVALID', 'root-goal status checkpoint differs from the released status shape')
    }
  }
  return {
    repository: 'watchout/kodama',
    store_path: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.store_path,
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

export function assertExactFleetRuntimeChangedPathSet(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
): void {
  if (actual.length !== expected.length
    || new Set(expected).size !== expected.length || new Set(actual).size !== actual.length
    || expected.some((path, index) => path !== actual[index])) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', `${label} differs from the exact ordered changed-against-preimage paths`)
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
    || input.pr.state !== 'MERGED' || typeof input.pr.mergedAt !== 'string' || !Number.isFinite(Date.parse(input.pr.mergedAt))
    || input.pr.isDraft !== false
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

const OPERATION_PREDECESSOR_BINDING_KEYS = Object.freeze([
  'operation', 'predecessor_url', 'predecessor_raw_body_sha256', 'predecessor_self_sha256',
  'prior_request_id', 'prior_request_digest', 'prior_idempotency_key', 'prior_operation', 'prior_result', 'subject_digest',
  'companion_url', 'companion_raw_body_sha256', 'companion_self_sha256', 'companion_request_id',
  'companion_request_digest', 'companion_idempotency_key', 'companion_operation', 'companion_result',
] as const)

export interface FleetRuntimeOperationPredecessorBinding {
  operation: FleetRuntimeOperation
  predecessor_url: string
  predecessor_raw_body_sha256: string
  predecessor_self_sha256: string | null
  prior_request_id: string | null
  prior_request_digest: string | null
  prior_idempotency_key: string | null
  prior_operation: FleetRuntimeOperation | null
  prior_result: 'PASS' | 'PARTIAL'
  subject_digest: string
  companion_url: string | null
  companion_raw_body_sha256: string | null
  companion_self_sha256: string | null
  companion_request_id: string | null
  companion_request_digest: string | null
  companion_idempotency_key: string | null
  companion_operation: FleetRuntimeOperation | null
  companion_result: 'PASS' | null
}

function nullableYamlScalar(value: string): string | null {
  return value === 'null' ? null : value
}

export function parseFleetRuntimeOperationPredecessorBinding(
  request: FleetRuntimeRequest,
  ownerBody: string,
): FleetRuntimeOperationPredecessorBinding {
  const section = yamlSection(ownerBody, 'operation_predecessor_binding')
  const lines = section.split('\n').filter(line => line.trim() !== '')
  const parsed: Record<string, string> = {}
  for (const line of lines) {
    const match = line.match(/^  ([a-z0-9_]+):\s*(\S.*)$/)
    if (!match || Object.hasOwn(parsed, match[1])) {
      return providerFail('READBACK_INVALID', 'operation predecessor binding is nested, duplicate, empty, or malformed')
    }
    parsed[match[1]] = match[2].trim()
  }
  if (canonicalFleetRuntimeJson(Object.keys(parsed).sort()) !== canonicalFleetRuntimeJson([...OPERATION_PREDECESSOR_BINDING_KEYS].sort())) {
    return providerFail('READBACK_INVALID', 'operation predecessor binding keys differ')
  }
  const binding = {
    operation: parsed.operation,
    predecessor_url: parsed.predecessor_url,
    predecessor_raw_body_sha256: parsed.predecessor_raw_body_sha256,
    predecessor_self_sha256: nullableYamlScalar(parsed.predecessor_self_sha256),
    prior_request_id: nullableYamlScalar(parsed.prior_request_id),
    prior_request_digest: nullableYamlScalar(parsed.prior_request_digest),
    prior_idempotency_key: nullableYamlScalar(parsed.prior_idempotency_key),
    prior_operation: nullableYamlScalar(parsed.prior_operation),
    prior_result: parsed.prior_result,
    subject_digest: parsed.subject_digest,
    companion_url: nullableYamlScalar(parsed.companion_url),
    companion_raw_body_sha256: nullableYamlScalar(parsed.companion_raw_body_sha256),
    companion_self_sha256: nullableYamlScalar(parsed.companion_self_sha256),
    companion_request_id: nullableYamlScalar(parsed.companion_request_id),
    companion_request_digest: nullableYamlScalar(parsed.companion_request_digest),
    companion_idempotency_key: nullableYamlScalar(parsed.companion_idempotency_key),
    companion_operation: nullableYamlScalar(parsed.companion_operation),
    companion_result: nullableYamlScalar(parsed.companion_result),
  } as FleetRuntimeOperationPredecessorBinding
  if (binding.operation !== request.operation || binding.predecessor_url !== request.predecessor_receipt.url
    || binding.predecessor_raw_body_sha256 !== request.predecessor_receipt.sha256
    || binding.prior_operation !== request.predecessor_receipt.operation
    || binding.prior_result !== request.predecessor_receipt.result
    || binding.subject_digest !== request.predecessor_receipt.subject_digest) {
    return providerFail('READBACK_INVALID', 'owner predecessor binding differs from the sealed request predecessor')
  }
  if (request.operation === 'CANARY_COLD_START') {
    if ([binding.predecessor_self_sha256, binding.prior_request_id, binding.prior_request_digest,
      binding.prior_idempotency_key, binding.prior_operation, binding.companion_url,
      binding.companion_raw_body_sha256, binding.companion_self_sha256, binding.companion_request_id,
      binding.companion_request_digest, binding.companion_idempotency_key, binding.companion_operation,
      binding.companion_result].some(value => value !== null)) {
      return providerFail('READBACK_INVALID', 'canary predecessor binding must use explicit null non-operation fields')
    }
    return binding
  }
  if (!SHA256.test(String(binding.predecessor_self_sha256 ?? ''))
    || !binding.prior_request_id?.startsWith('FRV1-N40-')
    || !SHA256.test(String(binding.prior_request_digest ?? ''))
    || !INVOCATION_KEY.test(String(binding.prior_idempotency_key ?? ''))) {
    return providerFail('READBACK_INVALID', 'owner predecessor binding lacks the exact prior request tuple')
  }
  const companionValues = [binding.companion_url, binding.companion_raw_body_sha256, binding.companion_self_sha256,
    binding.companion_request_id, binding.companion_request_digest, binding.companion_idempotency_key,
    binding.companion_operation, binding.companion_result]
  if (request.operation === 'REAPPLY') {
    if (!/^https:\/\/github\.com\/watchout\/ai-dev-framework\/issues\/576#issuecomment-[1-9][0-9]*$/.test(String(binding.companion_url ?? ''))
      || !SHA256.test(String(binding.companion_raw_body_sha256 ?? '')) || !SHA256.test(String(binding.companion_self_sha256 ?? ''))
      || !binding.companion_request_id?.startsWith('FRV1-N40-') || !SHA256.test(String(binding.companion_request_digest ?? ''))
      || !INVOCATION_KEY.test(String(binding.companion_idempotency_key ?? ''))
      || binding.companion_operation !== 'ROLLBACK' || binding.companion_result !== 'PASS') {
      return providerFail('READBACK_INVALID', 'reapply owner binding lacks the exact rollback companion tuple')
    }
  } else if (companionValues.some(value => value !== null)) {
    return providerFail('READBACK_INVALID', `${request.operation} must explicitly bind no separate companion`)
  }
  return binding
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
      ? [
          'merge_commit', 'merge_tree', 'pr_url', 'rollback_receipt_sha256', 'rollback_receipt_raw_body_sha256',
          'rollback_receipt_url', 'recovery_receipt_sha256', 'recovery_receipt_self_sha256', 'payload_digest', 'postimage',
        ]
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
    ? 'fleet-runtime-v1/rollback-receipt/v2'
    : expected.operation === 'REAPPLY'
      ? 'fleet-runtime-v1/reapply-receipt/v2'
      : 'fleet-runtime-v1/effect-receipt/v2'
  assertExactKeys(receipt, localReceiptExactKeys(expected.operation), 'local receipt')
  const perTarget = receipt.per_target
  const target = Array.isArray(perTarget) && perTarget.length === 1 ? perTarget[0] : null
  assertPlainRecord(target, 'local receipt target')
  assertExactKeys(target, ['repository', 'preimage', 'postimage', 'queue_observation', 'root_goal_readback'], 'local receipt target')
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
      || !SHA256.test(String(receipt.rollback_receipt_raw_body_sha256 ?? ''))
      || !/^https:\/\/github\.com\/watchout\/ai-dev-framework\/issues\/576#issuecomment-[1-9][0-9]*$/.test(String(receipt.rollback_receipt_url ?? ''))
      || receipt.recovery_receipt_sha256 !== receipt.predecessor_receipt_sha256
      || receipt.recovery_receipt_self_sha256 !== receipt.predecessor_receipt_self_sha256)) {
    return providerFail('READBACK_INVALID', 'reapply receipt does not bind rollback and recovery predecessors')
  }
  return receipt
}

function validateFleetRuntimePredecessorReceipt(
  request: FleetRuntimeRequest,
  rawBody: string,
  binding: FleetRuntimeOperationPredecessorBinding,
): Record<string, unknown> {
  const receipt = parseCanonicalJson<Record<string, unknown>>(rawBody, 'immutable predecessor receipt')
  assertPlainRecord(receipt, 'immutable predecessor receipt')
  const operation = request.predecessor_receipt.operation
  if (!operation) return providerFail('READBACK_INVALID', 'effect predecessor operation is absent')
  const expectedSchema = operation === 'ROLLBACK'
    ? 'fleet-runtime-v1/rollback-receipt/v2'
    : operation === 'REAPPLY'
      ? 'fleet-runtime-v1/reapply-receipt/v2'
      : 'fleet-runtime-v1/effect-receipt/v2'
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
    || receipt.request_id !== binding.prior_request_id
    || receipt.request_digest !== binding.prior_request_digest
    || receipt.idempotency_key !== binding.prior_idempotency_key
    || receipt.actor_agent_id !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.required_executor.actor_agent_id
    || receipt.active_function !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.required_executor.active_function
    || receipt.receipt_sha256 !== binding.predecessor_self_sha256
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

function validateFleetRuntimeRollbackCompanionReceipt(
  request: FleetRuntimeRequest,
  rawBody: string,
  binding: FleetRuntimeOperationPredecessorBinding,
  recoveryReceipt: Record<string, unknown>,
): Record<string, unknown> {
  if (request.operation !== 'REAPPLY') return providerFail('READBACK_INVALID', 'rollback companion is admitted only for REAPPLY')
  if (sha256(rawBody) !== binding.companion_raw_body_sha256) {
    return providerFail('READBACK_INVALID', 'rollback companion raw-body digest differs from owner authority')
  }
  const receipt = parseCanonicalJson<Record<string, unknown>>(rawBody, 'immutable rollback companion receipt')
  assertExactKeys(receipt, localReceiptExactKeys('ROLLBACK'), 'immutable rollback companion receipt')
  const perTarget = receipt.per_target
  const target = Array.isArray(perTarget) && perTarget.length === 1 ? perTarget[0] as Record<string, unknown> : null
  if (receipt.schema_version !== 'fleet-runtime-v1/rollback-receipt/v2' || receipt.operation !== 'ROLLBACK'
    || receipt.result !== 'PASS' || receipt.subject_digest !== request.predecessor_receipt.subject_digest
    || receipt.target_repository !== 'watchout/kodama' || target?.repository !== 'watchout/kodama'
    || receipt.request_id !== binding.companion_request_id || receipt.request_digest !== binding.companion_request_digest
    || receipt.idempotency_key !== binding.companion_idempotency_key
    || receipt.receipt_sha256 !== binding.companion_self_sha256 || receipt.receipt_sha256 !== canonicalSelfDigest(receipt)
    || recoveryReceipt.rollback_receipt_sha256 !== binding.companion_self_sha256) {
    return providerFail('READBACK_INVALID', 'rollback companion tuple or RECOVERY link differs from owner authority')
  }
  return receipt
}

export function validateFleetRuntimeImmutableSemantics(
  request: FleetRuntimeRequest,
  ownerBody: string,
  predecessorBody: string,
  companionBody?: string,
): void {
  const predecessorBinding = parseFleetRuntimeOperationPredecessorBinding(request, ownerBody)
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
    const predecessorReceipt = validateFleetRuntimePredecessorReceipt(request, predecessorBody, predecessorBinding)
    if (request.operation === 'REAPPLY') {
      if (!companionBody) return providerFail('READBACK_INVALID', 'REAPPLY rollback companion body is absent')
      validateFleetRuntimeRollbackCompanionReceipt(request, companionBody, predecessorBinding, predecessorReceipt)
    }
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

interface InvocationWriteLockRecord {
  lock_token: string
  execution_owner: FleetRuntimeExecutionOwner
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

  private ownerWriteLockPath(key: string): string {
    return join(this.invocationDirectory(key), 'owner-write.lock')
  }

  private ownerWriteLockRecordPath(lockDirectory: string): string {
    return join(lockDirectory, 'owner.json')
  }

  private readInvocationWriteLock(lockDirectory: string, label: string): InvocationWriteLockRecord {
    assertSafeStatePath(this.root, lockDirectory)
    if (!existsSync(lockDirectory) || !lstatSync(lockDirectory).isDirectory()) {
      return providerFail('STATE_RECORD_INVALID', `${label} must be a nonempty lock directory`)
    }
    const record = readState<InvocationWriteLockRecord>(
      this.root,
      this.ownerWriteLockRecordPath(lockDirectory),
      label,
    )
    assertPlainRecord(record, label)
    assertExactKeys(record, ['execution_owner', 'lock_token'], label)
    const owner = record.execution_owner
    if (typeof record.lock_token !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.lock_token)
      || owner === null || typeof owner !== 'object'
      || typeof owner.owner_id !== 'string' || owner.owner_id.length === 0
      || typeof owner.host !== 'string' || owner.host.length === 0
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !Number.isFinite(Date.parse(owner.acquired_at)) || !Number.isFinite(Date.parse(owner.heartbeat_at))) {
      return providerFail('STATE_RECORD_INVALID', `${label} has an invalid token or owner`)
    }
    return record
  }

  private discardWriteLockCandidate(candidate: string): void {
    if (!existsSync(candidate)) return
    const record = this.ownerWriteLockRecordPath(candidate)
    if (existsSync(record)) unlinkSync(record)
    rmdirSync(candidate)
    syncDirectory(dirname(candidate))
  }

  private publishInvocationWriteLock(key: string, record: InvocationWriteLockRecord): boolean {
    const parent = this.invocationDirectory(key)
    const lock = this.ownerWriteLockPath(key)
    const candidate = join(parent, `.owner-write.lock.${record.lock_token}.candidate`)
    assertSafeStatePath(this.root, candidate)
    mkdirSync(candidate, { mode: 0o700 })
    try {
      atomicWrite(this.root, this.ownerWriteLockRecordPath(candidate), record, true)
      try {
        renameSync(candidate, lock)
        syncDirectory(parent)
        const published = this.readInvocationWriteLock(lock, 'published owner write lock')
        if (canonicalFleetRuntimeJson(published) !== canonicalFleetRuntimeJson(record)) {
          return providerFail('STATE_RECORD_INVALID', 'published owner write lock differs from its candidate')
        }
        return true
      } catch (error) {
        if (existsSync(lock)) return false
        throw error
      }
    } finally {
      this.discardWriteLockCandidate(candidate)
    }
  }

  private retiredOwnerWriteLockPath(key: string, lockToken: string): string {
    return join(this.invocationDirectory(key), `owner-write.lock.retired.${lockToken}`)
  }

  private retireInvocationWriteLock(
    key: string,
    observed: InvocationWriteLockRecord,
    label: string,
  ): boolean {
    const lock = this.ownerWriteLockPath(key)
    if (!existsSync(lock)) return false
    const current = this.readInvocationWriteLock(lock, label)
    if (current.lock_token !== observed.lock_token
      || canonicalFleetRuntimeJson(current) !== canonicalFleetRuntimeJson(observed)) return false
    const retired = this.retiredOwnerWriteLockPath(key, observed.lock_token)
    if (existsSync(retired)) {
      const prior = this.readInvocationWriteLock(retired, `${label} retired generation`)
      if (canonicalFleetRuntimeJson(prior) !== canonicalFleetRuntimeJson(observed)) {
        return providerFail('STATE_RECORD_INVALID', `${label} retired generation differs for the same token`)
      }
      return false
    }
    try {
      renameSync(lock, retired)
      syncDirectory(dirname(lock))
    } catch (error) {
      if (existsSync(retired)) {
        const winner = this.readInvocationWriteLock(retired, `${label} winning retired generation`)
        if (canonicalFleetRuntimeJson(winner) !== canonicalFleetRuntimeJson(observed)) {
          return providerFail('STATE_RECORD_INVALID', `${label} winning retired generation differs`)
        }
        return false
      }
      if (!existsSync(lock)) return false
      throw error
    }
    const moved = this.readInvocationWriteLock(retired, `${label} retired generation readback`)
    if (canonicalFleetRuntimeJson(moved) !== canonicalFleetRuntimeJson(observed)) {
      return providerFail('STATE_RECORD_INVALID', `${label} changed across atomic retirement`)
    }
    return true
  }

  private assertOwnerUnlocked(key: string): OwnedFleetRuntimeInvocationState {
    const path = this.reservationPath(key)
    if (!existsSync(path)) return providerFail('IN_FLIGHT', 'reservation no longer exists')
    const state = readState<OwnedFleetRuntimeInvocationState>(this.root, path, 'reservation owner')
    if (state.status !== 'reserved' || state.execution_owner?.owner_id !== this.owner.owner_id) {
      return providerFail('IN_FLIGHT', 'current executor no longer owns the durable reservation')
    }
    return state
  }

  private withInvocationWriteLock<T>(
    key: string,
    action: () => T,
    allowStaleLockBreak = true,
  ): T {
    const lockToken = randomUUID()
    const lockRecord: InvocationWriteLockRecord = {
      lock_token: lockToken,
      execution_owner: {
        ...this.owner,
        heartbeat_at: new Date(this.nowMs()).toISOString(),
      },
    }
    if (!this.publishInvocationWriteLock(key, lockRecord)) {
      const lock = this.ownerWriteLockPath(key)
      const observed = this.readInvocationWriteLock(lock, 'owner write lock')
      const observedOwner = observed.execution_owner
      const heartbeat = Date.parse(String(observedOwner?.heartbeat_at ?? ''))
      if (allowStaleLockBreak && observedOwner && !this.ownerAlive(observedOwner)
        && Number.isFinite(heartbeat) && this.nowMs() - heartbeat >= this.staleAfterMs) {
        if (!this.retireInvocationWriteLock(key, observed, 'stale owner write lock reclaim')) {
          return providerFail('IN_FLIGHT', 'stale invocation write lock changed before atomic retirement')
        }
        if (!this.publishInvocationWriteLock(key, lockRecord)) {
          return providerFail('IN_FLIGHT', 'another executor published the successor invocation write lock')
        }
      } else {
        return providerFail('IN_FLIGHT', 'another executor owns the durable invocation write lock')
      }
    }
    try {
      return action()
    } finally {
      if (!this.retireInvocationWriteLock(key, lockRecord, 'owner write lock release')) {
        return providerFail('STATE_RECORD_INVALID', 'invocation write lock changed before clean release')
      }
    }
  }

  commitOwnedRecord<T>(
    key: string,
    path: string,
    label: string,
    expected: T | null,
    next: T,
  ): T {
    return this.withInvocationWriteLock(key, () => {
      this.assertOwnerUnlocked(key)
      const current = existsSync(path) ? readState<T>(this.root, path, label) : null
      if (canonicalFleetRuntimeJson(current) !== canonicalFleetRuntimeJson(expected)) {
        return providerFail('STATE_RECORD_INVALID', `${label} changed before the fenced write`)
      }
      atomicWrite(this.root, path, next)
      this.assertOwnerUnlocked(key)
      return clone(next)
    })
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

  private takeover(
    state: FleetRuntimeInvocationState,
    observed: OwnedFleetRuntimeInvocationState,
  ): Promise<{ acquired: boolean; state: FleetRuntimeInvocationState }> {
    return Promise.resolve(this.withInvocationWriteLock(state.idempotency_key, () => {
      const reservation = this.reservationPath(state.idempotency_key)
      const latest = existsSync(reservation)
        ? readState<OwnedFleetRuntimeInvocationState>(this.root, reservation, 'takeover reservation')
        : null
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
    }))
  }

  async heartbeatOwner(key: string): Promise<void> {
    this.withInvocationWriteLock(key, () => {
      const state = this.assertOwnerUnlocked(key)
      state.execution_owner!.heartbeat_at = new Date(this.nowMs()).toISOString()
      atomicWrite(this.root, this.reservationPath(key), state)
      this.assertOwnerUnlocked(key)
    })
  }

  assertOwner(key: string): void {
    this.assertOwnerUnlocked(key)
  }

  async complete_once(state: FleetRuntimeInvocationState): Promise<FleetRuntimeInvocationState> {
    assertInvocationStateShape(state)
    if (state.status !== 'completed') return providerFail('STATE_RECORD_INVALID', 'completion must use completed state')
    return this.withInvocationWriteLock(state.idempotency_key, () => {
      const completedPath = this.completionPath(state.idempotency_key)
      if (existsSync(completedPath)) {
        const completed = readState<FleetRuntimeInvocationState>(this.root, completedPath, 'completed invocation')
        if (canonicalFleetRuntimeJson(completed) !== canonicalFleetRuntimeJson(state)) {
          return providerFail('STATE_COLLISION', 'completed receipt is immutable')
        }
        return completed
      }
      const existing = this.assertOwnerUnlocked(state.idempotency_key)
      if (existing.request_digest !== state.request_digest) {
        return providerFail('STATE_COLLISION', 'completion request digest differs')
      }
      atomicWrite(this.root, completedPath, state)
      this.assertOwnerUnlocked(state.idempotency_key)
      return clone(state)
    })
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
  phase_sequence: FleetRuntimeLocalPhase[]
  phases: Partial<Record<FleetRuntimeLocalPhase, FleetRuntimeLocalPhaseState>>
}

export interface FleetRuntimeLocalPhaseContext {
  state_directory: string
  invocation_directory: string
  prior_evidence: Partial<Record<FleetRuntimeLocalPhase, Record<string, unknown>>>
  current_intent: Record<string, unknown>
  execution_owner_id: string
  owner_decision_raw_body: string
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

const PHASE_BINDING_KEYS = Object.freeze([
  'execution_owner_id', 'operation', 'phase', 'request_digest', 'request_id',
] as const)

const PHASE_INTENT_SPECIFIC_KEYS: Readonly<Record<FleetRuntimeLocalPhase, readonly string[]>> = Object.freeze({
  PREPARE_CLEAN_CHECKOUT: Object.freeze(['expected_head', 'expected_tree']),
  STAGE_EXACT_PAYLOAD: Object.freeze([
    'payload_digest', 'path_count', 'raw_output_path', 'release_commit', 'release_tree',
    'renderer_source_ref', 'renderer_source_tree', 'selected_payload_path',
  ]),
  VERIFY_EXACT_PAYLOAD: Object.freeze(['payload_digest', 'path_count', 'selected_payload_path']),
  CREATE_LOCAL_COMMIT: Object.freeze(['payload_digest', 'path_count']),
  PUSH_NORMAL_BRANCH: Object.freeze(['branch', 'force', 'head']),
  CREATE_DRAFT_PR: Object.freeze(['base', 'branch', 'draft', 'head', 'repository']),
  CREATE_LOCAL_REVERT: Object.freeze(['expected_tree', 'merge_commit']),
  VERIFY_EXTERNAL_MERGE: Object.freeze(['base', 'pr_url', 'pushed_head', 'repository']),
  PREPARE_MERGED_CHECKOUT: Object.freeze(['expected_head', 'expected_tree']),
  VERIFY_EXACT_PREIMAGE: Object.freeze(['expected_head', 'expected_tree']),
  COLD_START_DISCORD_KODAMA: Object.freeze(['checkout_path', 'expected_head', 'expected_tree', 'port', 'session']),
  VERIFY_LIVE_IDENTITY: Object.freeze(['checkout_path', 'expected_head', 'expected_tree', 'port', 'session']),
})

const PHASE_EVIDENCE_SPECIFIC_KEYS: Readonly<Record<FleetRuntimeLocalPhase, readonly string[]>> = Object.freeze({
  PREPARE_CLEAN_CHECKOUT: Object.freeze([
    'baseline_runtime_instance_id', 'checkout_path', 'clean', 'detached', 'head', 'remote', 'tree',
  ]),
  STAGE_EXACT_PAYLOAD: Object.freeze([
    'path_count', 'payload_digest', 'payload_paths', 'raw_output_path', 'raw_path_count', 'raw_paths',
    'renderer_report_sha256', 'renderer_source_checkout_after', 'renderer_source_checkout_before',
    'selected_blobs', 'selected_payload_path',
  ]),
  VERIFY_EXACT_PAYLOAD: Object.freeze(['checkout_blobs', 'path_count', 'payload_digest', 'payload_paths', 'selected_payload_path']),
  CREATE_LOCAL_COMMIT: Object.freeze(['branch', 'commit_blobs', 'head', 'index_blobs', 'payload_paths']),
  PUSH_NORMAL_BRANCH: Object.freeze(['branch', 'force', 'head']),
  CREATE_DRAFT_PR: Object.freeze(['branch', 'draft', 'head', 'pr_url']),
  CREATE_LOCAL_REVERT: Object.freeze(['branch', 'head', 'reverted_merge']),
  VERIFY_EXTERNAL_MERGE: Object.freeze(
    EXTERNAL_MERGE_RECEIPT_KEYS.filter(key => !(PHASE_BINDING_KEYS as readonly string[]).includes(key)),
  ),
  PREPARE_MERGED_CHECKOUT: Object.freeze(['checkout_path', 'clean', 'detached', 'head', 'remote', 'tree']),
  VERIFY_EXACT_PREIMAGE: Object.freeze(['checkout_path', 'clean', 'detached', 'head', 'remote', 'tree']),
  COLD_START_DISCORD_KODAMA: Object.freeze(['checkout_path', 'clean', 'detached', 'head', 'port', 'remote', 'session', 'tree']),
  VERIFY_LIVE_IDENTITY: Object.freeze([
    'duplicate_effect_count', 'inventory', 'local_checkout', 'queue_unchanged', 'remote_image',
    'runtime_instance_id', 'unauthorized_effect_count',
  ]),
})

function phaseBoundRecord(
  request: FleetRuntimeRequest,
  phase: FleetRuntimeLocalPhase,
  ownerId: string,
  value: Record<string, unknown>,
  label: 'intent' | 'evidence',
): Record<string, unknown> {
  const specific = clone(value)
  const expectedBindings: Record<string, unknown> = {
    execution_owner_id: ownerId,
    operation: request.operation,
    phase,
    request_digest: request.request_digest,
    request_id: request.request_id,
  }
  for (const key of PHASE_BINDING_KEYS) {
    if (!Object.hasOwn(specific, key)) continue
    if (specific[key] !== expectedBindings[key]) {
      return providerFail('STATE_RECORD_INVALID', `${phase} ${label} attempted to replace ${key}`)
    }
    delete specific[key]
  }
  return {
    ...expectedBindings,
    ...specific,
  }
}

function assertCommit(value: unknown, label: string): string {
  if (typeof value !== 'string' || !COMMIT.test(value)) return providerFail('STATE_RECORD_INVALID', `${label} must be an exact commit`)
  return value
}

function assertSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) return providerFail('STATE_RECORD_INVALID', `${label} must be an exact sha256`)
  return value
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) return providerFail('STATE_RECORD_INVALID', `${label} must be a nonempty string`)
  return value
}

function assertCheckoutEvidence(value: Record<string, unknown>, intent: Record<string, unknown>, label: string): void {
  assertString(value.checkout_path, `${label} checkout path`)
  if (value.checkout_path !== intent.checkout_path && Object.hasOwn(intent, 'checkout_path')) {
    return providerFail('STATE_RECORD_INVALID', `${label} checkout path differs from intent`)
  }
  if (value.head !== intent.expected_head || value.tree !== intent.expected_tree
    || value.clean !== true || value.detached !== true
    || !new Set(['https://github.com/watchout/kodama.git', 'git@github.com:watchout/kodama.git']).has(String(value.remote))) {
    return providerFail('STATE_RECORD_INVALID', `${label} checkout evidence differs from exact detached intent`)
  }
}

function assertReleaseCheckoutEvidence(value: unknown, label: string): void {
  assertPlainRecord(value, label)
  assertExactKeys(value, [
    'checkout_path', 'clean', 'detached', 'head', 'remote', 'renderer_blob', 'tree', 'workflow_template_blob',
  ], label)
  assertString(value.checkout_path, `${label} checkout path`)
  if (!new Set(['https://github.com/watchout/ai-dev-framework.git', 'git@github.com:watchout/ai-dev-framework.git']).has(String(value.remote))
    || value.head !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref || value.tree !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree
    || value.renderer_blob !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_blob
    || value.workflow_template_blob !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_blob
    || value.clean !== true || value.detached !== true) {
    return providerFail('STATE_RECORD_INVALID', `${label} differs from the exact amendment-bound renderer source`)
  }
}

function assertPathRows(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length !== 24 || value.some(path => typeof path !== 'string') || new Set(value).size !== 24) {
    return providerFail('STATE_RECORD_INVALID', `${label} must contain the exact unique 24 paths`)
  }
  return value as string[]
}

function assertBlobMap(value: unknown, paths: readonly string[], label: string): void {
  assertPlainRecord(value, label)
  assertExactKeys(value, paths, label)
  for (const path of paths) {
    const row = value[path]
    assertPlainRecord(row, `${label}.${path}`)
    assertExactKeys(row, ['bytes', 'sha256'], `${label}.${path}`)
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 || !SHA256.test(String(row.sha256 ?? ''))) {
      return providerFail('STATE_RECORD_INVALID', `${label}.${path} byte binding differs`)
    }
  }
}

function validatePhaseSemantics(
  request: FleetRuntimeRequest,
  phaseName: FleetRuntimeLocalPhase,
  phase: FleetRuntimeLocalPhaseState,
  priorEvidence: Partial<Record<FleetRuntimeLocalPhase, Record<string, unknown>>>,
  ownerId: string,
): void {
  assertPlainRecord(phase.intent, `${phaseName} intent`)
  const intentKeys = [...PHASE_BINDING_KEYS, ...PHASE_INTENT_SPECIFIC_KEYS[phaseName]]
  assertExactKeys(phase.intent, intentKeys, `${phaseName} intent`)
  if (phase.intent.execution_owner_id !== ownerId || phase.intent.operation !== request.operation
    || phase.intent.phase !== phaseName || phase.intent.request_digest !== request.request_digest
    || phase.intent.request_id !== request.request_id) {
    return providerFail('STATE_RECORD_INVALID', `${phaseName} intent has a foreign request or owner binding`)
  }
  const commitIntentFields = ['expected_head', 'expected_tree', 'head', 'merge_commit']
  for (const field of commitIntentFields) {
    if (Object.hasOwn(phase.intent, field)) assertCommit(phase.intent[field], `${phaseName}.intent.${field}`)
  }
  if (Object.hasOwn(phase.intent, 'payload_digest') && phase.intent.payload_digest !== request.payload_digest) {
    return providerFail('STATE_RECORD_INVALID', `${phaseName} intent payload digest differs`)
  }
  if (Object.hasOwn(phase.intent, 'path_count') && phase.intent.path_count !== 24) {
    return providerFail('STATE_RECORD_INVALID', `${phaseName} intent path count differs`)
  }
  if (phaseName === 'PREPARE_CLEAN_CHECKOUT'
    && (request.operation === 'CANARY_COLD_START' || request.operation === 'REAPPLY')
    && (phase.intent.expected_head !== request.preimages[0].head_commit || phase.intent.expected_tree !== request.preimages[0].tree)) {
    return providerFail('STATE_RECORD_INVALID', 'prepare intent differs from the frozen canary/reapply preimage')
  }
  if (phaseName === 'STAGE_EXACT_PAYLOAD'
    && (phase.intent.release_commit !== request.subject.release_commit || phase.intent.release_tree !== request.subject.release_tree
      || phase.intent.renderer_source_ref !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref
      || phase.intent.renderer_source_tree !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree
      || typeof phase.intent.raw_output_path !== 'string' || typeof phase.intent.selected_payload_path !== 'string'
      || phase.intent.raw_output_path === phase.intent.selected_payload_path)) {
    return providerFail('STATE_RECORD_INVALID', 'stage intent differs from the exact release, renderer source, or separate output roots')
  }
  if (phaseName === 'VERIFY_EXACT_PAYLOAD' && typeof phase.intent.selected_payload_path !== 'string') {
    return providerFail('STATE_RECORD_INVALID', 'verify payload intent omits the selected payload root')
  }
  if (phaseName === 'CREATE_LOCAL_REVERT' && phase.intent.expected_tree !== request.preimages[0].tree) {
    return providerFail('STATE_RECORD_INVALID', 'revert intent differs from the frozen preimage tree')
  }
  if (phaseName === 'PUSH_NORMAL_BRANCH') {
    assertString(phase.intent.branch, 'push branch')
    const local = priorEvidence.CREATE_LOCAL_COMMIT ?? priorEvidence.CREATE_LOCAL_REVERT
    if (!local || phase.intent.branch !== local.branch || phase.intent.head !== local.head) {
      return providerFail('STATE_RECORD_INVALID', 'push intent differs from the exact local commit or revert branch/head')
    }
    if (phase.intent.force !== false) return providerFail('STATE_RECORD_INVALID', 'push intent must be non-force')
  }
  if (phaseName === 'CREATE_DRAFT_PR') {
    assertString(phase.intent.branch, 'Draft PR branch')
    const pushed = priorEvidence.PUSH_NORMAL_BRANCH
    if (!pushed || phase.intent.branch !== pushed.branch || phase.intent.head !== pushed.head) {
      return providerFail('STATE_RECORD_INVALID', 'Draft PR intent differs from the exact pushed branch/head')
    }
    if (phase.intent.repository !== 'watchout/kodama' || phase.intent.base !== request.preimages[0].required_base_branch
      || phase.intent.draft !== true) return providerFail('STATE_RECORD_INVALID', 'Draft PR intent differs')
  }
  if (phaseName === 'VERIFY_EXTERNAL_MERGE') {
    const pushed = priorEvidence.PUSH_NORMAL_BRANCH
    const created = priorEvidence.CREATE_DRAFT_PR
    if (!pushed || !created || phase.intent.pushed_head !== pushed.head || phase.intent.pr_url !== created.pr_url) {
      return providerFail('STATE_RECORD_INVALID', 'external merge intent differs from the exact pushed head or created PR')
    }
    if (phase.intent.repository !== 'watchout/kodama' || phase.intent.base !== request.preimages[0].required_base_branch
      || !/^https:\/\/github\.com\/watchout\/kodama\/pull\/[1-9][0-9]*$/.test(String(phase.intent.pr_url ?? ''))
      || !COMMIT.test(String(phase.intent.pushed_head ?? ''))) {
      return providerFail('STATE_RECORD_INVALID', 'external merge intent differs from the created exact PR/head')
    }
  }
  if (phaseName === 'PREPARE_MERGED_CHECKOUT') {
    const merge = priorEvidence.VERIFY_EXTERNAL_MERGE
    if (phase.intent.expected_head !== merge?.merge_commit || phase.intent.expected_tree !== merge?.merge_tree) {
      return providerFail('STATE_RECORD_INVALID', 'merged checkout intent differs from external merge evidence')
    }
  }
  if (phaseName === 'COLD_START_DISCORD_KODAMA' || phaseName === 'VERIFY_LIVE_IDENTITY') {
    assertString(phase.intent.checkout_path, `${phaseName} checkout path`)
    if (phase.intent.session !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.target_session
      || phase.intent.port !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.target_port) {
      return providerFail('STATE_RECORD_INVALID', `${phaseName} intent differs from the frozen local runtime binding`)
    }
  }
  if (phase.status !== 'completed') return
  assertPlainRecord(phase.evidence, `${phaseName} evidence`)
  const reapplyPrepareKeys = phaseName === 'PREPARE_CLEAN_CHECKOUT' && request.operation === 'REAPPLY'
    ? ['rollback_receipt_raw_body_sha256', 'rollback_receipt_self_sha256', 'rollback_receipt_url'] : []
  const evidenceKeys = [...PHASE_BINDING_KEYS, 'intent_sha256', ...PHASE_EVIDENCE_SPECIFIC_KEYS[phaseName], ...reapplyPrepareKeys]
  assertExactKeys(phase.evidence, evidenceKeys, `${phaseName} evidence`)
  const evidence = phase.evidence
  if (evidence.execution_owner_id !== ownerId || evidence.operation !== request.operation
    || evidence.phase !== phaseName || evidence.request_digest !== request.request_digest
    || evidence.request_id !== request.request_id || evidence.intent_sha256 !== phase.intent_sha256) {
    return providerFail('STATE_RECORD_INVALID', `${phaseName} evidence has a foreign request, owner, or intent binding`)
  }
  if (phaseName === 'PREPARE_CLEAN_CHECKOUT') {
    assertCheckoutEvidence(evidence, { ...phase.intent, checkout_path: evidence.checkout_path }, phaseName)
    if (evidence.baseline_runtime_instance_id !== null && typeof evidence.baseline_runtime_instance_id !== 'string') {
      return providerFail('STATE_RECORD_INVALID', 'prepare evidence runtime baseline is invalid')
    }
    for (const key of reapplyPrepareKeys) assertString(evidence[key], `prepare evidence ${key}`)
    if (request.operation === 'REAPPLY') {
      assertSha(evidence.rollback_receipt_raw_body_sha256, 'rollback raw digest')
      assertSha(evidence.rollback_receipt_self_sha256, 'rollback self digest')
    }
  } else if (phaseName === 'STAGE_EXACT_PAYLOAD') {
    const paths = assertPathRows(evidence.payload_paths, 'stage payload paths')
    const rawPaths = evidence.raw_paths
    if (!Array.isArray(rawPaths) || rawPaths.length !== 34 || rawPaths.some(path => typeof path !== 'string')
      || new Set(rawPaths).size !== 34 || evidence.raw_path_count !== 34
      || paths.some(path => !(rawPaths as string[]).includes(path)) || evidence.path_count !== 24
      || evidence.payload_digest !== request.payload_digest || evidence.raw_output_path !== phase.intent.raw_output_path
      || evidence.selected_payload_path !== phase.intent.selected_payload_path) {
      return providerFail('STATE_RECORD_INVALID', 'stage evidence does not bind the full raw 34 and selected 24 outputs')
    }
    assertSha(evidence.renderer_report_sha256, 'renderer report digest')
    assertBlobMap(evidence.selected_blobs, paths, 'selected blobs')
    const manifestRows = paths.map(path => ({ path, ...(evidence.selected_blobs as Record<string, { bytes: number; sha256: string }>)[path] }))
    if (sha256(canonicalFleetRuntimeJson(manifestRows)) !== request.payload_digest) {
      return providerFail('STATE_RECORD_INVALID', 'selected blob manifest does not equal the sealed payload digest')
    }
    assertReleaseCheckoutEvidence(evidence.renderer_source_checkout_before, 'renderer source checkout before renderer')
    assertReleaseCheckoutEvidence(evidence.renderer_source_checkout_after, 'renderer source checkout after renderer')
    if (canonicalFleetRuntimeJson(evidence.renderer_source_checkout_before) !== canonicalFleetRuntimeJson(evidence.renderer_source_checkout_after)) {
      return providerFail('STATE_RECORD_INVALID', 'renderer source checkout changed across renderer execution')
    }
  } else if (phaseName === 'VERIFY_EXACT_PAYLOAD') {
    const paths = assertPathRows(evidence.payload_paths, 'verified payload paths')
    if (evidence.payload_digest !== request.payload_digest || evidence.path_count !== 24
      || evidence.selected_payload_path !== phase.intent.selected_payload_path
      || canonicalFleetRuntimeJson(paths) !== canonicalFleetRuntimeJson(priorEvidence.STAGE_EXACT_PAYLOAD?.payload_paths)) {
      return providerFail('STATE_RECORD_INVALID', 'verified payload evidence differs from selected stage output')
    }
    assertBlobMap(evidence.checkout_blobs, paths, 'checkout blobs')
    if (canonicalFleetRuntimeJson(evidence.checkout_blobs) !== canonicalFleetRuntimeJson(priorEvidence.STAGE_EXACT_PAYLOAD?.selected_blobs)) {
      return providerFail('STATE_RECORD_INVALID', 'checkout blobs differ from the selected renderer blobs')
    }
  } else if (phaseName === 'CREATE_LOCAL_COMMIT') {
    const paths = assertPathRows(evidence.payload_paths, 'commit payload paths')
    assertCommit(evidence.head, 'local commit head')
    assertString(evidence.branch, 'local commit branch')
    assertBlobMap(evidence.index_blobs, paths, 'index blobs')
    assertBlobMap(evidence.commit_blobs, paths, 'commit blobs')
    if (canonicalFleetRuntimeJson(evidence.index_blobs) !== canonicalFleetRuntimeJson(evidence.commit_blobs)
      || canonicalFleetRuntimeJson(evidence.index_blobs) !== canonicalFleetRuntimeJson(priorEvidence.VERIFY_EXACT_PAYLOAD?.checkout_blobs)
      || canonicalFleetRuntimeJson(paths) !== canonicalFleetRuntimeJson(priorEvidence.VERIFY_EXACT_PAYLOAD?.payload_paths)) {
      return providerFail('STATE_RECORD_INVALID', 'commit blobs or paths differ from verified index evidence')
    }
  } else if (phaseName === 'PUSH_NORMAL_BRANCH') {
    if (evidence.branch !== phase.intent.branch || evidence.head !== phase.intent.head || evidence.force !== false) {
      return providerFail('STATE_RECORD_INVALID', 'push evidence differs from immutable non-force intent')
    }
  } else if (phaseName === 'CREATE_DRAFT_PR') {
    if (evidence.branch !== phase.intent.branch || evidence.head !== phase.intent.head || evidence.draft !== true
      || !/^https:\/\/github\.com\/watchout\/kodama\/pull\/[1-9][0-9]*$/.test(String(evidence.pr_url ?? ''))) {
      return providerFail('STATE_RECORD_INVALID', 'Draft PR evidence differs from intent')
    }
  } else if (phaseName === 'CREATE_LOCAL_REVERT') {
    assertCommit(evidence.head, 'revert head')
    if (evidence.reverted_merge !== phase.intent.merge_commit) return providerFail('STATE_RECORD_INVALID', 'revert evidence differs from intent')
  } else if (phaseName === 'VERIFY_EXTERNAL_MERGE') {
    const receipt = Object.fromEntries(EXTERNAL_MERGE_RECEIPT_KEYS.map(key => [key, evidence[key]]))
    validateFleetRuntimeExternalMergeReceipt(request, receipt, {
      createdPrUrl: String(phase.intent.pr_url), pushedHead: String(phase.intent.pushed_head),
    })
  } else if (phaseName === 'PREPARE_MERGED_CHECKOUT' || phaseName === 'VERIFY_EXACT_PREIMAGE') {
    assertCheckoutEvidence(evidence, phase.intent, phaseName)
  } else if (phaseName === 'COLD_START_DISCORD_KODAMA') {
    assertCheckoutEvidence(evidence, phase.intent, phaseName)
    if (evidence.session !== phase.intent.session || evidence.port !== phase.intent.port) {
      return providerFail('STATE_RECORD_INVALID', 'cold-start evidence session or port differs')
    }
  } else if (phaseName === 'VERIFY_LIVE_IDENTITY') {
    assertString(evidence.runtime_instance_id, 'live runtime instance')
    assertPlainRecord(evidence.local_checkout, 'live local checkout')
    assertExactKeys(evidence.local_checkout, ['checkout_path', 'clean', 'detached', 'head', 'remote', 'tree'], 'live local checkout')
    assertCheckoutEvidence(evidence.local_checkout, phase.intent, 'live local checkout')
    assertPlainRecord(evidence.remote_image, 'live remote image')
    assertExactKeys(evidence.remote_image, [
      'distribution_surface_entry_count', 'distribution_surface_sha256', 'head_commit',
      'runtime_surface_entry_count', 'runtime_surface_sha256', 'tree',
    ], 'live remote image')
    if (evidence.remote_image.head_commit !== phase.intent.expected_head || evidence.remote_image.tree !== phase.intent.expected_tree
      || evidence.queue_unchanged !== true || evidence.duplicate_effect_count !== 0 || evidence.unauthorized_effect_count !== 0) {
      return providerFail('STATE_RECORD_INVALID', 'live evidence image, queue, or effect counters differ')
    }
  }
}

function assertJournal(
  state: FleetRuntimeLocalOperationState,
  request: FleetRuntimeRequest,
  ownerId: string,
  requireComplete = false,
): void {
  assertPlainRecord(state, 'operation state')
  assertExactKeys(state, [
    'execution_owner_id', 'idempotency_key', 'operation', 'phase_sequence', 'phases',
    'request_digest', 'request_id', 'schema_version',
  ], 'operation state')
  if (state.schema_version !== STATE_SCHEMA || state.request_id !== request.request_id
    || state.request_digest !== request.request_digest || state.idempotency_key !== request.idempotency_key
    || state.operation !== request.operation || state.execution_owner_id !== ownerId) {
    return providerFail('OPERATION_STATE_MISMATCH', 'operation journal is not bound to this exact request')
  }
  const expectedOrder = OPERATION_PHASES[request.operation as keyof typeof OPERATION_PHASES] ?? []
  if (!Array.isArray(state.phase_sequence) || new Set(state.phase_sequence).size !== state.phase_sequence.length
    || canonicalFleetRuntimeJson(state.phase_sequence) !== canonicalFleetRuntimeJson(expectedOrder.slice(0, state.phase_sequence.length))
    || (requireComplete && state.phase_sequence.length !== expectedOrder.length)) {
    return providerFail('STATE_RECORD_INVALID', 'operation phase sequence is missing, extra, duplicate, or reordered')
  }
  assertPlainRecord(state.phases, 'operation phases')
  if (Object.keys(state.phases).length !== state.phase_sequence.length
    || state.phase_sequence.some(phase => !Object.hasOwn(state.phases, phase))) {
    return providerFail('STATE_RECORD_INVALID', 'operation phase map differs from its exact sequence')
  }
  const priorEvidence: Partial<Record<FleetRuntimeLocalPhase, Record<string, unknown>>> = {}
  for (const phaseName of state.phase_sequence) {
    const phase = state.phases[phaseName]!
    assertPlainRecord(phase, `${phaseName} state`)
    assertExactKeys(phase, [
      'completed_at', 'evidence', 'evidence_sha256', 'intent', 'intent_sha256',
      'protected_effect_count', 'started_at', 'status',
    ], `${phaseName} state`)
    const started = Date.parse(String(phase.started_at ?? ''))
    const completed = phase.completed_at === null ? null : Date.parse(String(phase.completed_at))
    if (!Number.isFinite(started) || (completed !== null && (!Number.isFinite(completed) || completed < started))
      || phase.intent_sha256 !== sha256(canonicalFleetRuntimeJson(phase.intent))
      || (phase.status === 'started' && (phase.completed_at !== null || phase.evidence !== null || phase.evidence_sha256 !== null))
      || (phase.status === 'completed' && (!phase.completed_at || !phase.evidence
        || phase.evidence_sha256 !== sha256(canonicalFleetRuntimeJson(phase.evidence))))
      || !['started', 'completed'].includes(phase.status)
      || phase.protected_effect_count !== (phase.status === 'completed' && PROTECTED_PHASES.has(phaseName) ? 1 : 0)) {
      return providerFail('STATE_RECORD_INVALID', `${phaseName} intent, evidence, timestamps, status, or protected count differs`)
    }
    validatePhaseSemantics(request, phaseName, phase, priorEvidence, ownerId)
    if (phase.status === 'completed') priorEvidence[phaseName] = clone(phase.evidence!)
    else if (phaseName !== state.phase_sequence.at(-1)) return providerFail('STATE_RECORD_INVALID', 'only the final journal phase may remain started')
  }
}

export function validateFleetRuntimeLocalOperationState(
  state: FleetRuntimeLocalOperationState,
  request: FleetRuntimeRequest,
  ownerId: string,
  requireComplete = true,
): void {
  assertJournal(state, request, ownerId, requireComplete)
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
        phase_sequence: [],
        phases: {},
      }
    }
    const state = readState<FleetRuntimeLocalOperationState>(this.persistence.root, path, 'operation state')
    assertJournal(state, request, state.execution_owner_id)
    if (state.execution_owner_id !== this.persistence.owner.owner_id) {
      const expected = clone(state)
      state.execution_owner_id = this.persistence.owner.owner_id
      for (const phase of state.phase_sequence) {
        const entry = state.phases[phase]!
        entry.intent.execution_owner_id = this.persistence.owner.owner_id
        entry.intent_sha256 = sha256(canonicalFleetRuntimeJson(entry.intent))
        if (entry.evidence) {
          entry.evidence.execution_owner_id = this.persistence.owner.owner_id
          entry.evidence.intent_sha256 = entry.intent_sha256
          entry.evidence_sha256 = sha256(canonicalFleetRuntimeJson(entry.evidence))
        }
      }
      this.persistence.commitOwnedRecord(request.idempotency_key, path, 'operation state', expected, state)
    }
    return state
  }

  private commitJournal(
    request: FleetRuntimeRequest,
    expected: FleetRuntimeLocalOperationState | null,
    next: FleetRuntimeLocalOperationState,
  ): void {
    assertJournal(next, request, this.persistence.owner.owner_id)
    this.persistence.commitOwnedRecord(request.idempotency_key, this.journalPath(request), 'operation state', expected, next)
  }

  private context(
    request: FleetRuntimeRequest,
    state: FleetRuntimeLocalOperationState,
    currentIntent: Record<string, unknown> = {},
    ownerRawBody = '',
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
      execution_owner_id: this.persistence.owner.owner_id,
      owner_decision_raw_body: ownerRawBody,
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
        const reconciled = await this.system.reconcilePhase(request, preflight, phase, this.context(
          request, state, prior.intent, preflight.owner_decision_raw_body, preflight.predecessor_receipt_raw_body,
        ))
        if (!reconciled.completed || !reconciled.evidence) {
          return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', `${phase} started but cannot be proven complete; it will not be repeated`)
        }
        const expected = clone(state)
        prior.status = 'completed'
        prior.completed_at = this.now()
        prior.evidence = phaseBoundRecord(request, phase, this.persistence.owner.owner_id, {
          intent_sha256: prior.intent_sha256,
          ...clone(reconciled.evidence),
        }, 'evidence')
        prior.evidence_sha256 = sha256(canonicalFleetRuntimeJson(prior.evidence))
        prior.protected_effect_count = reconciled.protected_effect_count
        this.commitJournal(request, expected, state)
        continue
      }

      const expected = state.phase_sequence.length === 0 && !existsSync(this.journalPath(request)) ? null : clone(state)
      const intentContext = this.context(request, state, {}, preflight.owner_decision_raw_body, preflight.predecessor_receipt_raw_body)
      const systemIntent = this.system.phaseIntent ? await this.system.phaseIntent(request, phase, intentContext) : {}
      const intent = phaseBoundRecord(request, phase, this.persistence.owner.owner_id, systemIntent, 'intent')
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
      state.phase_sequence.push(phase)
      this.commitJournal(request, expected, state)
      await this.persistence.heartbeatOwner(request.idempotency_key)
      const result = await this.system.performPhase(request, preflight, phase, this.context(
        request, state, intent, preflight.owner_decision_raw_body, preflight.predecessor_receipt_raw_body,
      ))
      if (PROTECTED_PHASES.has(phase) && result.protected_effect_count !== 1) {
        return providerFail('STATE_RECORD_INVALID', `${phase} must report exactly one protected subeffect`)
      }
      if (!PROTECTED_PHASES.has(phase) && result.protected_effect_count !== 0) {
        return providerFail('STATE_RECORD_INVALID', `${phase} reported an unauthorized protected subeffect`)
      }
      const started = clone(state)
      state.phases[phase] = {
        status: 'completed',
        started_at: state.phases[phase]!.started_at,
        completed_at: this.now(),
        evidence: phaseBoundRecord(request, phase, this.persistence.owner.owner_id, {
          intent_sha256: state.phases[phase]!.intent_sha256,
          ...clone(result.evidence),
        }, 'evidence'),
        intent: clone(intent),
        protected_effect_count: result.protected_effect_count,
        intent_sha256: sha256(canonicalFleetRuntimeJson(intent)),
        evidence_sha256: null,
      }
      state.phases[phase]!.evidence_sha256 = sha256(canonicalFleetRuntimeJson(state.phases[phase]!.evidence))
      this.commitJournal(request, started, state)
    }
    assertJournal(state, request, this.persistence.owner.owner_id, true)
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
    observed_at: request.queue_observation.observed_at,
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

export interface FleetRuntimeAdfReleaseReadback {
  root: string
  root_realpath: string
  root_is_directory: boolean
  root_is_symlink: boolean
  remote: string
  head: string
  tree: string
  status_porcelain: string
  branch: string
  source_sha256: string
  dist_sha256: string
}

export type FleetRuntimeAdfReleaseReader = (
  runner: FleetRuntimeArgvRunner,
  root: string,
) => Promise<FleetRuntimeAdfReleaseReadback>

export function validateFleetRuntimeAdfReleaseReadback(input: FleetRuntimeAdfReleaseReadback): void {
  assertPlainRecord(input, 'ADF readback release')
  assertExactKeys(input, [
    'branch', 'dist_sha256', 'head', 'remote', 'root', 'root_is_directory', 'root_is_symlink',
    'root_realpath', 'source_sha256', 'status_porcelain', 'tree',
  ], 'ADF readback release')
  const expected = FLEET_RUNTIME_V1_ADF_READBACK_RELEASE
  if (input.root !== expected.root || input.root_realpath !== expected.root
    || input.root_is_directory !== true || input.root_is_symlink !== false) {
    return providerFail('READBACK_INVALID', 'ADF readback release must be the exact real non-symlink approved root')
  }
  if (!(expected.origin_allowed as readonly string[]).includes(input.remote)
    || input.head !== expected.head || input.tree !== expected.tree
    || input.branch !== '' || input.status_porcelain !== '') {
    return providerFail('READBACK_INVALID', 'ADF readback release origin or exact detached clean image differs')
  }
  if (input.source_sha256 !== expected.source_sha256 || input.dist_sha256 !== expected.dist_sha256) {
    return providerFail('READBACK_INVALID', 'ADF readback release source or built CLI digest differs')
  }
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

function readSafeRegularFile(root: string, path: string, label: string): Buffer {
  assertSafeStatePath(root, path)
  const before = lstatSync(path)
  if (before.isSymbolicLink() || !before.isFile() || realpathSync(path) !== resolve(path)) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', `${label} must be a real contained regular file`)
  }
  const bytes = readFileSync(path)
  assertSafeStatePath(root, path)
  const after = lstatSync(path)
  if (after.isSymbolicLink() || !after.isFile() || realpathSync(path) !== resolve(path)
    || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', `${label} changed during readback`)
  }
  return bytes
}

async function readFleetRuntimeAdfRelease(
  runner: FleetRuntimeArgvRunner,
  root: string,
): Promise<FleetRuntimeAdfReleaseReadback> {
  if (root !== FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root || !existsSync(root)) {
    return providerFail('READBACK_INVALID', 'ADF readback release path differs or is absent')
  }
  const before = lstatSync(root)
  const rootRealpath = realpathSync(root)
  if (!before.isDirectory() || before.isSymbolicLink() || rootRealpath !== root) {
    return providerFail('READBACK_INVALID', 'ADF readback release is not the exact real non-symlink directory')
  }
  const run = async (argv: readonly string[]): Promise<string> => {
    const result = await runner.run(argv, { cwd: root })
    if (result.exitCode !== 0) return commandError(argv, result)
    return result.stdout.trim()
  }
  const [remote, head, tree, statusPorcelain, branch] = await Promise.all([
    run(['git', 'remote', 'get-url', 'origin']),
    run(['git', 'rev-parse', 'HEAD']),
    run(['git', 'rev-parse', 'HEAD^{tree}']),
    run(['git', 'status', '--porcelain=v1']),
    run(['git', 'branch', '--show-current']),
  ])
  const source = readSafeRegularFile(
    root,
    join(root, FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.source_path),
    'ADF goal-runtime released source',
  )
  const dist = readSafeRegularFile(
    root,
    join(root, FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.dist_path),
    'ADF released built CLI',
  )
  const after = lstatSync(root)
  if (!after.isDirectory() || after.isSymbolicLink() || realpathSync(root) !== root
    || before.dev !== after.dev || before.ino !== after.ino) {
    return providerFail('READBACK_INVALID', 'ADF readback release root changed during verification')
  }
  return {
    root,
    root_realpath: rootRealpath,
    root_is_directory: true,
    root_is_symlink: false,
    remote,
    head,
    tree,
    status_porcelain: statusPorcelain,
    branch,
    source_sha256: sha256(source).replace(/^sha256:/, ''),
    dist_sha256: sha256(dist).replace(/^sha256:/, ''),
  }
}

export function validateFleetRuntimePayloadDirectory(input: {
  state_directory: string
  directory: string
  manifest: readonly { path: string; bytes: number; sha256: string }[]
  label: string
  exact_path_set?: boolean
}): Record<string, { bytes: number; sha256: string }> {
  const directory = assertSafeStatePath(input.state_directory, input.directory)
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()
    || realpathSync(directory) !== directory) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', `${input.label} directory is not a real state descendant`)
  }
  const paths = input.manifest.map(file => file.path)
  assertExactFleetRuntimePathSet([...paths].sort(), paths, `${input.label} manifest`)
  if (input.exact_path_set) assertExactFleetRuntimePathSet(paths, recursiveRelativeFiles(directory), input.label)
  const blobs: Record<string, { bytes: number; sha256: string }> = {}
  for (const file of input.manifest) {
    const bytes = readSafeRegularFile(input.state_directory, join(directory, file.path), `${input.label} ${file.path}`)
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `${input.label} bytes differ at ${file.path}`)
    }
    blobs[file.path] = { bytes: bytes.byteLength, sha256: sha256(bytes) }
  }
  return blobs
}

export function selectFleetRuntimePayloadFromRenderer(input: {
  state_directory: string
  raw_output_path: string
  selected_payload_path: string
  renderer_report_raw: string
  manifest: { files: Array<{ path: string; bytes: number; sha256: string }> }
}): {
  raw_paths: string[]
  selected_blobs: Record<string, { bytes: number; sha256: string }>
  renderer_report_sha256: string
} {
  const rawRoot = assertSafeStatePath(input.state_directory, input.raw_output_path)
  const selectedRoot = assertSafeStatePath(input.state_directory, input.selected_payload_path)
  if (!existsSync(rawRoot) || lstatSync(rawRoot).isSymbolicLink() || !lstatSync(rawRoot).isDirectory() || realpathSync(rawRoot) !== rawRoot) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', 'renderer raw output must be a real state-root directory')
  }
  if (existsSync(selectedRoot)) return providerFail('PAYLOAD_VERIFICATION_FAILED', 'selected payload directory must be newly absent')
  const report = parseJson<Record<string, unknown>>(input.renderer_report_raw, 'renderer report')
  assertExactKeys(report, [
    'framework_ref', 'generated_files', 'mode', 'output_root', 'product', 'profile', 'required_next_actions',
    'schema', 'source_control', 'target_change_policy', 'target_repo', 'verdict',
  ], 'renderer report')
  if (report.schema !== 'shirube-adoption-pack-render/v1' || report.verdict !== 'PASS'
    || report.profile !== 'hotel-lite' || report.mode !== 'render' || report.target_repo !== 'watchout/kodama'
    || report.product !== 'Kodama' || report.source_control !== 'watchout/ai-dev-framework#576'
    || report.framework_ref !== `watchout/ai-dev-framework@${FLEET_RUNTIME_V1_CONTRACT.release_commit}`
    || report.output_root !== rawRoot || !Array.isArray(report.generated_files) || report.generated_files.length !== 34
    || canonicalFleetRuntimeJson(report.target_change_policy) !== canonicalFleetRuntimeJson(FLEET_RUNTIME_V1_RENDERER_TARGET_POLICY)
    || canonicalFleetRuntimeJson(report.required_next_actions) !== canonicalFleetRuntimeJson(FLEET_RUNTIME_V1_RENDERER_REQUIRED_ACTIONS)) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', 'renderer report provenance or exact 34-file output differs')
  }
  const reportPaths: string[] = []
  for (const [index, unknownRow] of report.generated_files.entries()) {
    assertPlainRecord(unknownRow, `renderer report generated_files[${index}]`)
    assertExactKeys(unknownRow, ['bytes', 'output_path', 'path', 'sha256'], `renderer report generated_files[${index}]`)
    const path = assertString(unknownRow.path, `renderer report generated_files[${index}].path`)
    const outputPath = assertSafeStatePath(input.state_directory, join(rawRoot, path))
    const bytes = readSafeRegularFile(input.state_directory, outputPath, `renderer output ${path}`)
    if (unknownRow.output_path !== outputPath || unknownRow.bytes !== bytes.byteLength
      || unknownRow.sha256 !== sha256(bytes).replace(/^sha256:/, '')) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `renderer report file binding differs at ${path}`)
    }
    reportPaths.push(path)
  }
  const rawPaths = recursiveRelativeFiles(rawRoot)
  if (new Set(reportPaths).size !== 34
    || canonicalFleetRuntimeJson([...reportPaths].sort()) !== canonicalFleetRuntimeJson(rawPaths)) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', 'renderer report paths differ from the complete raw output')
  }
  const payloadPaths = input.manifest.files.map(file => file.path)
  assertExactFleetRuntimePathSet([...payloadPaths].sort(), payloadPaths, 'selected payload manifest')
  if (payloadPaths.some(path => !rawPaths.includes(path)) || rawPaths.length - payloadPaths.length !== 10) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', 'raw renderer output does not contain the selected 24 plus exact ten extras')
  }
  safeMkdir(input.state_directory, selectedRoot)
  const selectedBlobs: Record<string, { bytes: number; sha256: string }> = {}
  for (const file of input.manifest.files) {
    const source = assertSafeStatePath(input.state_directory, join(rawRoot, file.path))
    const target = assertSafeStatePath(input.state_directory, join(selectedRoot, file.path))
    const bytes = readSafeRegularFile(input.state_directory, source, `renderer source ${file.path}`)
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `renderer source bytes differ at ${file.path}`)
    }
    safeMkdir(input.state_directory, dirname(target))
    copyFileSync(source, target)
    const selected = readSafeRegularFile(input.state_directory, target, `selected payload ${file.path}`)
    if (selected.byteLength !== file.bytes || sha256(selected) !== file.sha256) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `selected payload bytes differ at ${file.path}`)
    }
    selectedBlobs[file.path] = { bytes: selected.byteLength, sha256: sha256(selected) }
  }
  const verifiedSelected = validateFleetRuntimePayloadDirectory({
    state_directory: input.state_directory,
    directory: selectedRoot,
    manifest: input.manifest.files,
    label: 'selected payload directory',
    exact_path_set: true,
  })
  if (canonicalFleetRuntimeJson(verifiedSelected) !== canonicalFleetRuntimeJson(selectedBlobs)) {
    return providerFail('PAYLOAD_VERIFICATION_FAILED', 'selected payload changed after copy')
  }
  return { raw_paths: rawPaths, selected_blobs: verifiedSelected, renderer_report_sha256: sha256(input.renderer_report_raw) }
}

export async function validateFleetRuntimeGitPayloadLayer(input: {
  runner: FleetRuntimeArgvRunner
  checkout: string
  manifest: readonly { path: string; bytes: number; sha256: string }[]
  layer: 'index' | 'commit'
  commit?: string
  expected_object_ids?: Record<string, string>
}): Promise<{
  blobs: Record<string, { bytes: number; sha256: string }>
  object_ids: Record<string, string>
  changed_paths: string[]
}> {
  const run = async (argv: readonly string[]): Promise<string> => {
    const result = await input.runner.run(argv, { cwd: input.checkout })
    if (result.exitCode !== 0) return commandError(argv, result)
    return result.stdout
  }
  const paths = input.manifest.map(file => file.path)
  assertExactFleetRuntimePathSet([...paths].sort(), paths, `${input.layer} manifest`)
  const blobs: Record<string, { bytes: number; sha256: string }> = {}
  const objectIds: Record<string, string> = {}
  for (const file of input.manifest) {
    const spec = input.layer === 'index' ? `:${file.path}` : `${input.commit}:${file.path}`
    const objectResult = await input.runner.run(['git', 'rev-parse', spec], { cwd: input.checkout })
    if (objectResult.exitCode !== 0) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `${input.layer} blob is absent at ${file.path}`)
    }
    const objectId = objectResult.stdout.trim()
    const blobResult = await input.runner.run(['git', 'cat-file', 'blob', objectId], { cwd: input.checkout })
    if (blobResult.exitCode !== 0) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `${input.layer} blob is unreadable at ${file.path}`)
    }
    const bytes = Buffer.from(blobResult.stdout)
    if (!COMMIT.test(objectId) || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256
      || (input.expected_object_ids && objectId !== input.expected_object_ids[file.path])) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `${input.layer} blob differs at ${file.path}`)
    }
    objectIds[file.path] = objectId
    blobs[file.path] = { bytes: bytes.byteLength, sha256: sha256(bytes) }
  }
  // The manifest binds the complete 24-file inventory above. Git's delta is
  // a different layer: byte-identical payload files are absent from diff
  // output, so derive the ordered changed subset from the frozen parent tree.
  const commit = input.layer === 'commit' ? assertCommit(input.commit, 'commit layer head') : null
  const baseline = (await run(['git', 'rev-parse', input.layer === 'index' ? 'HEAD' : `${commit}^`])).trim()
  assertCommit(baseline, `${input.layer} baseline`)
  const baselineTree = await run(['git', 'ls-tree', '-rz', '--full-tree', baseline, '--', ...paths])
  const baselineObjectIds = new Map<string, string>()
  for (const row of baselineTree.split('\0').filter(Boolean)) {
    const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/.exec(row)
    if (!match || !paths.includes(match[4]) || baselineObjectIds.has(match[4])) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', `${input.layer} baseline tree differs from the manifest namespace`)
    }
    baselineObjectIds.set(match[4], match[3])
  }
  const changedPaths = paths.filter(path => baselineObjectIds.get(path) !== objectIds[path])
  const actual = input.layer === 'index'
    ? (await run(['git', 'diff', '--cached', '--no-renames', '--name-only'])).trim().split('\n').filter(Boolean)
    : (await run(['git', 'diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', commit!])).trim().split('\n').filter(Boolean)
  assertExactFleetRuntimeChangedPathSet(changedPaths, actual, `${input.layer} paths`)
  validateFleetRuntimePayloadBlobLayer(input.manifest, paths.map(path => ({ path, ...blobs[path] })), `${input.layer} blobs`)
  return { blobs, object_ids: objectIds, changed_paths: changedPaths }
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
    private readonly adfReleaseReader: FleetRuntimeAdfReleaseReader = readFleetRuntimeAdfRelease,
    private readonly databaseUrl: string | undefined = process.env.DATABASE_URL,
  ) {}

  private databaseEnvironment(): Record<string, string> {
    if (!this.databaseUrl) return providerFail('READBACK_INVALID', 'DATABASE_URL environment binding is absent')
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    return { ...env, AGENT_COM_DB: 'postgres', DATABASE_URL: this.databaseUrl }
  }

  private async run(argv: readonly string[], cwd?: string, env?: Record<string, string>): Promise<string> {
    const result = await this.runner.run(argv, { cwd, env })
    if (result.exitCode !== 0) return commandError(argv, result)
    return result.stdout
  }

  private async ghJson<T>(path: string): Promise<T> {
    return parseJson<T>(await this.run(['gh', 'api', path]), `gh api ${path}`)
  }

  private async comment(url: string): Promise<GitHubCommentReadback> {
    return this.ghJson<GitHubCommentReadback>(`repos/watchout/ai-dev-framework/issues/comments/${commentId(url)}`)
  }

  async readAdfRootGoalStatus(): Promise<string> {
    const first = await this.adfReleaseReader(this.runner, FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root)
    validateFleetRuntimeAdfReleaseReadback(first)
    const second = await this.adfReleaseReader(this.runner, FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root)
    validateFleetRuntimeAdfReleaseReadback(second)
    if (canonicalFleetRuntimeJson(first) !== canonicalFleetRuntimeJson(second)) {
      return providerFail('READBACK_INVALID', 'ADF readback release changed between the two complete pre-spawn readbacks')
    }
    const result = await this.runner.run([
      'node', FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.dist_path, 'goal-runtime', 'status', '--store',
      FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.store_path, '--format', 'json',
    ], { cwd: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root })
    const report = parseFleetRuntimeRootGoalReadback(parseJson(result.stdout, 'root-goal status'))
    if (result.stderr !== '') {
      return providerFail('READBACK_INVALID', 'root-goal status emitted unexpected stderr')
    }
    const expectedExit = report.verdict === 'BLOCKED' ? 1 : 0
    if (result.exitCode !== expectedExit) {
      return providerFail('READBACK_INVALID', 'root-goal status exit and validated report disagree')
    }
    return result.stdout
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

  private async queueObservation(): Promise<FleetRuntimeQueueObservationV2> {
    const raw = await this.run([
      process.execPath, 'cli/index.ts', 'fleet-runtime', 'queue-observation', '--format', 'json',
    ], this.providerRepositoryRoot, this.databaseEnvironment())
    const parsed = parseCanonicalJson<FleetRuntimeQueueObservationV2>(raw.trim(), 'official queue observation')
    return parseFleetRuntimeQueueStatus(parsed, this.nowMs())
  }

  async inspect(readonlyRequest: Readonly<FleetRuntimeRequest>): Promise<FleetRuntimePreflightReceipt> {
    const request = readonlyRequest as FleetRuntimeRequest
    const [owner, predecessor, preimage, observation, rootRaw] = await Promise.all([
      this.comment(request.owner_decision.url),
      this.comment(request.predecessor_receipt.url),
      this.remotePreimage(request),
      this.queueObservation(),
      this.readAdfRootGoalStatus(),
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
    const predecessorBinding = parseFleetRuntimeOperationPredecessorBinding(request, owner.body)
    const companion = predecessorBinding.companion_url
      ? await this.comment(predecessorBinding.companion_url)
      : null
    if (companion && sha256(companion.body) !== predecessorBinding.companion_raw_body_sha256) {
      return providerFail('READBACK_INVALID', 'immutable rollback companion raw-body digest differs')
    }
    validateFleetRuntimeImmutableSemantics(request, owner.body, predecessor.body, companion?.body)
    try {
      assertFleetRuntimeSealToPreObservation(request.queue_observation, observation, this.nowMs())
    } catch (error) {
      return providerFail('READBACK_INVALID', `sealed observation preflight differs: ${(error as Error).message}`)
    }
    return {
      schema_version: 'fleet-runtime-v1/preflight-receipt/v2',
      request_digest: request.request_digest,
      observed_at: observation.observed_at,
      owner_decision_readback: clone(request.owner_decision),
      owner_decision_raw_body: owner.body,
      predecessor_receipt_readback: clone(request.predecessor_receipt),
      predecessor_receipt_raw_body: predecessor.body,
      target_preimages: [preimage],
      queue_observation: observation,
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

  async verifyCheckout(
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
    const branch = (await this.run(['git', 'branch', '--show-current'], path)).trim()
    validateFleetRuntimeCheckoutReadback({
      checkout_path: path,
      state_directory: stateDirectory,
      canonical_path: '/Users/yuji/Developer/kodama',
      remote,
      head,
      tree,
      status_porcelain: status,
      branch,
      expected_head: expectedHead,
      expected_tree: expectedTree,
    })
    return { checkout_path: path, remote, head, tree, clean: true, detached: true }
  }

  async verifyReleaseCheckout(path: string, stateDirectory: string): Promise<Record<string, unknown>> {
    return this.verifyRendererSourceCheckout(path, stateDirectory)
  }

  async verifyRendererSourceCheckout(path: string, stateDirectory: string): Promise<Record<string, unknown>> {
    assertSafeStatePath(stateDirectory, path)
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path
      || path === '/Users/yuji/Developer/ai-dev-framework') {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'renderer source checkout must be a dedicated real state descendant')
    }
    const remote = (await this.run(['git', 'remote', 'get-url', 'origin'], path)).trim()
    const head = (await this.run(['git', 'rev-parse', 'HEAD'], path)).trim()
    const tree = (await this.run(['git', 'rev-parse', 'HEAD^{tree}'], path)).trim()
    const status = await this.run(['git', 'status', '--porcelain=v1'], path)
    const branch = (await this.run(['git', 'branch', '--show-current'], path)).trim()
    const rendererBlob = (await this.run(['git', 'rev-parse', `HEAD:${FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_path}`], path)).trim()
    const workflowTemplateBlob = (await this.run([
      'git', 'rev-parse', `HEAD:${FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_path}`,
    ], path)).trim()
    if (!new Set(['https://github.com/watchout/ai-dev-framework.git', 'git@github.com:watchout/ai-dev-framework.git']).has(remote)
      || head !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref || tree !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree
      || rendererBlob !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_blob
      || workflowTemplateBlob !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_blob
      || status !== '' || branch !== '') {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'renderer source origin, image, blobs, detached state, or cleanliness differs')
    }
    return {
      checkout_path: path,
      remote,
      head,
      tree,
      renderer_blob: rendererBlob,
      workflow_template_blob: workflowTemplateBlob,
      clean: true,
      detached: true,
    }
  }

  phaseIntent(
    readonlyRequest: Readonly<FleetRuntimeRequest>,
    phase: FleetRuntimeLocalPhase,
    readonlyContext: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Record<string, unknown> {
    const request = readonlyRequest as FleetRuntimeRequest
    const context = readonlyContext as FleetRuntimeLocalPhaseContext
    const prepared = context.prior_evidence.PREPARE_CLEAN_CHECKOUT
    const staged = context.prior_evidence.STAGE_EXACT_PAYLOAD
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
    if (phase === 'STAGE_EXACT_PAYLOAD') {
      return {
        payload_digest: request.payload_digest,
        path_count: 24,
        raw_output_path: join(context.invocation_directory, 'renderer-raw-output'),
        release_commit: request.subject.release_commit,
        release_tree: request.subject.release_tree,
        renderer_source_ref: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref,
        renderer_source_tree: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree,
        selected_payload_path: join(context.invocation_directory, 'selected-payload'),
      }
    }
    if (phase === 'VERIFY_EXACT_PAYLOAD') {
      return {
        payload_digest: request.payload_digest,
        path_count: 24,
        selected_payload_path: staged?.selected_payload_path,
      }
    }
    if (phase === 'CREATE_LOCAL_COMMIT') return { payload_digest: request.payload_digest, path_count: 24 }
    if (phase === 'CREATE_LOCAL_REVERT') {
      const input = this.operationInputReceipt(request, context)
      return { merge_commit: input?.merge_commit, expected_tree: request.preimages[0].tree }
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
      return {
        repository: 'watchout/kodama', base: request.preimages[0].required_base_branch,
        branch: pushed?.branch, head: pushed?.head, draft: true,
      }
    }
    if (phase === 'VERIFY_EXTERNAL_MERGE') {
      return {
        repository: 'watchout/kodama', pr_url: created?.pr_url,
        pushed_head: pushed?.head, base: request.preimages[0].required_base_branch,
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
    const binding = parseFleetRuntimeOperationPredecessorBinding(request, context.owner_decision_raw_body)
    return validateFleetRuntimePredecessorReceipt(request, context.predecessor_receipt_raw_body, binding)
  }

  private async localCommitResidualPaths(checkout: string): Promise<string[]> {
    const unstaged = (await this.run(['git', 'diff', '--no-renames', '--name-only'], checkout))
      .trim().split('\n').filter(Boolean)
    const untracked = (await this.run(['git', 'ls-files', '--others', '--exclude-standard'], checkout))
      .trim().split('\n').filter(Boolean)
    return [...new Set([...unstaged, ...untracked])].sort()
  }

  private async createLocalCommitEvidence(
    request: FleetRuntimeRequest,
    context: FleetRuntimeLocalPhaseContext,
    allowCompletedCommit: boolean,
  ): Promise<Record<string, unknown>> {
    const checkout = this.checkoutPath(context)
    const branch = `shirube-v41-${request.operation.toLowerCase().replaceAll('_', '-')}-${request.request_digest.slice(-12)}`
    const paths = context.prior_evidence.VERIFY_EXACT_PAYLOAD?.payload_paths
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'verified payload path evidence is absent')
    }
    assertExactFleetRuntimePathSet([...paths as string[]].sort(), paths as string[], 'commit path evidence')
    const manifest = await this.payloadManifest(request)
    const expectedBase = String(context.prior_evidence.PREPARE_CLEAN_CHECKOUT?.head ?? '')
    assertCommit(expectedBase, 'local commit preimage head')
    const currentHead = (await this.run(['git', 'rev-parse', 'HEAD'], checkout)).trim()
    const currentBranch = (await this.run(['git', 'branch', '--show-current'], checkout)).trim()

    if (currentHead !== expectedBase) {
      if (!allowCompletedCommit || currentBranch !== branch) {
        return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', 'local commit checkout is not at the exact preimage or deterministic branch')
      }
      const parent = (await this.run(['git', 'rev-parse', `${currentHead}^`], checkout)).trim()
      if (parent !== expectedBase || (await this.run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], checkout)) !== '') {
        return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', 'local commit cannot be bound to one clean commit above the exact preimage')
      }
      const index = await validateFleetRuntimeGitPayloadLayer({
        runner: this.runner, checkout, manifest: manifest.files, layer: 'index',
      })
      assertExactFleetRuntimeChangedPathSet([], index.changed_paths, 'resumed clean index')
      const committed = await validateFleetRuntimeGitPayloadLayer({
        runner: this.runner,
        checkout,
        manifest: manifest.files,
        layer: 'commit',
        commit: currentHead,
        expected_object_ids: index.object_ids,
      })
      return {
        branch,
        head: currentHead,
        payload_paths: paths,
        index_blobs: index.blobs,
        commit_blobs: committed.blobs,
      }
    }

    const preSwitchResidual = await this.localCommitResidualPaths(checkout)
    if (preSwitchResidual.some(path => !(paths as string[]).includes(path))) {
      return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', 'local commit checkout has non-payload worktree residue')
    }
    if (currentBranch === '') await this.run(['git', 'switch', '-c', branch], checkout)
    else if (currentBranch !== branch) {
      return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', 'local commit checkout is attached to a foreign branch')
    }
    await this.run(['git', 'add', '--', ...paths as string[]], checkout)
    assertExactFleetRuntimeChangedPathSet([], await this.localCommitResidualPaths(checkout), 'local commit unstaged paths')
    const index = await validateFleetRuntimeGitPayloadLayer({
      runner: this.runner, checkout, manifest: manifest.files, layer: 'index',
    })
    if (index.changed_paths.length === 0) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'local commit has no changed-against-preimage payload paths')
    }
    await this.run(['git', 'commit', '-m', `chore(shirube): ${request.operation.toLowerCase().replaceAll('_', ' ')}`], checkout)
    const head = (await this.run(['git', 'rev-parse', 'HEAD'], checkout)).trim()
    const committed = await validateFleetRuntimeGitPayloadLayer({
      runner: this.runner,
      checkout,
      manifest: manifest.files,
      layer: 'commit',
      commit: head,
      expected_object_ids: index.object_ids,
    })
    assertExactFleetRuntimeChangedPathSet(index.changed_paths, committed.changed_paths, 'index/commit changed paths')
    if ((await this.run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], checkout)) !== '') {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'local commit left checkout residue')
    }
    return {
      branch,
      head,
      payload_paths: paths,
      index_blobs: index.blobs,
      commit_blobs: committed.blobs,
    }
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
    const companionEvidence: Record<string, unknown> = {}
    if (request.operation === 'REAPPLY') {
      const binding = parseFleetRuntimeOperationPredecessorBinding(request, context.owner_decision_raw_body)
      const companion = await this.comment(String(binding.companion_url))
      const rollback = validateFleetRuntimeRollbackCompanionReceipt(request, companion.body, binding, operationInput!)
      companionEvidence.rollback_receipt_url = binding.companion_url
      companionEvidence.rollback_receipt_raw_body_sha256 = binding.companion_raw_body_sha256
      companionEvidence.rollback_receipt_self_sha256 = rollback.receipt_sha256
    }
    return {
      ...evidence,
      baseline_runtime_instance_id: request.queue_observation.runtime_inventory.latest_instance?.runtime_instance_id ?? null,
      ...companionEvidence,
    }
  }

  private async externalMerge(request: FleetRuntimeRequest, context: FleetRuntimeLocalPhaseContext): Promise<Record<string, unknown>> {
    const path = join(context.invocation_directory, 'external-merge-receipt.json')
    if (!existsSync(path)) return providerFail('WAITING_INDEPENDENT_MERGE', 'exact external merge receipt is not present')
    assertSafeStatePath(context.state_directory, path)
    const before = lstatSync(path)
    if (before.isSymbolicLink() || !before.isFile() || realpathSync(path) !== path) {
      return providerFail('READBACK_INVALID', 'external merge receipt must be a real regular file')
    }
    const raw = readFileSync(path, 'utf8')
    assertSafeStatePath(context.state_directory, path)
    const after = lstatSync(path)
    if (after.isSymbolicLink() || !after.isFile() || realpathSync(path) !== path
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return providerFail('READBACK_INVALID', 'external merge receipt changed during readback')
    }
    const receipt = parseJson<Record<string, unknown>>(raw, 'external merge receipt')
    if (raw !== `${canonicalFleetRuntimeJson(receipt)}\n`) {
      return providerFail('READBACK_INVALID', 'external merge receipt bytes are not canonical JSON plus LF')
    }
    validateFleetRuntimeExternalMergeReceipt(request, receipt, {
      createdPrUrl: String(context.current_intent.pr_url ?? ''),
      pushedHead: String(context.current_intent.pushed_head ?? ''),
    })
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
    const contentAtPin = async (path: string): Promise<string> => {
      const envelope = await this.ghJson<{ encoding: string; content: string }>(
        `repos/${FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.repository}/contents/${path}?ref=${FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref}`,
      )
      if (envelope.encoding !== 'base64' || typeof envelope.content !== 'string') {
        return providerFail('PAYLOAD_VERIFICATION_FAILED', 'payload amendment API encoding differs')
      }
      return Buffer.from(envelope.content.replace(/\s+/g, ''), 'base64').toString('utf8')
    }
    const amendmentRaw = await contentAtPin(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.path)
    if (sha256(amendmentRaw) !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.amendment_byte_sha256) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'payload amendment byte digest differs')
    }
    const amendment = parseJson<Record<string, unknown>>(amendmentRaw, 'payload amendment')
    assertPlainRecord(amendment.original_immutable_artifact_binding, 'payload amendment original binding')
    assertPlainRecord(amendment.release_binding, 'payload amendment release binding')
    assertPlainRecord(amendment.previous_selected_payload, 'payload amendment previous selected payload')
    assertPlainRecord(amendment.effective_selected_payload, 'payload amendment effective selected payload')
    const originalBinding = amendment.original_immutable_artifact_binding
    const releaseBinding = amendment.release_binding
    const previousPayload = amendment.previous_selected_payload
    const effectivePayload = amendment.effective_selected_payload
    assertPlainRecord(effectivePayload.construction, 'payload amendment construction')
    const construction = effectivePayload.construction
    if (amendment.schema_version !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.schema_version
      || amendment.artifact_state !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.artifact_state
      || amendment.amendment_id !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.amendment_id
      || amendment.amendment_sha256 !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.amendment_sha256
      || canonicalSelfDigest(amendment, 'amendment_sha256') !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.amendment_sha256
      || originalBinding.path !== 'releases/shirube-v4.1/target-payload-manifest.json'
      || originalBinding.byte_sha256 !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.original_immutable_artifacts[1].byte_sha256
      || originalBinding.mutation_forbidden !== true
      || releaseBinding.repository !== FLEET_RUNTIME_V1_CONTRACT.release_repository
      || releaseBinding.commit !== FLEET_RUNTIME_V1_CONTRACT.release_commit
      || releaseBinding.tree !== FLEET_RUNTIME_V1_CONTRACT.release_tree
      || releaseBinding.release_manifest_digest !== FLEET_RUNTIME_V1_CONTRACT.release_manifest_digest
      || previousPayload.payload_records_sha256 !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.previous_payload_digest
      || construction.renderer_path !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_path
      || construction.renderer_content_sha256 !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_content_sha256
      || effectivePayload.path_manifest_sha256 !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.effective_path_manifest_sha256
      || effectivePayload.payload_records_sha256 !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.effective_payload_digest
      || effectivePayload.path_count !== FLEET_RUNTIME_V1_LOCAL_PROVIDER.payload_path_count
      || !Array.isArray(effectivePayload.files)) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'payload amendment binding differs')
    }
    const manifest: FleetRuntimePayloadManifest = {
      files: effectivePayload.files as FleetRuntimePayloadManifest['files'],
      payload_records_sha256: String(effectivePayload.payload_records_sha256),
      path_count: Number(effectivePayload.path_count),
    }
    if (!Array.isArray(manifest.files)) return providerFail('PAYLOAD_VERIFICATION_FAILED', 'payload manifest files are absent')
    const paths = manifest.files.map(file => file.path)
    assertExactFleetRuntimePathSet([...paths].sort(), paths, 'manifest ordering')
    if (manifest.path_count !== 24
      || canonicalFleetRuntimeJson(manifest.files) !== canonicalFleetRuntimeJson(FLEET_RUNTIME_V1_PAYLOAD_MANIFEST_FILES)
      || manifest.files.some(file => !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA256.test(file.sha256))
      || sha256(`${paths.join('\n')}\n`) !== FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.effective_path_manifest_sha256
      || sha256(canonicalFleetRuntimeJson(manifest.files)) !== request.payload_digest
      || manifest.payload_records_sha256 !== request.payload_digest) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'aggregate payload manifest differs')
    }
    const immutableReadbacks = await Promise.all(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.original_immutable_artifacts.map(async artifact => ({
      artifact,
      raw: await contentAtPin(artifact.path),
    })))
    if (immutableReadbacks.some(({ artifact, raw }) => sha256(raw) !== artifact.byte_sha256)) {
      return providerFail('PAYLOAD_VERIFICATION_FAILED', 'original immutable release artifact byte digest differs')
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
      // The release identity remains the sealed framework_ref, while the
      // regenerated payload's renderer/template bytes come only from the
      // immutable amendment commit. The selected 24 records are checked by the
      // amendment manifest before any push is admitted.
      const rawOutput = join(context.invocation_directory, 'renderer-raw-output')
      const selectedPayload = join(context.invocation_directory, 'selected-payload')
      if (phase === 'STAGE_EXACT_PAYLOAD') {
        const manifest = await this.payloadManifest(request)
        const payloadPaths = manifest.files.map(file => file.path)
        const rendererSourceCheckout = join(context.invocation_directory, 'adf-payload-amendment')
        if (!existsSync(rendererSourceCheckout)) {
          await this.run(['git', 'clone', '--no-checkout', 'https://github.com/watchout/ai-dev-framework.git', rendererSourceCheckout])
          await this.run(['git', 'checkout', '--detach', FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref], rendererSourceCheckout)
        }
        const rendererSourceBefore = await this.verifyRendererSourceCheckout(rendererSourceCheckout, context.state_directory)
        if (existsSync(rawOutput) || existsSync(selectedPayload)) {
          return providerFail('PAYLOAD_VERIFICATION_FAILED', 'renderer raw and selected payload directories must be newly absent')
        }
        safeMkdir(context.state_directory, rawOutput)
        const rendererReportRaw = await this.run([
          'node', 'scripts/shirube/render-adoption-pack.mjs', '--profile', 'hotel-lite',
          '--target-repo', 'watchout/kodama', '--product', 'Kodama',
          '--source-control', 'watchout/ai-dev-framework#576',
          '--framework-ref', `watchout/ai-dev-framework@${FLEET_RUNTIME_V1_CONTRACT.release_commit}`,
          '--owner-actor', 'watchout',
          '--owner-confirmation-ref', 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-5260213858',
          '--cell-id', 'N40-P4-CANARY-VERIFY', '--mode', 'render', '--out', rawOutput, '--format', 'json',
          '--generated-at', '2026-08-12T00:00:00.000Z', '--fetched-at', '2026-08-12T00:00:00.000Z',
          '--generated-by', 'codex-cto', '--include-workflow-caller',
        ], rendererSourceCheckout)
        const rendererSourceAfter = await this.verifyRendererSourceCheckout(rendererSourceCheckout, context.state_directory)
        const selection = selectFleetRuntimePayloadFromRenderer({
          state_directory: context.state_directory,
          raw_output_path: rawOutput,
          selected_payload_path: selectedPayload,
          renderer_report_raw: rendererReportRaw,
          manifest,
        })
        for (const file of manifest.files) {
          const payloadPath = file.path
          const source = assertSafeStatePath(context.state_directory, join(selectedPayload, payloadPath))
          const target = assertSafeStatePath(context.state_directory, join(checkout, payloadPath))
          const bytes = readSafeRegularFile(context.state_directory, source, `selected source ${payloadPath}`)
          if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
            return providerFail('PAYLOAD_VERIFICATION_FAILED', `selected bytes differ at ${payloadPath}`)
          }
          if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || realpathSync(target) !== target)) {
            return providerFail('PAYLOAD_VERIFICATION_FAILED', `checkout target is unsafe at ${payloadPath}`)
          }
          safeMkdir(context.state_directory, dirname(target))
          copyFileSync(source, target)
          const copied = readSafeRegularFile(context.state_directory, target, `checkout target ${payloadPath}`)
          if (copied.byteLength !== file.bytes || sha256(copied) !== file.sha256) {
            return providerFail('PAYLOAD_VERIFICATION_FAILED', `checkout copy differs at ${payloadPath}`)
          }
        }
        return {
          evidence: {
            raw_output_path: rawOutput,
            selected_payload_path: selectedPayload,
            renderer_source_checkout_before: rendererSourceBefore,
            renderer_source_checkout_after: rendererSourceAfter,
            renderer_report_sha256: selection.renderer_report_sha256,
            raw_path_count: selection.raw_paths.length,
            raw_paths: selection.raw_paths,
            payload_digest: request.payload_digest,
            path_count: 24,
            payload_paths: payloadPaths,
            selected_blobs: selection.selected_blobs,
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
      const checkoutBlobs = validateFleetRuntimePayloadDirectory({
        state_directory: context.state_directory,
        directory: checkout,
        manifest: manifest.files,
        label: 'checkout payload',
      })
      return {
        evidence: {
          selected_payload_path: String(context.prior_evidence.STAGE_EXACT_PAYLOAD?.selected_payload_path ?? ''),
          payload_digest: request.payload_digest,
          path_count: 24,
          payload_paths: expectedPaths,
          checkout_blobs: checkoutBlobs,
        },
        protected_effect_count: 0,
      }
    }
    if (phase === 'CREATE_LOCAL_COMMIT') {
      return {
        evidence: await this.createLocalCommitEvidence(request, mutableContext, false),
        protected_effect_count: 0,
      }
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
      return { evidence: { pr_url: prUrl, branch, head: pushed?.head, draft: true }, protected_effect_count: 1 }
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
      await this.run(['tmux', 'new-session', '-d', '-s', session, '-c', checkout, ...command], undefined, this.databaseEnvironment())
      return { evidence: { ...clean, session, port: 8803 }, protected_effect_count: 1 }
    }
    if (phase === 'VERIFY_LIVE_IDENTITY') {
      const checkoutImage = await this.verifyCheckout(
        checkout,
        context.state_directory,
        String(context.current_intent.expected_head ?? '') || undefined,
        String(context.current_intent.expected_tree ?? '') || undefined,
      )
      const postObservation = await this.queueObservation()
      try {
        assertFleetRuntimePreToPostObservation(preflight.queue_observation, postObservation, {
          approvedStateRoot: FLEET_RUNTIME_V1_PRODUCTION_STATE_ROOT,
          canonicalCheckout: '/Users/yuji/Developer/kodama',
          nowMs: this.nowMs(),
        })
      } catch (error) {
        return providerFail('READBACK_INVALID', `post-effect observation differs: ${(error as Error).message}`)
      }
      const latest = postObservation.runtime_inventory.latest_instance!
      const runtimeInstance = latest.runtime_instance_id
      const inventory = postObservation.runtime_inventory
      const remoteImage = await this.remoteSurface(request.preimages[0].required_base_branch)
      const merged = context.prior_evidence.VERIFY_EXTERNAL_MERGE
      const prepared = context.prior_evidence.PREPARE_CLEAN_CHECKOUT
      const expectedHead = request.operation === 'RECOVERY'
        ? String(prepared?.head ?? '')
        : String(merged?.merge_commit ?? '')
      const expectedTree = request.operation === 'RECOVERY'
        ? request.preimages[0].tree
        : String(merged?.merge_tree ?? '')
      if (latest.checkout_path !== checkout || latest.commit_sha !== expectedHead
        || checkoutImage.head !== expectedHead || checkoutImage.tree !== expectedTree) {
        return providerFail('READBACK_INVALID', 'post runtime inventory is not bound to the operation-indexed checkout image')
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
          queue_unchanged: postObservation.queue.queue_observation_id === preflight.queue_observation.queue.queue_observation_id,
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
    // Reconciliation is explicit for every phase. Protected effects are never
    // blindly repeated after process loss. CREATE_LOCAL_COMMIT may resume only
    // after proving the exact preimage/branch/index state; it has no protected
    // effect and is required to make a reserved no-receipt journal retryable.
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
      if (phase !== 'PREPARE_CLEAN_CHECKOUT') return { completed: true, evidence, protected_effect_count: 0 }
      const companionEvidence: Record<string, unknown> = {}
      if (request.operation === 'REAPPLY') {
        const binding = parseFleetRuntimeOperationPredecessorBinding(request as FleetRuntimeRequest, mutable.owner_decision_raw_body)
        const recovery = this.operationInputReceipt(request as FleetRuntimeRequest, mutable)!
        const companion = await this.comment(String(binding.companion_url))
        const rollback = validateFleetRuntimeRollbackCompanionReceipt(request as FleetRuntimeRequest, companion.body, binding, recovery)
        companionEvidence.rollback_receipt_url = binding.companion_url
        companionEvidence.rollback_receipt_raw_body_sha256 = binding.companion_raw_body_sha256
        companionEvidence.rollback_receipt_self_sha256 = rollback.receipt_sha256
      }
      return {
        completed: true,
        evidence: {
          ...evidence,
          baseline_runtime_instance_id: request.queue_observation.runtime_inventory.latest_instance?.runtime_instance_id ?? null,
          ...companionEvidence,
        },
        protected_effect_count: 0,
      }
    }
    if (phase === 'VERIFY_EXACT_PAYLOAD' || phase === 'VERIFY_LIVE_IDENTITY') {
      const result = await this.performPhase(request, preflight, phase, context)
      return { completed: true, ...result }
    }
    if (phase === 'CREATE_LOCAL_COMMIT') {
      const evidence = await this.createLocalCommitEvidence(
        request as FleetRuntimeRequest,
        context as FleetRuntimeLocalPhaseContext,
        true,
      )
      return { completed: true, evidence, protected_effect_count: 0 }
    }
    if (phase === 'PUSH_NORMAL_BRANCH') {
      const branch = String(context.current_intent.branch ?? '')
      const head = String(context.current_intent.head ?? '')
      if (!branch || !COMMIT.test(head)) return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', 'push intent is incomplete')
      const observed = (await this.run(['git', 'ls-remote', '--heads', 'https://github.com/watchout/kodama.git', `refs/heads/${branch}`])).trim()
      if (observed !== `${head}\trefs/heads/${branch}`) return { completed: false, evidence: null, protected_effect_count: 1 }
      return { completed: true, evidence: { branch, head, force: false }, protected_effect_count: 1 }
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
      return { completed: true, evidence: { pr_url: exact[0].url, branch, head, draft: true }, protected_effect_count: 1 }
    }
    if (phase === 'COLD_START_DISCORD_KODAMA') {
      const mutable = context as FleetRuntimeLocalPhaseContext
      const expectedHead = String(mutable.current_intent.expected_head ?? '')
      const expectedTree = String(mutable.current_intent.expected_tree ?? '')
      if (!COMMIT.test(expectedHead) || !COMMIT.test(expectedTree)) {
        return providerFail('INTERRUPTED_SUBEFFECT_UNRESOLVED', 'cold-start intent lacks exact checkout image')
      }
      const checkoutImage = await this.verifyCheckout(this.checkoutPath(mutable), mutable.state_directory, expectedHead, expectedTree)
      const observation = await this.queueObservation()
      const live = observation.runtime_inventory.latest_instance
      if (live?.session_name !== mutable.current_intent.session
        || live?.port !== mutable.current_intent.port
        || live?.checkout_path !== mutable.current_intent.checkout_path) {
        return { completed: false, evidence: null, protected_effect_count: 1 }
      }
      return {
        completed: true,
        evidence: {
          ...checkoutImage,
          session: mutable.current_intent.session,
          port: mutable.current_intent.port,
        },
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
    assertJournal(state as FleetRuntimeLocalOperationState, request, state.execution_owner_id, true)
    const predecessorBinding = parseFleetRuntimeOperationPredecessorBinding(request, preflight.owner_decision_raw_body)
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
        ? 'fleet-runtime-v1/rollback-receipt/v2'
        : request.operation === 'REAPPLY'
          ? 'fleet-runtime-v1/reapply-receipt/v2'
          : 'fleet-runtime-v1/effect-receipt/v2',
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
        queue_observation: clone(request.queue_observation),
        root_goal_readback: clone(preflight.root_goal_readbacks[0]),
      }],
      duplicate_effect_count: 0,
      unauthorized_effect_count: 0,
    }
    const boundReceipt = receipt as FleetRuntimeEffectReceipt & Record<string, unknown>
    const predecessorSelf = request.operation === 'CANARY_COLD_START'
      ? null
      : validateFleetRuntimePredecessorReceipt(
          request,
          preflight.predecessor_receipt_raw_body,
          predecessorBinding,
        ).receipt_sha256 as string
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
      const prepare = state.phases.PREPARE_CLEAN_CHECKOUT?.evidence
      if (prepare?.rollback_receipt_url !== predecessorBinding.companion_url
        || prepare?.rollback_receipt_raw_body_sha256 !== predecessorBinding.companion_raw_body_sha256
        || prepare?.rollback_receipt_self_sha256 !== predecessorBinding.companion_self_sha256) {
        return providerFail('READBACK_INVALID', 'reapply journal lacks the owner-bound rollback companion')
      }
      receipt.rollback_receipt_sha256 = String(predecessorBinding.companion_self_sha256)
      receipt.recovery_receipt_sha256 = request.predecessor_receipt.sha256
      receipt.target_repository = 'watchout/kodama'
      receipt.payload_digest = request.payload_digest
      receipt.postimage = clone(image)
      boundReceipt.rollback_receipt_raw_body_sha256 = predecessorBinding.companion_raw_body_sha256
      boundReceipt.rollback_receipt_url = predecessorBinding.companion_url
      boundReceipt.recovery_receipt_self_sha256 = predecessorBinding.predecessor_self_sha256
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
