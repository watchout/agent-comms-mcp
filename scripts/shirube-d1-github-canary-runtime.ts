#!/usr/bin/env bun
import {
  QUEUE_WORK_ENVELOPE_VERSION,
  QUEUE_WORK_RESULT_VERSION,
  type QueueWorkEnvelope,
  type QueueWorkResult,
} from '../core/queue-work'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveIssue(value: string): number {
  const issue = Number(value)
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error('SHIRUBE_D1_CANARY_ISSUE must be a positive integer')
  }
  return issue
}

export function buildShirubeD1GithubCanaryResult(
  envelope: QueueWorkEnvelope,
  env: NodeJS.ProcessEnv = process.env,
): QueueWorkResult {
  if (envelope.schema_version !== QUEUE_WORK_ENVELOPE_VERSION) {
    throw new Error(`unexpected queue envelope schema: ${String(envelope.schema_version)}`)
  }
  const repository = required(env, 'SHIRUBE_D1_CANARY_REPOSITORY')
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('SHIRUBE_D1_CANARY_REPOSITORY must be owner/name')
  }
  const issueNumber = positiveIssue(required(env, 'SHIRUBE_D1_CANARY_ISSUE'))
  const headSha = required(env, 'SHIRUBE_D1_CANARY_HEAD_SHA')
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('SHIRUBE_D1_CANARY_HEAD_SHA must be a lowercase 40-hex commit SHA')
  }
  const expectedAgent = required(env, 'SHIRUBE_D1_CANARY_AGENT_ID')
  const expectedQueue = required(env, 'SHIRUBE_D1_CANARY_QUEUE_ID')
  const expectedMessage = required(env, 'SHIRUBE_D1_CANARY_MESSAGE_ID')
  if (
    envelope.agent_id !== expectedAgent
    || envelope.queue_id !== expectedQueue
    || envelope.message_id !== expectedMessage
  ) {
    throw new Error('canary envelope does not match the exact agent/queue/message fence')
  }
  if (!envelope.handoff_contract.github_backed) {
    throw new Error('canary queue work must be a GitHub-backed handoff')
  }

  const body = [
    '<!-- aun:technical-check/v1 -->',
    `repo: ${repository}`,
    `issue: ${issueNumber}`,
    'role: d1-live-canary',
    `source_queue_id: ${envelope.queue_id}`,
    `source_message_id: ${envelope.message_id}`,
    `runtime_head_sha: ${headSha}`,
    'verdict: PASS',
  ].join('\n')

  return {
    schema_version: QUEUE_WORK_RESULT_VERSION,
    ok: true,
    summary: 'Shirube V4 D1 protected GitHub writeback canary completed',
    evidence: [
      'semantic_outcome=close',
      'outcome_reason=shirube_v4_d1_github_canary',
      `runtime_head_sha=${headSha}`,
    ],
    writeback: {
      mode: 'github_issue_comment',
      repo: repository,
      issue_number: issueNumber,
      body,
    },
    next_action: 'close',
  }
}

async function main(): Promise<void> {
  const envelope = JSON.parse(await Bun.stdin.text()) as QueueWorkEnvelope
  process.stdout.write(`${JSON.stringify(buildShirubeD1GithubCanaryResult(envelope))}\n`)
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
