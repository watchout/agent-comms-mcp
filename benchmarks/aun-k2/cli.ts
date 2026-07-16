#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { buildK2BenchmarkPlan, runK2IdleBenchmark } from './harness'
import { isK2ProfileName } from './profiles'

function value(flag: string): string | null {
  const direct = process.argv.find(argument => argument.startsWith(`${flag}=`))
  if (direct) return direct.slice(flag.length + 1)
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim())
  return new TextDecoder().decode(result.stdout).trim()
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const profile = value('--profile')
if (!profile || !isK2ProfileName(profile) || !process.argv.includes('--json')) {
  throw new Error('Usage: bun benchmarks/aun-k2/cli.ts --profile A0_correctness|A1_reference|A2_soak [--plan] --json')
}
const context = {
  sourceSha: git('rev-parse', 'HEAD'),
  treeHash: git('rev-parse', 'HEAD^{tree}'),
  configDigest: sha256(JSON.stringify({ profile, runtime: 'fake_only', provider: 'fake_only' })),
  policyDigest: sha256('AUN-K2-REQ-006:cpu<1,poll<=0.5,rss<=256,model=0,provider=0'),
  databaseVersion: process.env.AUN_K2_DATABASE_VERSION ?? 'not_observed_plan_only',
}
const result = process.argv.includes('--plan')
  ? buildK2BenchmarkPlan(profile, context)
  : await runK2IdleBenchmark(profile, context)
console.log(JSON.stringify(result, null, 2))
