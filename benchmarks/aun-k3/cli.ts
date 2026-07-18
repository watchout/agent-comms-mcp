import { AUN_K3_BENCHMARK_PROFILES } from './profiles'
import { runAunK3Benchmark } from './harness'

const profileName = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : 'A1_reference'
const profile = AUN_K3_BENCHMARK_PROFILES[profileName]
if (!profile) throw new Error(`unknown AUN K3 benchmark profile ${profileName}`)
const result = await runAunK3Benchmark(profile)
console.log(JSON.stringify(result))
if (!result.pass) process.exitCode = 1
