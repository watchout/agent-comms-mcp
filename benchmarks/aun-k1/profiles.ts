export type K1BenchmarkProfileId = 'A0_correctness' | 'A1_reference'

export interface K1BenchmarkProfile {
  profile: K1BenchmarkProfileId
  fixture_only: true
  workers: number
  turns: number
  historic_prefix: number
  lease_ms: number
  required_predicates: string[]
}

export const K1_BENCHMARK_PROFILES: Record<K1BenchmarkProfileId, K1BenchmarkProfile> = {
  A0_correctness: {
    profile: 'A0_correctness',
    fixture_only: true,
    workers: 2,
    turns: 32,
    historic_prefix: 64,
    lease_ms: 250,
    required_predicates: [
      'claim_steal_count=0',
      'duplicate_completion_count=0',
      'stale_holder_terminal_mutations_accepted=0',
      'incremental_projection_equals_replay=true',
    ],
  },
  A1_reference: {
    profile: 'A1_reference',
    fixture_only: true,
    workers: 4,
    turns: 1000,
    historic_prefix: 10000,
    lease_ms: 1000,
    required_predicates: [
      'committed_to_claimed_p95_ms<=50',
      'active_projection_p95_ms<=50',
      'active_projection_p99_ms<=150',
      'provider_invocations=0',
      'v1_row_deltas=0',
    ],
  },
}
