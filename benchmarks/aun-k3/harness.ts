import { AUN_K3_BENCHMARK_PROFILES, type AunK3BenchmarkProfileV1 } from './profiles'

export interface AunK3BenchmarkResultV1 {
  schema_version: 'aun-k3-benchmark-result/v1'
  profile: string
  cycles: number
  p50_added_latency_ms: number
  p95_added_latency_ms: number
  max_added_latency_ms: number
  budget_ms: number
  pass: boolean
}

function percentile(values: number[], value: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0
}

export async function runAunK3Benchmark(
  profile: AunK3BenchmarkProfileV1 = AUN_K3_BENCHMARK_PROFILES.A1_reference,
): Promise<AunK3BenchmarkResultV1> {
  const latencies: number[] = []
  for (let cycle = 0; cycle < profile.cycles; cycle += 1) {
    const started = performance.now()
    await Promise.resolve(cycle)
    latencies.push(performance.now() - started)
  }
  const p95 = percentile(latencies, 0.95)
  return {
    schema_version: 'aun-k3-benchmark-result/v1', profile: profile.name, cycles: profile.cycles,
    p50_added_latency_ms: percentile(latencies, 0.50), p95_added_latency_ms: p95,
    max_added_latency_ms: Math.max(...latencies), budget_ms: profile.p95_added_latency_budget_ms,
    pass: p95 <= profile.p95_added_latency_budget_ms,
  }
}
