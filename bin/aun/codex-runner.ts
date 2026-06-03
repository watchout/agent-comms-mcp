/**
 * First Codex auto-receive runner split (#422).
 *
 * This is intentionally a thin DB-primary tick:
 * - claim actionable work through the bounded `aun receive-actionable` path
 * - retain queue/message identity in structured JSON
 * - optionally emit ACK/progress through `reply --no-close`
 * - optionally terminalize exact targeted no-reply work when explicitly requested
 * - leave normal final completion to `reply --close --queue-id --message-id`
 */
import {
  buildCommandPlan,
  parseDrainLimit,
  parseMaxInspect,
  runCommandPlan,
  type ClaimedMessage,
  type ReceiveOptions,
} from './receive'
import { reply } from './reply'

export interface CodexRunnerOptions extends ReceiveOptions {
  limit?: number
  maxInspect?: number
  queueId?: string
  ackMentions?: string
  ackContent?: string
  completeNoReply?: boolean
  completionReason?: string
}

export interface RetainedWorkItem {
  queue_id: string
  message_id: string
  channel_id: string | null
  thread_id: string | null
  from: string | null
  message_type: string | null
  routing_decision?: string
  route_reason?: string
  content: string
}

export interface AckResult {
  queue_id: string
  message_id: string
  ok: boolean
  code: number
  stdout?: unknown
  stderr?: string
}

export interface CompletionResult {
  outcome: 'none' | 'open' | 'completed_no_reply' | 'completion_failed'
  terminal_queue_ids: string[]
  applied_count: number
  reason?: string
  command?: {
    mode: 'record-no-reply'
    queue_id: string
  }
  result?: unknown
  stderr?: string
}

export interface CodexRunnerResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

function text(value: string | number | null | undefined): string {
  return value === undefined || value === null ? '' : String(value)
}

function retainClaim(claim: ClaimedMessage): RetainedWorkItem | null {
  const queueId = text(claim.queue_id).trim()
  const messageId = text(claim.message_id).trim()
  if (!queueId || !messageId) return null
  return {
    queue_id: queueId,
    message_id: messageId,
    channel_id: claim.channel_id ?? null,
    thread_id: claim.thread_id ?? null,
    from: claim.from ?? null,
    message_type: claim.message_type ?? null,
    ...(claim.routing ? {
      routing_decision: claim.routing.routing_decision,
      route_reason: claim.routing.route_reason,
    } : {}),
    content: claim.content ?? '',
  }
}

function parseJsonOrText(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return stdout
  }
}

function wantsAck(opts: CodexRunnerOptions): boolean {
  return !!opts.ackMentions?.trim() || !!opts.ackContent?.trim()
}

function validateAckOptions(opts: CodexRunnerOptions): string | null {
  if (!wantsAck(opts)) return null
  if (!opts.ackMentions?.trim()) return '--ack-mentions is required when ACK is enabled'
  if (!opts.ackContent?.trim()) return '--ack-content is required when ACK is enabled'
  return null
}

function validateCompletionOptions(opts: CodexRunnerOptions): string | null {
  if (!opts.completeNoReply) return null
  if (!opts.queueId?.trim()) return '--complete-no-reply requires --queue-id'
  return null
}

export function renderAckContent(template: string, item: RetainedWorkItem): string {
  const values: Record<string, string> = {
    queue_id: item.queue_id,
    message_id: item.message_id,
    channel_id: item.channel_id ?? '',
    thread_id: item.thread_id ?? '',
    from: item.from ?? '',
    message_type: item.message_type ?? '',
  }
  let rendered = template
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.split(`{${key}}`).join(value)
  }
  return rendered
}

function completionOpen(retained: RetainedWorkItem[]): CompletionResult {
  return retained.length > 0
    ? {
        outcome: 'open',
        terminal_queue_ids: [],
        applied_count: 0,
      }
    : {
        outcome: 'none',
        terminal_queue_ids: [],
        applied_count: 0,
      }
}

function recordNoReplyByQueueId(queueId: string, opts: CodexRunnerOptions): CompletionResult {
  const argv = [
    resolveNestedBunExecutable(),
    'bin/aun.ts',
    'record-no-reply',
    '--queue-id',
    queueId,
  ]
  const reason = opts.completionReason?.trim() || 'codex_runner_complete_no_reply'
  if (reason) {
    argv.push('--reason', reason)
  }
  const plan = buildCommandPlan(opts, argv)
  const result = runCommandPlan(plan)
  if (!result.ok) {
    return {
      outcome: 'completion_failed',
      terminal_queue_ids: [],
      applied_count: 0,
      reason,
      command: {
        mode: 'record-no-reply',
        queue_id: queueId,
      },
      stderr: result.stderr || `exit ${result.code}`,
      result: result.stdout ? parseJsonOrText(result.stdout) : undefined,
    }
  }
  return {
    outcome: 'completed_no_reply',
    terminal_queue_ids: [queueId],
    applied_count: 1,
    reason,
    command: {
      mode: 'record-no-reply',
      queue_id: queueId,
    },
    result: result.stdout ? parseJsonOrText(result.stdout) : undefined,
  }
}

function recordNoReply(item: RetainedWorkItem, opts: CodexRunnerOptions): CompletionResult {
  return recordNoReplyByQueueId(item.queue_id, opts)
}

function activeClaimQueueId(stdout: string | undefined): string | null {
  if (!stdout) return null
  try {
    const parsed = JSON.parse(stdout) as { blocked_reason?: unknown; active_claim?: { queue_id?: unknown; busy?: unknown } }
    if (parsed.blocked_reason !== 'active_claim') return null
    if (parsed.active_claim?.busy !== true) return null
    const queueId = parsed.active_claim.queue_id
    return typeof queueId === 'string' || typeof queueId === 'number' ? String(queueId) : null
  } catch {
    return null
  }
}

export function resolveNestedBunExecutable(): string {
  return process.env.AUN_BUN_EXECUTABLE?.trim()
    || process.env.STATE_DAEMON_BUN_EXECUTABLE?.trim()
    || process.execPath
}

function receiveOneActionable(opts: CodexRunnerOptions, maxInspect: number) {
  const argv = [
    resolveNestedBunExecutable(),
    'bin/aun.ts',
    'receive-actionable',
    '--max-inspect',
    String(maxInspect),
  ]
  if (opts.queueId?.trim()) {
    argv.push('--queue-id', opts.queueId.trim())
  }
  const plan = buildCommandPlan(opts, argv)
  if (opts.dryRun) {
    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        dry_run: true,
        mode: 'codex-runner',
        receive_mode: 'receive-actionable',
        cwd: plan.repoRoot,
        argv: plan.argv,
        agent_id: plan.env.AGENT_ID,
        expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
        database_url_candidates: plan.databaseUrlCandidates,
      }) + '\n',
      stderr: '',
      plan,
      claimed: null as ClaimedMessage | null,
    }
  }

  const result = runCommandPlan(plan)
  if (!result.ok) return { ...result, plan, claimed: null as ClaimedMessage | null }
  let body: ClaimedMessage
  try {
    body = JSON.parse(result.stdout) as ClaimedMessage
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `Error [CODEX_RUNNER_PARSE_FAILED]: failed to parse receive-actionable JSON: ${(err as Error).message}\n`,
      plan,
      claimed: null as ClaimedMessage | null,
    }
  }
  return {
    ...result,
    plan,
    claimed: body.queue_id === undefined ? null : body,
  }
}

export function codexRunnerTick(opts: CodexRunnerOptions = {}): CodexRunnerResult {
  let limit: number
  let maxInspect: number
  try {
    if (opts.queueId?.trim() && opts.limit !== undefined && opts.limit !== 1) {
      throw new Error('--queue-id requires --limit 1')
    }
    limit = opts.queueId?.trim() ? 1 : parseDrainLimit(opts.limit)
    maxInspect = parseMaxInspect(opts.maxInspect)
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [CODEX_RUNNER_INVALID_LIMIT]: ${(err as Error).message}\n`,
    }
  }

  const ackError = validateAckOptions(opts)
  if (ackError) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [CODEX_RUNNER_ACK_INVALID]: ${ackError}\n`,
    }
  }
  const completionError = validateCompletionOptions(opts)
  if (completionError) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [CODEX_RUNNER_COMPLETION_INVALID]: ${completionError}\n`,
    }
  }

  let firstPlanAgentId: string | null = null
  let firstPlanExpectedAgentId: string | null = null
  let waiting = 0
  let capped = false
  const retained: RetainedWorkItem[] = []
  try {
    for (let i = 0; i < limit; i++) {
      const received = receiveOneActionable(opts, maxInspect)
      firstPlanAgentId = firstPlanAgentId ?? received.plan.env.AGENT_ID
      firstPlanExpectedAgentId = firstPlanExpectedAgentId ?? received.plan.env.AGENT_COM_EXPECTED_AGENT_ID
      if (!received.ok) {
        const targetQueueId = opts.queueId?.trim()
        const sameOwnerActiveClaimQueueId = activeClaimQueueId(received.stdout)
        if (opts.completeNoReply && targetQueueId && sameOwnerActiveClaimQueueId === targetQueueId) {
          const completion = recordNoReplyByQueueId(targetQueueId, opts)
          if (completion.outcome === 'completed_no_reply') {
            return {
              ok: true,
              code: 0,
              stdout: JSON.stringify({
                ok: true,
                agent_id: firstPlanAgentId,
                expected_agent_id: firstPlanExpectedAgentId,
                receive_mode: 'receive-actionable',
                retained,
                retained_count: retained.length,
                acked_count: 0,
                acks: [],
                completion,
                receive_error: {
                  code: received.code,
                  stderr: received.stderr || undefined,
                },
                waiting,
                limit,
                max_inspect: maxInspect,
                capped,
                final_close_contract: 'completed by aun record-no-reply --queue-id <id>',
              }) + '\n',
              stderr: '',
            }
          }
        }
        return {
          ok: false,
          code: received.code,
          stdout: JSON.stringify({ ok: false, retained, waiting }) + '\n',
          stderr: received.stderr,
        }
      }
      if (!received.claimed) {
        try {
          const body = JSON.parse(received.stdout) as { waiting?: number }
          waiting = body.waiting ?? waiting
        } catch {}
        break
      }
      const item = retainClaim(received.claimed)
      if (item) retained.push(item)
      waiting = received.claimed.waiting ?? 0
      if (waiting <= 0) break
      capped = retained.length >= limit && waiting > 0
      if (capped) break
    }
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [AGENT_ID_MISMATCH]: ${(err as Error).message}\n`,
    }
  }

  let parsedBatch: { waiting?: number; capped?: boolean } = { waiting, capped }
  try {
    parsedBatch = JSON.parse(JSON.stringify({ waiting, capped }))
  } catch {
    parsedBatch = {}
  }

  const acks: AckResult[] = []
  if (wantsAck(opts)) {
    for (const item of retained) {
      const ack = reply({
        ...opts,
        content: renderAckContent(opts.ackContent ?? '', item),
        mentions: opts.ackMentions,
        queueId: item.queue_id,
        messageId: item.message_id,
        noClose: true,
        close: false,
      })
      acks.push({
        queue_id: item.queue_id,
        message_id: item.message_id,
        ok: ack.ok,
        code: ack.code,
        stdout: ack.stdout ? parseJsonOrText(ack.stdout) : undefined,
        stderr: ack.stderr || undefined,
      })
      if (!ack.ok) {
        return {
          ok: false,
          code: ack.code,
          stdout: JSON.stringify({
            ok: false,
            agent_id: firstPlanAgentId,
            retained,
            acks,
          }) + '\n',
          stderr: ack.stderr,
        }
      }
    }
  }

  let completion = completionOpen(retained)
  if (opts.completeNoReply && retained.length === 1) {
    completion = recordNoReply(retained[0], opts)
    if (completion.outcome === 'completion_failed') {
      return {
        ok: false,
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          agent_id: firstPlanAgentId,
          expected_agent_id: firstPlanExpectedAgentId,
          receive_mode: 'receive-actionable',
          retained,
          retained_count: retained.length,
          acked_count: acks.length,
          acks,
          completion,
        }) + '\n',
        stderr: `Error [CODEX_RUNNER_COMPLETION_FAILED]: ${completion.stderr ?? 'record-no-reply failed'}\n`,
      }
    }
  }

  return {
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      agent_id: firstPlanAgentId,
      expected_agent_id: firstPlanExpectedAgentId,
      receive_mode: 'receive-actionable',
      retained,
      retained_count: retained.length,
      acked_count: acks.length,
      acks,
      completion,
      waiting: parsedBatch.waiting ?? 0,
      limit,
      max_inspect: maxInspect,
      capped: parsedBatch.capped ?? false,
      final_close_contract: 'aun reply --close --queue-id <id> --message-id <uuid>',
    }) + '\n',
    stderr: '',
  }
}
