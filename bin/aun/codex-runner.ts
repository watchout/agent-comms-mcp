/**
 * First Codex auto-receive runner split (#422).
 *
 * This is intentionally a thin DB-primary tick:
 * - claim work through the existing `aun drain` path
 * - retain queue/message identity in structured JSON
 * - optionally emit ACK/progress through `reply --no-close`
 * - leave final completion to `reply --close --queue-id --message-id`
 */
import { drain, parseDrainLimit, type ClaimedMessage, type ReceiveOptions } from './receive'
import { reply } from './reply'

export interface CodexRunnerOptions extends ReceiveOptions {
  limit?: number
  ackMentions?: string
  ackContent?: string
}

export interface RetainedWorkItem {
  queue_id: string
  message_id: string
  channel_id: string | null
  thread_id: string | null
  from: string | null
  message_type: string | null
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

export function codexRunnerTick(opts: CodexRunnerOptions = {}): CodexRunnerResult {
  let limit: number
  try {
    limit = parseDrainLimit(opts.limit)
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

  let batch
  try {
    batch = drain({ ...opts, limit })
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [AGENT_ID_MISMATCH]: ${(err as Error).message}\n`,
    }
  }
  if (!batch.ok) {
    return {
      ok: false,
      code: batch.code,
      stdout: batch.stdout,
      stderr: batch.stderr,
    }
  }

  let parsedBatch: { waiting?: number; capped?: boolean } = {}
  try {
    parsedBatch = JSON.parse(batch.stdout)
  } catch {
    parsedBatch = {}
  }

  const retained = batch.claimed
    .map(retainClaim)
    .filter((item): item is RetainedWorkItem => item !== null)

  const acks: AckResult[] = []
  if (wantsAck(opts)) {
    for (const item of retained) {
      const ack = reply({
        ...opts,
        content: opts.ackContent,
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
            agent_id: batch.plan.env.AGENT_ID,
            retained,
            acks,
          }) + '\n',
          stderr: ack.stderr,
        }
      }
    }
  }

  return {
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      agent_id: batch.plan.env.AGENT_ID,
      expected_agent_id: batch.plan.env.AGENT_COM_EXPECTED_AGENT_ID,
      retained,
      retained_count: retained.length,
      acked_count: acks.length,
      acks,
      waiting: parsedBatch.waiting ?? 0,
      limit,
      capped: parsedBatch.capped ?? false,
      final_close_contract: 'aun reply --close --queue-id <id> --message-id <uuid>',
    }) + '\n',
    stderr: '',
  }
}
