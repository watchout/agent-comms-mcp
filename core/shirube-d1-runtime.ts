import { createHash } from 'node:crypto'
import type { DbAdapter } from './db'
import { detectQueueWorkHandoffContract } from './queue-work'
import type {
  QueueReplySender,
  QueueWorkGithubIssueCommentWriteback,
  QueueWorkRow,
  QueueWorkWritebackSender,
} from './queue-work'
import {
  claimD1Execution,
  invokeD1Execution,
  type D1AuthorizationEnvelope,
  type D1Effect,
  type D1ExecutionPorts,
  type D1ExecutionState,
} from './shirube-d1-execution-adapter'
import {
  createD1EffectPorts,
  enqueueD1ExternalEvent,
  type D1EffectPortOptions,
  type D1ExternalEvent,
} from './shirube-d1-effect-ports'
import { createD1PersistencePorts } from './shirube-d1-persistence'

export const SHIRUBE_D1_RUNTIME_BINDING_VERSION = 'shirube-v4/d1-runtime-binding/v1' as const

export interface ShirubeD1RuntimeTarget {
  repository: string
  agent_id: string
  control_source: string
}

export interface ShirubeD1ActivationEvidence {
  adapter_head_sha: string
  independent_audit_ref: string
  qa_ref: string
  check_ref: string
  cto_go_ref: string
}

export interface ShirubeD1RuntimeBinding {
  schema_version: typeof SHIRUBE_D1_RUNTIME_BINDING_VERSION
  target: ShirubeD1RuntimeTarget
  authorization: D1AuthorizationEnvelope
  activation_evidence: ShirubeD1ActivationEvidence
  allowed_effects: D1Effect[]
  external_event?: D1ExternalEvent | null
}

export interface ShirubeD1RuntimePolicy {
  enabled: boolean
  kill_switch: boolean
  allowlist: ShirubeD1RuntimeTarget[]
  authorization_digest: string | null
  adapter_head_sha: string | null
  gate_refs: Omit<ShirubeD1ActivationEvidence, 'adapter_head_sha'>
}

export interface ShirubeD1RuntimeReceipt {
  enabled: true
  queue_id: string
  claim_key: string
  authorization_digest: string
  target: ShirubeD1RuntimeTarget
  allowed_effects: D1Effect[]
}

export interface ShirubeD1RuntimeEffectReadback {
  enabled: boolean
  queue_id: string
  effect_delivery_performed: boolean
  durable_receipts: Array<{ invocation_key: string; effect: D1Effect; receipt: string }>
  duplicate_effects: 0
}

export class ShirubeD1RuntimeError extends Error {
  constructor(
    readonly code:
      | 'D1_POLICY_INVALID'
      | 'D1_KILL_SWITCH_ACTIVE'
      | 'D1_AUTHORIZATION_REQUIRED'
      | 'D1_TARGET_MISMATCH'
      | 'D1_ACTIVATION_EVIDENCE_MISMATCH'
      | 'D1_EFFECT_NOT_ALLOWED'
      | 'D1_EFFECT_SELECTION_AMBIGUOUS',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ShirubeD1RuntimeError'
  }
}

export interface ShirubeD1RuntimeControllerOptions extends D1EffectPortOptions {
  env?: NodeJS.ProcessEnv
}

export interface ShirubeD1FinalizationSenders {
  replySender?: QueueReplySender
  writebackSender?: QueueWorkWritebackSender
}

const cleanString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
)

function exactString(value: unknown, field: string): string {
  const cleaned = cleanString(value)
  if (!cleaned || cleaned !== value) throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', `${field} must be a trimmed nonempty string`)
  return cleaned
}

function exactFlag(value: string | undefined, name: string, fallback: '0' | '1'): '0' | '1' {
  const resolved = value ?? fallback
  if (resolved !== '0' && resolved !== '1') throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', `${name} must be 0 or 1`)
  return resolved
}

function githubRef(value: string | undefined, name: string, required: boolean): string {
  const ref = value?.trim() ?? ''
  if (required && !/^https:\/\/github\.com\/[^\s]+$/.test(ref)) {
    throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', `${name} must be a GitHub evidence URL`)
  }
  return ref
}

function parseAllowlist(raw: string | undefined): ShirubeD1RuntimeTarget[] {
  if (!raw?.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', 'SHIRUBE_D1_TARGET_ALLOWLIST must be valid JSON')
  }
  if (!Array.isArray(parsed)) throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', 'SHIRUBE_D1_TARGET_ALLOWLIST must be an array')
  const entries = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', `target_allowlist[${index}] must be an object`)
    }
    const row = entry as Record<string, unknown>
    return {
      repository: exactString(row.repository, `target_allowlist[${index}].repository`),
      agent_id: exactString(row.agent_id, `target_allowlist[${index}].agent_id`),
      control_source: exactString(row.control_source, `target_allowlist[${index}].control_source`),
    }
  })
  if (new Set(entries.map((entry) => JSON.stringify(entry))).size !== entries.length) {
    throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', 'target allowlist contains duplicate tuples')
  }
  return entries
}

export function buildShirubeD1RuntimePolicy(env: NodeJS.ProcessEnv = process.env): ShirubeD1RuntimePolicy {
  const enabled = exactFlag(env.SHIRUBE_D1_ENABLED, 'SHIRUBE_D1_ENABLED', '0') === '1'
  const killSwitch = exactFlag(env.SHIRUBE_D1_KILL_SWITCH, 'SHIRUBE_D1_KILL_SWITCH', '1') === '1'
  const allowlist = parseAllowlist(env.SHIRUBE_D1_TARGET_ALLOWLIST)
  const authorizationDigest = cleanString(env.SHIRUBE_D1_AUTHORIZATION_DIGEST)
  const adapterHeadSha = cleanString(env.SHIRUBE_D1_ADAPTER_HEAD_SHA)
  const gateRefs = {
    independent_audit_ref: githubRef(env.SHIRUBE_D1_AUDIT_REF, 'SHIRUBE_D1_AUDIT_REF', enabled),
    qa_ref: githubRef(env.SHIRUBE_D1_QA_REF, 'SHIRUBE_D1_QA_REF', enabled),
    check_ref: githubRef(env.SHIRUBE_D1_CHECK_REF, 'SHIRUBE_D1_CHECK_REF', enabled),
    cto_go_ref: githubRef(env.SHIRUBE_D1_CTO_GO_REF, 'SHIRUBE_D1_CTO_GO_REF', enabled),
  }
  if (enabled) {
    if (allowlist.length !== 1) throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', 'enabled canary requires exactly one target allowlist entry')
    if (!authorizationDigest || !/^[0-9a-f]{64}$/.test(authorizationDigest)) {
      throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', 'SHIRUBE_D1_AUTHORIZATION_DIGEST must be 64 lowercase hex')
    }
    if (!adapterHeadSha || !/^[0-9a-f]{40}$/.test(adapterHeadSha)) {
      throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', 'SHIRUBE_D1_ADAPTER_HEAD_SHA must be 40 lowercase hex')
    }
  }
  return {
    enabled,
    kill_switch: killSwitch,
    allowlist,
    authorization_digest: authorizationDigest,
    adapter_head_sha: adapterHeadSha,
    gate_refs: gateRefs,
  }
}

export function isShirubeD1AgentEnrolled(policy: ShirubeD1RuntimePolicy, agentId: string | null | undefined): boolean {
  return Boolean(policy.enabled && agentId && policy.allowlist.some((entry) => entry.agent_id === agentId))
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function bindingFromRow(row: QueueWorkRow): ShirubeD1RuntimeBinding | null {
  const candidate = parsePayload(row.payload).shirube_v4_d1
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const binding = candidate as ShirubeD1RuntimeBinding
  return binding.schema_version === SHIRUBE_D1_RUNTIME_BINDING_VERSION ? binding : null
}

function sameTarget(left: ShirubeD1RuntimeTarget, right: ShirubeD1RuntimeTarget): boolean {
  return left.repository === right.repository && left.agent_id === right.agent_id && left.control_source === right.control_source
}

function claimKey(binding: ShirubeD1RuntimeBinding, queueId: string): string {
  return `d1:claim:${binding.authorization.authorization_digest}:${queueId}`
}

export function computeShirubeD1InvocationKey(binding: ShirubeD1RuntimeBinding, queueId: string, effect: D1Effect): string {
  const canaryIssue = binding.target.control_source.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)$/)?.[1]
  if (effect === 'github_writeback' && canaryIssue) {
    const repositoryName = binding.target.repository.split('/')[1]
    if (!repositoryName) throw new ShirubeD1RuntimeError('D1_TARGET_MISMATCH', 'repository must be owner/name')
    return `d1-canary:${repositoryName}:${canaryIssue}:${binding.activation_evidence.adapter_head_sha}`
  }
  return `d1:invoke:${createHash('sha256').update(`${binding.authorization.authorization_digest}\n${queueId}\n${effect}`, 'utf8').digest('hex')}`
}

function rejectPerformers(): Record<D1Effect, (key: string) => Promise<string>> {
  const reject = async () => { throw new Error('D1_EFFECT_NOT_AVAILABLE') }
  return { internal_reply: reject, github_writeback: reject, external_send: reject }
}

export function createShirubeD1DatabasePorts(
  db: DbAdapter,
  authorization: D1AuthorizationEnvelope,
  performers: Record<D1Effect, (invocationKey: string) => Promise<string>>,
  options: D1EffectPortOptions = {},
): D1ExecutionPorts {
  return {
    ...createD1PersistencePorts(db, authorization, options.now),
    ...createD1EffectPorts(db, performers, options),
  }
}

type RunnerResult = {
  next_action?: unknown
  reply?: unknown
  writeback?: QueueWorkGithubIssueCommentWriteback | null
}

export class ShirubeD1RuntimeController {
  readonly policy: ShirubeD1RuntimePolicy
  private readonly now: () => Date

  constructor(private readonly db: DbAdapter, private readonly options: ShirubeD1RuntimeControllerOptions = {}) {
    this.policy = buildShirubeD1RuntimePolicy(options.env)
    this.now = options.now ?? (() => new Date())
  }

  allowsAgent(agentId: string | null | undefined): boolean {
    return isShirubeD1AgentEnrolled(this.policy, agentId) && !this.policy.kill_switch
  }

  isEnrolledAgent(agentId: string | null | undefined): boolean {
    return isShirubeD1AgentEnrolled(this.policy, agentId)
  }

  private async row(queueId: string): Promise<QueueWorkRow> {
    const row = await this.db.queryOne<QueueWorkRow>(
      `SELECT id, agent_id, message_id, payload, status, priority, created_at,
              claimed_by, claimed_at, claim_expires_at
         FROM message_queue WHERE id = $1`,
      [queueId],
    )
    if (!row) throw new ShirubeD1RuntimeError('D1_AUTHORIZATION_REQUIRED', `queue row not found: ${queueId}`)
    return row
  }

  private validateBinding(row: QueueWorkRow): ShirubeD1RuntimeBinding | null {
    if (!this.policy.enabled) return null
    const enrolled = this.policy.allowlist.find((entry) => entry.agent_id === row.agent_id) ?? null
    if (!enrolled) return null
    if (this.policy.kill_switch) throw new ShirubeD1RuntimeError('D1_KILL_SWITCH_ACTIVE', `D1 is stopped for ${row.agent_id}`)
    const binding = bindingFromRow(row)
    if (!binding) throw new ShirubeD1RuntimeError('D1_AUTHORIZATION_REQUIRED', 'enrolled D1 work requires a runtime binding')
    if (!binding.target || !sameTarget(binding.target, enrolled) || binding.authorization?.control_source !== enrolled.control_source) {
      throw new ShirubeD1RuntimeError('D1_TARGET_MISMATCH', 'runtime binding does not match the exact enrolled tuple')
    }
    if (binding.authorization.authorization_digest !== this.policy.authorization_digest) {
      throw new ShirubeD1RuntimeError('D1_AUTHORIZATION_REQUIRED', 'authorization digest differs from activated digest')
    }
    const expectedEvidence: ShirubeD1ActivationEvidence = {
      adapter_head_sha: this.policy.adapter_head_sha!,
      ...this.policy.gate_refs,
    }
    if (!binding.activation_evidence || JSON.stringify(binding.activation_evidence) !== JSON.stringify(expectedEvidence)) {
      throw new ShirubeD1RuntimeError('D1_ACTIVATION_EVIDENCE_MISMATCH', 'audit/QA/check/CTO/head evidence differs from activated evidence')
    }
    if (
      !Array.isArray(binding.allowed_effects)
      || binding.allowed_effects.length === 0
      || binding.allowed_effects.some((effect) => !['internal_reply', 'github_writeback', 'external_send'].includes(effect))
      || new Set(binding.allowed_effects).size !== binding.allowed_effects.length
    ) throw new ShirubeD1RuntimeError('D1_POLICY_INVALID', 'allowed_effects must be a unique nonempty closed-world list')
    return binding
  }

  async beforeClaim(row: QueueWorkRow): Promise<ShirubeD1RuntimeReceipt | null> {
    const binding = this.validateBinding(row)
    if (!binding) return null
    const queueId = String(row.id)
    const claimed = await claimD1Execution(
      binding.authorization,
      claimKey(binding, queueId),
      createShirubeD1DatabasePorts(this.db, binding.authorization, rejectPerformers(), { ...this.options, now: this.now }),
    )
    return {
      enabled: true,
      queue_id: queueId,
      claim_key: claimed.claim_key,
      authorization_digest: claimed.authorization_digest,
      target: binding.target,
      allowed_effects: binding.allowed_effects,
    }
  }

  async beforeInvocation(queueId: string): Promise<ShirubeD1RuntimeReceipt | null> {
    return this.beforeClaim(await this.row(queueId))
  }

  private async invoke(
    row: QueueWorkRow,
    binding: ShirubeD1RuntimeBinding,
    effect: D1Effect,
    performers: Record<D1Effect, (key: string) => Promise<string>>,
  ): Promise<D1ExecutionState> {
    const queueId = String(row.id)
    if (!binding.allowed_effects.includes(effect)) throw new ShirubeD1RuntimeError('D1_EFFECT_NOT_ALLOWED', `${effect} is not authorized`)
    const ports = createShirubeD1DatabasePorts(this.db, binding.authorization, performers, { ...this.options, now: this.now })
    const claimed = await claimD1Execution(binding.authorization, claimKey(binding, queueId), ports)
    return invokeD1Execution(binding.authorization, claimed, computeShirubeD1InvocationKey(binding, queueId, effect), effect, ports)
  }

  async prepareFinalizationSenders(
    queueId: string,
    senders: ShirubeD1FinalizationSenders,
  ): Promise<ShirubeD1FinalizationSenders> {
    const row = await this.row(queueId)
    const binding = this.validateBinding(row)
    if (!binding) return senders
    const payload = parsePayload(row.payload)
    const result = payload.runner_result as RunnerResult | undefined
    if (!result) throw new ShirubeD1RuntimeError('D1_EFFECT_SELECTION_AMBIGUOUS', 'runner result is missing')
    const handoff = detectQueueWorkHandoffContract({ agentId: row.agent_id, payload: row.payload })
    const candidates: D1Effect[] = []
    if (handoff.github_backed && result.writeback) candidates.push('github_writeback')
    if (result.next_action === 'reply' && cleanString(result.reply)) {
      candidates.push(binding.external_event ? 'external_send' : 'internal_reply')
    }
    if (candidates.length !== 1) {
      throw new ShirubeD1RuntimeError('D1_EFFECT_SELECTION_AMBIGUOUS', `expected one effect, selected ${candidates.length}`)
    }
    const effect = candidates[0]!
    const performers = rejectPerformers()
    if (effect === 'github_writeback') {
      if (!senders.writebackSender || !result.writeback) throw new ShirubeD1RuntimeError('D1_EFFECT_NOT_ALLOWED', 'GitHub sender is unavailable')
      performers.github_writeback = async (key) => {
        const body = `${result.writeback!.body.replace(/\s+$/u, '')}\nidempotency_key: ${key}`
        const sent = await senders.writebackSender!.sendWriteback({
          queue_id: String(row.id),
          agent_id: row.agent_id,
          message_id: row.message_id,
          handoff_contract: handoff,
          writeback: {
            ...result.writeback!,
            body,
            body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
            idempotency_key: key,
          },
          runtime_result_summary: {
            ok: true,
            summary: cleanString((result as Record<string, unknown>).summary) ?? 'D1 runtime result',
            next_action: 'close',
            evidence: Array.isArray((result as Record<string, unknown>).evidence)
              ? (result as Record<string, unknown>).evidence as string[] : [],
          },
        })
        const receipt = cleanString(sent.posted_with)
        if (!receipt) throw new Error('D1_GITHUB_WRITEBACK_RECEIPT_REQUIRED')
        return receipt
      }
    } else if (effect === 'internal_reply') {
      if (!senders.replySender) throw new ShirubeD1RuntimeError('D1_EFFECT_NOT_ALLOWED', 'internal reply sender is unavailable')
      performers.internal_reply = async (key) => {
        const sent = await senders.replySender!.sendReply({
          queue_id: String(row.id), agent_id: row.agent_id, message_id: row.message_id,
          content: String(result.reply), mention: cleanString(payload.author_id ?? payload.from),
          idempotency_key: key,
        })
        const receipt = cleanString(sent.message_id)
        if (!receipt) throw new Error('D1_INTERNAL_REPLY_RECEIPT_REQUIRED')
        return receipt
      }
    } else {
      if (!binding.external_event) throw new ShirubeD1RuntimeError('D1_EFFECT_NOT_ALLOWED', 'external EventLog projection is unavailable')
      if (binding.external_event.payload.content.text !== String(result.reply)) {
        throw new ShirubeD1RuntimeError('D1_EFFECT_NOT_ALLOWED', 'external DeliveryUnit content differs from the admitted runtime reply')
      }
      performers.external_send = (key) => enqueueD1ExternalEvent(this.db, key, binding.external_event!)
    }

    const completed = await this.invoke(row, binding, effect, performers)
    if (effect === 'github_writeback') {
      return {
        replySender: senders.replySender,
        writebackSender: {
          async sendWriteback(input) {
            return { posted_with: completed.github_writeback_receipt, body_sha256: input.writeback.body_sha256 ?? null }
          },
        },
      }
    }
    const replyReceipt = effect === 'internal_reply' ? completed.internal_reply_receipt : completed.external_send_receipt
    return {
      writebackSender: senders.writebackSender,
      replySender: { async sendReply() { return { message_id: replyReceipt } } },
    }
  }

  async effectReadback(queueId: string): Promise<ShirubeD1RuntimeEffectReadback> {
    const row = await this.row(queueId)
    const binding = bindingFromRow(row)
    if (!binding) return { enabled: false, queue_id: queueId, effect_delivery_performed: false, durable_receipts: [], duplicate_effects: 0 }
    const receipts = await this.db.query<{ invocation_key: string; effect: D1Effect; receipt: string }>(
      `SELECT d.invocation_key, d.effect, d.receipt
         FROM shirube_d1_effect_deliveries d
         JOIN shirube_d1_invocations i ON i.invocation_key = d.invocation_key
        WHERE i.claim_key = $1 AND d.status = 'completed'
        ORDER BY d.effect, d.invocation_key`,
      [claimKey(binding, queueId)],
    )
    return {
      enabled: this.allowsAgent(row.agent_id),
      queue_id: queueId,
      effect_delivery_performed: receipts.length > 0,
      durable_receipts: receipts,
      duplicate_effects: 0,
    }
  }
}
