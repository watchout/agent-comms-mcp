export interface AunK3BenchmarkProfileV1 {
  name: 'A1_reference'
  cycles: number
  p95_added_latency_budget_ms: number
}

export const AUN_K3_BENCHMARK_PROFILES: Record<string, AunK3BenchmarkProfileV1> = {
  A1_reference: { name: 'A1_reference', cycles: 100, p95_added_latency_budget_ms: 100 },
}
