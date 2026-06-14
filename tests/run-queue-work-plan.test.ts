import { describe, expect, test } from 'bun:test'
import {
  buildCodexExecQueueWorkCommand,
  buildRunQueueWorkPlan,
  runQueueWork,
} from '../bin/aun/run-queue-work'

describe('buildRunQueueWorkPlan expected_claim_source', () => {
  test('resolves from explicit option first', () => {
    const plan = buildRunQueueWorkPlan({
      queueId: '42',
      agentId: 'codex-audit',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      env: { AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE: 'env-source' } as NodeJS.ProcessEnv,
    })
    expect(plan.expected_claim_source).toBe('state-daemon-queue-work-scheduler')
  })

  test('falls back to AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE env', () => {
    const plan = buildRunQueueWorkPlan({
      queueId: '42',
      agentId: 'codex-audit',
      env: { AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE: 'env-source' } as NodeJS.ProcessEnv,
    })
    expect(plan.expected_claim_source).toBe('env-source')
  })

  test('defaults to null so manual operator runs stay unrestricted', () => {
    const plan = buildRunQueueWorkPlan({
      queueId: '42',
      agentId: 'codex-audit',
      env: {} as NodeJS.ProcessEnv,
    })
    expect(plan.expected_claim_source).toBeNull()
  })

  test('dry-run result surfaces the resolved claim source in the plan', async () => {
    const result = await runQueueWork({
      queueId: '42',
      agentId: 'codex-audit',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      dryRun: true,
      env: {} as NodeJS.ProcessEnv,
    })
    expect(result.ok).toBe(true)
    expect(result.dry_run).toBe(true)
    expect(result.plan.expected_claim_source).toBe('state-daemon-queue-work-scheduler')
  })

  test('resolves state-daemon queue-work runtime env for launchagent canary', () => {
    const plan = buildRunQueueWorkPlan({
      queueId: '42',
      agentId: 'qa',
      env: {
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
      } as NodeJS.ProcessEnv,
    })
    expect(plan.runtime).toBe('codex-exec')
  })

  test('codex-exec queue-work command uses schema, output-last-message, sandbox, cd, and stdin prompt', () => {
    const command = buildCodexExecQueueWorkCommand({
      cwd: '/repo',
      outputLastMessagePath: '/tmp/final-message.json',
      env: {
        AUN_QUEUE_WORK_CODEX_OUTPUT_SCHEMA: '/repo/schemas/queue-work-result-v1.schema.json',
        AUN_QUEUE_WORK_CODEX_SANDBOX: 'read-only',
        AUN_QUEUE_WORK_CODEX_EXECUTABLE: '/opt/homebrew/bin/codex',
        AUN_QUEUE_WORK_CODEX_IGNORE_RULES: '1',
      } as NodeJS.ProcessEnv,
      envelope: {
        schema_version: 'queue_work_envelope_v1',
        queue_id: '42',
        message_id: 'msg-42',
        agent_id: 'qa',
        channel: null,
        thread_id: null,
        requester: 'agent-com-dev',
        content: 'canary',
        reply_contract: {
          required: false,
          reply_to: 'msg-42',
          mention: 'agent-com-dev',
        },
        runtime_contract: {
          do_not_call_next: true,
          do_not_call_inbox: true,
          return_schema: 'queue_work_result_v1',
        },
      },
    })

    expect(command.command).toBe('/opt/homebrew/bin/codex')
    expect(command.args).toEqual([
      'exec',
      '--json',
      '--output-schema', '/repo/schemas/queue-work-result-v1.schema.json',
      '--output-last-message', '/tmp/final-message.json',
      '--sandbox', 'read-only',
      '--cd', '/repo',
      '--ephemeral',
      '--ignore-rules',
      '-',
    ])
    expect(command.stdin).toContain('Return only JSON matching queue_work_result_v1')
    expect(command.stdin).toContain('"queue_id":"42"')
    expect(command.stdin).toContain('Do not call next, inbox')
  })
})
