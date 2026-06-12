import { describe, expect, test } from 'bun:test'
import { buildRunQueueWorkPlan, runQueueWork } from '../bin/aun/run-queue-work'

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
})
