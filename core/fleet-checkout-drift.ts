import { resolve } from 'node:path'

export type FleetCheckoutDriftReason =
  | 'runtime_commit_missing'
  | 'runtime_commit_mismatch'
  | 'runtime_checkout_path_missing'
  | 'runtime_checkout_path_unapproved'
  | 'runtime_dirty_checkout'

export type FleetCheckoutDriftPolicy = {
  approvedCommit?: string | null
  approvedCheckoutRoots?: string[] | null
  allowDirtyCheckout?: boolean
}

export type FleetCheckoutRuntimeEvidence = {
  runtime_instance_id?: string | null
  checkout_path?: string | null
  commit_sha?: string | null
  metadata?: unknown
}

export type FleetCheckoutDriftResult = {
  approved_commit: string | null
  approved_checkout_roots: string[]
  runtime_instance_id: string | null
  checkout_path: string | null
  commit_sha: string | null
  dirty: boolean | null
  ok: boolean
  reasons: FleetCheckoutDriftReason[]
}

function cleanText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  return value ? value : null
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
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

function boolish(raw: unknown): boolean | null {
  if (raw === true || raw === 1) return true
  if (raw === false || raw === 0) return false
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (['true', 'yes', '1', 'dirty'].includes(value)) return true
  if (['false', 'no', '0', 'clean'].includes(value)) return false
  return null
}

function dirtyFromMetadata(metadata: unknown): boolean | null {
  const parsed = parseJsonObject(metadata)
  for (const key of ['git_dirty', 'working_tree_dirty', 'checkout_dirty', 'dirty']) {
    const value = boolish(parsed[key])
    if (value !== null) return value
  }
  const git = parseJsonObject(parsed.git)
  for (const key of ['dirty', 'working_tree_dirty', 'checkout_dirty']) {
    const value = boolish(git[key])
    if (value !== null) return value
  }
  const status = cleanText(parsed.git_status_short ?? git.status_short ?? git.status)
  if (status !== null) return status.length > 0 && status !== 'clean'
  return null
}

function metadataText(metadata: unknown, keys: string[]): string | null {
  const parsed = parseJsonObject(metadata)
  const git = parseJsonObject(parsed.git)
  for (const key of keys) {
    const value = cleanText(parsed[key] ?? git[key])
    if (value) return value
  }
  return null
}

export function normalizeApprovedCheckoutRoots(roots: string[] | null | undefined): string[] {
  return [...new Set((roots ?? []).map((root) => cleanText(root)).filter((root): root is string => root !== null).map((root) => resolve(root)))]
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

export function fullGitShaEquals(actual: string | null | undefined, expected: string | null | undefined): boolean {
  const normalizedActual = cleanText(actual)
  const normalizedExpected = cleanText(expected)
  return normalizedActual !== null
    && normalizedExpected !== null
    && /^[0-9a-f]{40}$/i.test(normalizedActual)
    && /^[0-9a-f]{40}$/i.test(normalizedExpected)
    && normalizedActual.toLowerCase() === normalizedExpected.toLowerCase()
}

function commitMatches(commit: string, approvedCommit: string): boolean {
  return fullGitShaEquals(commit, approvedCommit)
}

export function evaluateFleetCheckoutDrift(
  runtime: FleetCheckoutRuntimeEvidence | null,
  policy: FleetCheckoutDriftPolicy = {},
): FleetCheckoutDriftResult {
  const approvedCommit = cleanText(policy.approvedCommit)
  const approvedCheckoutRoots = normalizeApprovedCheckoutRoots(policy.approvedCheckoutRoots)
  const runtimeInstanceId = cleanText(runtime?.runtime_instance_id)
  const checkoutPath = cleanText(runtime?.checkout_path) ?? metadataText(runtime?.metadata, ['git_checkout_path', 'checkout_path'])
  const commitSha = cleanText(runtime?.commit_sha) ?? metadataText(runtime?.metadata, ['git_commit_sha', 'commit_sha'])
  const dirty = dirtyFromMetadata(runtime?.metadata)
  const reasons: FleetCheckoutDriftReason[] = []

  if (approvedCommit) {
    if (!commitSha) reasons.push('runtime_commit_missing')
    else if (!commitMatches(commitSha, approvedCommit)) reasons.push('runtime_commit_mismatch')
  }
  if (!checkoutPath) {
    reasons.push('runtime_checkout_path_missing')
  } else if (approvedCheckoutRoots.length > 0 && !approvedCheckoutRoots.some((root) => isInside(root, checkoutPath))) {
    reasons.push('runtime_checkout_path_unapproved')
  }
  if (dirty === true && !policy.allowDirtyCheckout) {
    reasons.push('runtime_dirty_checkout')
  }

  return {
    approved_commit: approvedCommit,
    approved_checkout_roots: approvedCheckoutRoots,
    runtime_instance_id: runtimeInstanceId,
    checkout_path: checkoutPath,
    commit_sha: commitSha,
    dirty,
    ok: reasons.length === 0,
    reasons,
  }
}
