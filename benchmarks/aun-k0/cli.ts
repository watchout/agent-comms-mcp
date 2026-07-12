#!/usr/bin/env bun
import { buildBenchmarkPlan } from './harness'
import { isProfileName } from './profiles'

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args.join(' ')} failed`)
  }
  return new TextDecoder().decode(result.stdout).trim()
}

const profile = valueAfter('--profile')
if (!profile || !isProfileName(profile) || !process.argv.includes('--plan') || !process.argv.includes('--json')) {
  console.error('Usage: bun benchmarks/aun-k0/cli.ts --profile A0_correctness|A1_reference|A2_soak --plan --json')
  process.exit(2)
}

try {
  const plan = buildBenchmarkPlan(profile, {
    sourceSha: git('rev-parse', 'HEAD'),
    treeDigest: git('rev-parse', 'HEAD^{tree}'),
    databaseVersion: process.env.AUN_K0_DATABASE_VERSION ?? 'not_observed_plan_only',
  })
  console.log(JSON.stringify(plan, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
