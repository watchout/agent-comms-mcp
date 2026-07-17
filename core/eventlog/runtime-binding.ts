import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

export type RuntimeBindingErrorCode =
  | 'RUNTIME_BINDING_INVALID'
  | 'RUNTIME_BINDING_DRIFT'
  | 'RUNTIME_ENGINE_UNADMITTED'
  | 'RUNTIME_POLICY_UNVERIFIED'

export interface ResolvedRuntimeBindingV1 {
  agent_id: string
  runtime_instance_id: string
  workspace_realpath: string
  active_function: string
  memory_project: string
  model_adapter: 'codex' | 'claude_code'
  sandbox_profile: string
  allowed_tools: string[]
  allowed_env_keys: string[]
  policy_digest: string
  authority_snapshot_digest: string
  build_sha: string
  tree_hash: string
  config_digest: string
}

export interface RuntimeBindingCurrentSnapshotV1 extends ResolvedRuntimeBindingV1 {
  checkout_dirty?: boolean
}

export interface RuntimeBindingResolutionInputV1 {
  binding: unknown
  current?: RuntimeBindingCurrentSnapshotV1
}

export class RuntimeBindingResolutionError extends Error {
  constructor(
    readonly code: RuntimeBindingErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

const BINDING_KEYS = [
  'active_function',
  'agent_id',
  'allowed_env_keys',
  'allowed_tools',
  'authority_snapshot_digest',
  'build_sha',
  'config_digest',
  'memory_project',
  'model_adapter',
  'policy_digest',
  'runtime_instance_id',
  'sandbox_profile',
  'tree_hash',
  'workspace_realpath',
] as const

function invalid(message: string): never {
  throw new RuntimeBindingResolutionError('RUNTIME_BINDING_INVALID', message)
}

function exactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return invalid(`${field} must be a trimmed nonempty string`)
  }
  return value
}

function exactHash(value: unknown, field: string, length: 40 | 64): string {
  const text = exactString(value, field)
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(text)) {
    return invalid(`${field} must be a lowercase ${length}-hex digest`)
  }
  return text
}

function exactAllowlist(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) return invalid(`${field} must be a nonempty array`)
  const entries = value.map((entry, index) => exactString(entry, `${field}[${index}]`))
  const canonical = [...new Set(entries)].sort()
  if (canonical.length !== entries.length || canonical.some((entry, index) => entry !== entries[index])) {
    return invalid(`${field} must be sorted and unique`)
  }
  return entries
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

export function resolvedRuntimeBindingDigest(binding: ResolvedRuntimeBindingV1): string {
  return createHash('sha256').update(canonicalJson(binding), 'utf8').digest('hex')
}

export function assertRuntimeBindingCurrent(
  binding: ResolvedRuntimeBindingV1,
  current: RuntimeBindingCurrentSnapshotV1,
): void {
  const currentKeys = Object.keys(current).sort()
  const admittedCurrentKeys = [...BINDING_KEYS, 'checkout_dirty'].sort()
  if (currentKeys.some(key => !admittedCurrentKeys.includes(key as typeof admittedCurrentKeys[number]))) {
    throw new RuntimeBindingResolutionError('RUNTIME_BINDING_DRIFT', 'current binding snapshot has unknown fields')
  }
  if (current.checkout_dirty === true) {
    throw new RuntimeBindingResolutionError('RUNTIME_BINDING_DRIFT', 'checkout is dirty')
  }
  for (const key of BINDING_KEYS) {
    const expected = binding[key]
    const observed = current[key]
    if (Array.isArray(expected)) {
      if (!Array.isArray(observed) || expected.length !== observed.length || expected.some((item, index) => item !== observed[index])) {
        throw new RuntimeBindingResolutionError('RUNTIME_BINDING_DRIFT', `${key} differs`)
      }
    } else if (expected !== observed) {
      const code: RuntimeBindingErrorCode = key === 'policy_digest'
        ? 'RUNTIME_POLICY_UNVERIFIED'
        : 'RUNTIME_BINDING_DRIFT'
      throw new RuntimeBindingResolutionError(code, `${key} differs`)
    }
  }
}

export function resolveRuntimeBinding(input: RuntimeBindingResolutionInputV1): ResolvedRuntimeBindingV1 {
  if (!input.binding || typeof input.binding !== 'object' || Array.isArray(input.binding)) {
    return invalid('binding must be an object')
  }
  const source = input.binding as Record<string, unknown>
  const keys = Object.keys(source).sort()
  if (keys.length !== BINDING_KEYS.length || keys.some((key, index) => key !== BINDING_KEYS[index])) {
    return invalid('binding keys differ from ResolvedRuntimeBindingV1')
  }

  const workspace = exactString(source.workspace_realpath, 'workspace_realpath')
  if (!isAbsolute(workspace) || normalize(workspace) !== workspace) {
    return invalid('workspace_realpath must be an absolute normalized realpath')
  }
  const modelAdapter = exactString(source.model_adapter, 'model_adapter')
  if (modelAdapter !== 'codex' && modelAdapter !== 'claude_code') {
    throw new RuntimeBindingResolutionError('RUNTIME_ENGINE_UNADMITTED', `model_adapter ${modelAdapter} is not admitted`)
  }

  const binding: ResolvedRuntimeBindingV1 = {
    agent_id: exactString(source.agent_id, 'agent_id'),
    runtime_instance_id: exactString(source.runtime_instance_id, 'runtime_instance_id'),
    workspace_realpath: workspace,
    active_function: exactString(source.active_function, 'active_function'),
    memory_project: exactString(source.memory_project, 'memory_project'),
    model_adapter: modelAdapter,
    sandbox_profile: exactString(source.sandbox_profile, 'sandbox_profile'),
    allowed_tools: exactAllowlist(source.allowed_tools, 'allowed_tools'),
    allowed_env_keys: exactAllowlist(source.allowed_env_keys, 'allowed_env_keys'),
    policy_digest: exactHash(source.policy_digest, 'policy_digest', 64),
    authority_snapshot_digest: exactHash(source.authority_snapshot_digest, 'authority_snapshot_digest', 64),
    build_sha: exactHash(source.build_sha, 'build_sha', 40),
    tree_hash: exactHash(source.tree_hash, 'tree_hash', 40),
    config_digest: exactHash(source.config_digest, 'config_digest', 64),
  }
  if (input.current) assertRuntimeBindingCurrent(binding, input.current)
  return binding
}
