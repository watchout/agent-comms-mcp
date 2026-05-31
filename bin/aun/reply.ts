/**
 * Stable AUN reply/notify wrappers.
 *
 * These wrappers keep the existing `agent-com send` / `agent-com notify`
 * semantics intact, while making operator-facing failure modes explicit.
 */
import {
  buildCommandPlan,
  type CommandPlan,
  type ReceiveOptions,
  runCommandPlan,
} from './receive'

export interface ReplyOptions extends ReceiveOptions {
  content?: string
  mentions?: string
  messageType?: string
  queueId?: string
  messageId?: string
  noClose?: boolean
  close?: boolean
}

export interface NotifyOptions extends ReplyOptions {
  channelId?: string
  channelName?: string
  channel?: string
  resolveChannelName?: boolean
  threadId?: string
  replyTo?: string
  queueId?: string
}

export interface WrapperResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  plan?: CommandPlan
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim()
  if (!text) throw new Error(`${label} is required`)
  return text
}

export function resolveWrapperBunExecutable(): string {
  return process.env.AUN_BUN_EXECUTABLE?.trim()
    || process.env.STATE_DAEMON_BUN_EXECUTABLE?.trim()
    || process.execPath
}

export function buildReplyPlan(opts: ReplyOptions = {}): CommandPlan {
  const content = requireText(opts.content, '--content')
  const mentions = requireText(opts.mentions, '--mentions')
  const argv = [resolveWrapperBunExecutable(), 'cli/index.ts', 'send', '--content', content, '--mentions', mentions]
  if (opts.messageType?.trim()) argv.push('--message-type', opts.messageType.trim())
  if (opts.queueId?.trim()) argv.push('--queue-id', opts.queueId.trim())
  if (opts.messageId?.trim()) argv.push('--message-id', opts.messageId.trim())
  if (opts.noClose) argv.push('--no-close')
  if (opts.close) argv.push('--close')
  return buildCommandPlan(opts, argv)
}

export function buildNotifyPlan(opts: NotifyOptions = {}): CommandPlan {
  if (opts.replyTo || opts.queueId) {
    throw new Error(
      'notify cannot close or masquerade as a reply; omit --reply-to/--queue-id or use aun reply',
    )
  }
  const content = requireText(opts.content, '--content')
  const mentions = requireText(opts.mentions, '--mentions')
  if (opts.channel?.trim()) {
    throw new Error('--channel is no longer accepted; use --channel-id')
  }
  const channelId = opts.channelId?.trim()
  const channelName = opts.channelName?.trim()
  if (channelId && channelName) {
    throw new Error('pass either --channel-id or --channel-name, not both')
  }
  const argv = [resolveWrapperBunExecutable(), 'cli/index.ts', 'notify', '--content', content, '--mentions', mentions]
  if (channelId) {
    argv.push('--channel-id', channelId)
  } else if (channelName && opts.resolveChannelName) {
    argv.push('--channel-name', channelName, '--resolve-channel-name')
  } else {
    throw new Error('--channel-id is required')
  }
  if (opts.threadId?.trim()) argv.push('--thread-id', opts.threadId.trim())
  if (opts.messageType?.trim()) argv.push('--message-type', opts.messageType.trim())
  return buildCommandPlan(opts, argv)
}

export function clarifyReplyFailure(stderr: string, agentId: string): string {
  if (!stderr.includes('INVALID_REPLY_TO')) return stderr
  if (stderr.includes('CLAIM_EXPIRED_OR_MISSING')) return stderr
  return stderr +
    `Error [CLAIM_EXPIRED_OR_MISSING]: ${agentId} has no active received claim. ` +
    'The review may have exceeded claim TTL or was already closed. ' +
    `Run 'aun receive --agent-id ${agentId}' to explicitly re-claim pending work, then retry 'aun reply'.\n`
}

function dryRun(plan: CommandPlan, kind: 'reply' | 'notify'): WrapperResult {
  return {
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      dry_run: true,
      kind,
      cwd: plan.repoRoot,
      argv: plan.argv,
      agent_id: plan.env.AGENT_ID,
      expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
      database_url_candidates: plan.databaseUrlCandidates,
    }) + '\n',
    stderr: '',
    plan,
  }
}

export function reply(opts: ReplyOptions = {}): WrapperResult {
  const plan = buildReplyPlan(opts)
  if (opts.dryRun) return dryRun(plan, 'reply')
  const result = runCommandPlan(plan)
  if (!result.ok) {
    result.stderr = clarifyReplyFailure(result.stderr, plan.env.AGENT_ID)
  }
  return { ...result, plan }
}

export function notify(opts: NotifyOptions = {}): WrapperResult {
  let plan: CommandPlan
  try {
    plan = buildNotifyPlan(opts)
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [NOTIFY_IS_NOT_REPLY]: ${(err as Error).message}\n`,
    }
  }
  if (opts.dryRun) return dryRun(plan, 'notify')
  const result = runCommandPlan(plan)
  return { ...result, plan }
}
