import { describe, expect, test } from 'bun:test'
import { buildShirubeD1GithubCanaryResult } from '../../scripts/shirube-d1-github-canary-runtime'
import type { QueueWorkEnvelope } from '../../core/queue-work'

const envelope: QueueWorkEnvelope = {
  schema_version: 'queue_work_envelope_v1',
  queue_id: '88701',
  message_id: 'shirube-v4-d1-canary',
  agent_id: 'dev-001',
  channel: null,
  thread_id: null,
  requester: null,
  content: 'check handoff https://github.com/watchout/agent-comms-mcp/issues/887',
  reply_contract: { required: false, reply_to: 'shirube-v4-d1-canary', mention: null },
  runtime_contract: {
    do_not_call_next: true,
    do_not_call_inbox: true,
    return_schema: 'queue_work_result_v1',
  },
  handoff_contract: {
    kind: 'github_backed_role_handoff',
    github_backed: true,
    required_writebacks: ['github_issue_comment'],
    posting_mode: 'mediated',
    detected_from: ['message_type:phase_handoff', 'github_url'],
  },
}

const env = {
  SHIRUBE_D1_CANARY_REPOSITORY: 'watchout/agent-comms-mcp',
  SHIRUBE_D1_CANARY_ISSUE: '887',
  SHIRUBE_D1_CANARY_HEAD_SHA: 'a'.repeat(40),
  SHIRUBE_D1_CANARY_AGENT_ID: 'dev-001',
  SHIRUBE_D1_CANARY_QUEUE_ID: '88701',
  SHIRUBE_D1_CANARY_MESSAGE_ID: 'shirube-v4-d1-canary',
}

describe('Shirube V4 D1 GitHub canary runtime', () => {
  test('emits one exact fenced mediated writeback result', () => {
    const result = buildShirubeD1GithubCanaryResult(envelope, env)
    expect(result).toMatchObject({
      schema_version: 'queue_work_result_v1',
      ok: true,
      next_action: 'close',
      writeback: {
        repo: 'watchout/agent-comms-mcp',
        issue_number: 887,
      },
    })
    expect(result.writeback?.body).toContain('source_queue_id: 88701')
    expect(result.writeback?.body).toContain(`runtime_head_sha: ${'a'.repeat(40)}`)
  })

  test('fails closed when any exact fence differs', () => {
    expect(() => buildShirubeD1GithubCanaryResult(envelope, {
      ...env,
      SHIRUBE_D1_CANARY_QUEUE_ID: 'other',
    })).toThrow('exact agent/queue/message fence')
  })
})
