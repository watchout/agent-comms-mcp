import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { buildBenchmarkPlan } from '../../benchmarks/aun-k0/harness'
import { PROFILE_NAMES } from '../../benchmarks/aun-k0/profiles'

const context = {
  sourceSha: '0d7c52d80b515ed39fd0e41bc84a617fd6fbe2fa',
  treeDigest: '0123456789abcdef0123456789abcdef01234567',
  databaseVersion: '16',
}

describe('AUN K0 benchmark plan harness', () => {
  test('emits all profiles as contract-valid but never behavior-proven', () => {
    for (const profile of PROFILE_NAMES) {
      const plan = buildBenchmarkPlan(profile, context)
      expect(plan.profile).toBe(profile)
      expect(plan.contract_valid).toBe(true)
      expect(plan.behavior_proven).toBe(false)
      expect(plan.acceptance).toHaveLength(15)
      expect(plan.specimens).toHaveLength(12)
      expect(plan.acceptance.every((item) => item.status === 'not_measured' && item.measured === null)).toBe(true)
      expect(plan.plan_digest).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  test('canonical plan digest excludes time, run id, and observed hardware', () => {
    const first = buildBenchmarkPlan('A1_reference', {
      ...context,
      generatedAt: '2026-07-12T00:00:00.000Z',
      runId: 'run-one',
      hardware: { cpu: 'cpu-one', memory_bytes: 1 },
    })
    const second = buildBenchmarkPlan('A1_reference', {
      ...context,
      generatedAt: '2026-07-13T00:00:00.000Z',
      runId: 'run-two',
      hardware: { cpu: 'cpu-two', memory_bytes: 2 },
    })
    expect(first.plan_digest).toBe(second.plan_digest)
    expect(first.generated_at).not.toBe(second.generated_at)
    expect(first.run_id).not.toBe(second.run_id)
    expect(first.hardware).not.toEqual(second.hardware)
  })

  test('profile and policy changes are digest-visible', () => {
    const a0 = buildBenchmarkPlan('A0_correctness', context)
    const a1 = buildBenchmarkPlan('A1_reference', context)
    const otherHead = buildBenchmarkPlan('A0_correctness', {
      ...context,
      sourceSha: '1111111111111111111111111111111111111111',
    })
    expect(a0.plan_digest).not.toBe(a1.plan_digest)
    expect(a0.plan_digest).not.toBe(otherHead.plan_digest)
  })

  test('CLI emits parseable plan-only JSON for A0/A1/A2', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    for (const profile of PROFILE_NAMES) {
      const result = Bun.spawnSync([
        'bun',
        'benchmarks/aun-k0/cli.ts',
        '--profile',
        profile,
        '--plan',
        '--json',
      ], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).toBe(0)
      const output = JSON.parse(new TextDecoder().decode(result.stdout))
      expect(output.profile).toBe(profile)
      expect(output.behavior_proven).toBe(false)
      expect(output.acceptance.every((item: any) => item.status === 'not_measured')).toBe(true)
    }
  })
})
