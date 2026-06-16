import { readFileSync } from 'node:fs'

export const QUEUE_WORK_RESIDUE_POLICY_VERSION = 'queue_work_residue_policy_v1' as const

export type QueueWorkResidueClassification =
  | 'preserve_immutable_evidence'
  | 'preserve_failed_scheduler_evidence'
  | 'preserve_incomplete_scheduler_evidence'

export type QueueWorkResidueSchedulerAction = 'exclude'
export type QueueWorkResidueAuthorizedAction = 'preserve_only'

export interface QueueWorkResiduePolicyEntry {
  queue_id: number
  agent_id: string
  message_id: string | null
  classification: QueueWorkResidueClassification
  scheduler_action: QueueWorkResidueSchedulerAction
  authorized_action: QueueWorkResidueAuthorizedAction
  evidence_ref: string
  expected_status?: string[]
  expected_payload_source?: string | null
  expected_receive_claim_source?: string | null
  expected_runner_invocation_source?: string | null
  expected_runner_error_code?: string | null
  notes?: string
}

export interface QueueWorkResiduePolicy {
  schema_version: typeof QUEUE_WORK_RESIDUE_POLICY_VERSION
  issue: string
  entries: QueueWorkResiduePolicyEntry[]
}

export interface QueueWorkResidueRow {
  id: number | string
  agent_id: string
  message_id: string | null
  status: string
  payload?: string | null
  created_at?: string | Date | null
  claimed_by?: string | null
  claimed_at?: string | Date | null
  claim_expires_at?: string | Date | null
}

export type QueueWorkResiduePolicyBlockerCode =
  | 'queue_work_residue_policy_mismatch'
  | 'queue_work_unclassified_nonterminal_residue'
  | 'queue_work_residue_policy_entry_missing'

export interface QueueWorkResiduePolicyBlocker {
  code: QueueWorkResiduePolicyBlockerCode
  queue_id: number
  message: string
  mismatches?: string[]
}

export interface QueueWorkResiduePolicyClassification {
  queue_id: number
  agent_id: string
  message_id: string | null
  status: string | null
  classification: QueueWorkResidueClassification
  scheduler_action: QueueWorkResidueSchedulerAction
  authorized_action: QueueWorkResidueAuthorizedAction
  evidence_ref: string
  matched: boolean
  mismatches: string[]
}

export interface QueueWorkResiduePolicyReport {
  ok: boolean
  schema_version: typeof QUEUE_WORK_RESIDUE_POLICY_VERSION
  issue: string
  classifications: QueueWorkResiduePolicyClassification[]
  blockers: QueueWorkResiduePolicyBlocker[]
  policy_entry_count: number
  row_count: number
}

export class QueueWorkResiduePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'QueueWorkResiduePolicyError'
  }
}

const CLASSIFICATIONS = new Set<QueueWorkResidueClassification>([
  'preserve_immutable_evidence',
  'preserve_failed_scheduler_evidence',
  'preserve_incomplete_scheduler_evidence',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid', `${field} must be a non-empty string`)
  }
  return value
}

function optionalStringOrNull(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string') return value
  throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid', `${field} must be a string or null`)
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid', `${field} must be a non-empty string array`)
  }
  return value
}

function parseEntry(raw: unknown, index: number): QueueWorkResiduePolicyEntry {
  if (!isRecord(raw)) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid', `entries[${index}] must be an object`)
  }

  const queueId = raw.queue_id
  if (!Number.isInteger(queueId) || Number(queueId) <= 0) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid', `entries[${index}].queue_id must be a positive integer`)
  }

  const classification = requireString(raw.classification, `entries[${index}].classification`) as QueueWorkResidueClassification
  if (!CLASSIFICATIONS.has(classification)) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid_classification', `unsupported residue classification: ${classification}`)
  }

  const schedulerAction = requireString(raw.scheduler_action, `entries[${index}].scheduler_action`) as QueueWorkResidueSchedulerAction
  if (schedulerAction !== 'exclude') {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid_action', `unsupported scheduler_action: ${schedulerAction}`)
  }

  const authorizedAction = requireString(raw.authorized_action, `entries[${index}].authorized_action`) as QueueWorkResidueAuthorizedAction
  if (authorizedAction !== 'preserve_only') {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid_action', `unsupported authorized_action: ${authorizedAction}`)
  }

  const messageId = raw.message_id
  if (messageId !== null && typeof messageId !== 'string') {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid', `entries[${index}].message_id must be a string or null`)
  }

  return {
    queue_id: queueId,
    agent_id: requireString(raw.agent_id, `entries[${index}].agent_id`),
    message_id: messageId,
    classification,
    scheduler_action: schedulerAction,
    authorized_action: authorizedAction,
    evidence_ref: requireString(raw.evidence_ref, `entries[${index}].evidence_ref`),
    expected_status: optionalStringArray(raw.expected_status, `entries[${index}].expected_status`),
    expected_payload_source: optionalStringOrNull(raw.expected_payload_source, `entries[${index}].expected_payload_source`),
    expected_receive_claim_source: optionalStringOrNull(raw.expected_receive_claim_source, `entries[${index}].expected_receive_claim_source`),
    expected_runner_invocation_source: optionalStringOrNull(raw.expected_runner_invocation_source, `entries[${index}].expected_runner_invocation_source`),
    expected_runner_error_code: optionalStringOrNull(raw.expected_runner_error_code, `entries[${index}].expected_runner_error_code`),
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
  }
}

export function parseQueueWorkResiduePolicy(raw: unknown): QueueWorkResiduePolicy {
  if (!isRecord(raw)) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid', 'policy must be an object')
  }
  if (raw.schema_version !== QUEUE_WORK_RESIDUE_POLICY_VERSION) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid_version', `schema_version must be ${QUEUE_WORK_RESIDUE_POLICY_VERSION}`)
  }
  if (!Array.isArray(raw.entries)) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_policy_invalid', 'entries must be an array')
  }

  const entries = raw.entries.map(parseEntry)
  const seen = new Set<number>()
  for (const entry of entries) {
    if (seen.has(entry.queue_id)) {
      throw new QueueWorkResiduePolicyError('queue_work_residue_policy_duplicate_entry', `duplicate residue policy entry for queue_id=${entry.queue_id}`)
    }
    seen.add(entry.queue_id)
  }

  return {
    schema_version: QUEUE_WORK_RESIDUE_POLICY_VERSION,
    issue: requireString(raw.issue, 'issue'),
    entries,
  }
}

export function loadQueueWorkResiduePolicyFile(path: string): QueueWorkResiduePolicy {
  return parseQueueWorkResiduePolicy(JSON.parse(readFileSync(path, 'utf8')))
}

export function parseQueueWorkResiduePayload(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function asQueueId(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new QueueWorkResiduePolicyError('queue_work_residue_row_invalid', `invalid queue row id: ${String(value)}`)
  }
  return parsed
}

function compareField(mismatches: string[], field: string, expected: string | null | undefined, actual: string | null): void {
  if (expected === undefined) return
  if (actual !== expected) {
    mismatches.push(`${field} expected ${expected === null ? 'null' : expected}, got ${actual === null ? 'null' : actual}`)
  }
}

export function matchQueueWorkResiduePolicyEntry(
  entry: QueueWorkResiduePolicyEntry,
  row: QueueWorkResidueRow,
): QueueWorkResiduePolicyClassification {
  const queueId = asQueueId(row.id)
  const payload = parseQueueWorkResiduePayload(row.payload)
  const receiveClaim = isRecord(payload.receive_claim) ? payload.receive_claim : {}
  const runnerResult = isRecord(payload.runner_result) ? payload.runner_result : {}
  const runnerError = isRecord(payload.runner_error) ? payload.runner_error : {}
  const runnerInvocation = typeof runnerResult.invocation_source === 'string'
    ? runnerResult.invocation_source
    : typeof runnerError.invocation_source === 'string'
      ? runnerError.invocation_source
      : null
  const mismatches: string[] = []

  if (queueId !== entry.queue_id) mismatches.push(`queue_id expected ${entry.queue_id}, got ${queueId}`)
  if (row.agent_id !== entry.agent_id) mismatches.push(`agent_id expected ${entry.agent_id}, got ${row.agent_id}`)
  if ((row.message_id ?? null) !== entry.message_id) {
    mismatches.push(`message_id expected ${entry.message_id ?? 'null'}, got ${row.message_id ?? 'null'}`)
  }
  if (entry.expected_status && !entry.expected_status.includes(row.status)) {
    mismatches.push(`status expected one of ${entry.expected_status.join(',')}, got ${row.status}`)
  }
  compareField(mismatches, 'payload.source', entry.expected_payload_source, typeof payload.source === 'string' ? payload.source : null)
  compareField(
    mismatches,
    'receive_claim.source',
    entry.expected_receive_claim_source,
    typeof receiveClaim.source === 'string' ? receiveClaim.source : null,
  )
  compareField(mismatches, 'runner invocation_source', entry.expected_runner_invocation_source, runnerInvocation)
  compareField(
    mismatches,
    'runner_error.code',
    entry.expected_runner_error_code,
    typeof runnerError.code === 'string' ? runnerError.code : null,
  )

  return {
    queue_id: entry.queue_id,
    agent_id: row.agent_id,
    message_id: row.message_id ?? null,
    status: row.status,
    classification: entry.classification,
    scheduler_action: entry.scheduler_action,
    authorized_action: entry.authorized_action,
    evidence_ref: entry.evidence_ref,
    matched: mismatches.length === 0,
    mismatches,
  }
}

export function classifyQueueWorkResidueRows(
  policy: QueueWorkResiduePolicy,
  rows: QueueWorkResidueRow[],
  options: { requirePolicyRows?: boolean } = {},
): QueueWorkResiduePolicyReport {
  const entriesById = new Map(policy.entries.map((entry) => [entry.queue_id, entry]))
  const rowsById = new Map(rows.map((row) => [asQueueId(row.id), row]))
  const classifications: QueueWorkResiduePolicyClassification[] = []
  const blockers: QueueWorkResiduePolicyBlocker[] = []

  for (const row of rows) {
    const queueId = asQueueId(row.id)
    const entry = entriesById.get(queueId)
    if (!entry) {
      blockers.push({
        code: 'queue_work_unclassified_nonterminal_residue',
        queue_id: queueId,
        message: `non-terminal queue row ${queueId} has no governed residue policy entry`,
      })
      continue
    }
    const classification = matchQueueWorkResiduePolicyEntry(entry, row)
    classifications.push(classification)
    if (!classification.matched) {
      blockers.push({
        code: 'queue_work_residue_policy_mismatch',
        queue_id: queueId,
        message: `queue row ${queueId} does not match its governed residue policy entry`,
        mismatches: classification.mismatches,
      })
    }
  }

  if (options.requirePolicyRows) {
    for (const entry of policy.entries) {
      if (!rowsById.has(entry.queue_id)) {
        blockers.push({
          code: 'queue_work_residue_policy_entry_missing',
          queue_id: entry.queue_id,
          message: `governed residue policy entry ${entry.queue_id} was not found in the inspected row set`,
        })
      }
    }
  }

  return {
    ok: blockers.length === 0,
    schema_version: QUEUE_WORK_RESIDUE_POLICY_VERSION,
    issue: policy.issue,
    classifications,
    blockers,
    policy_entry_count: policy.entries.length,
    row_count: rows.length,
  }
}

export function queueWorkResidueExcludedQueueIds(policy: QueueWorkResiduePolicy): number[] {
  return policy.entries
    .filter((entry) => entry.scheduler_action === 'exclude')
    .map((entry) => entry.queue_id)
    .sort((a, b) => a - b)
}
