#!/usr/bin/env bun
import { buildK1BenchmarkPlan } from './harness'
import type { K1BenchmarkProfileId } from './profiles'

function value(flag: string): string | null {
  const direct = process.argv.find(arg => arg.startsWith(`${flag}=`))
  if (direct) return direct.slice(flag.length + 1)
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

if (!process.argv.includes('--plan')) throw new Error('K1 benchmark execution is not authorized; pass --plan')
const profile = value('--profile') as K1BenchmarkProfileId | null
if (profile !== 'A0_correctness' && profile !== 'A1_reference') {
  throw new Error('--profile must be A0_correctness or A1_reference')
}
const plan = buildK1BenchmarkPlan(profile)
if (process.argv.includes('--json')) console.log(JSON.stringify(plan))
else console.log(plan)
