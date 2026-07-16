export const K2_PROFILE_NAMES = ['A0_correctness', 'A1_reference', 'A2_soak'] as const
export type K2ProfileName = typeof K2_PROFILE_NAMES[number]

export interface K2BenchmarkProfile {
  profile: K2ProfileName
  fixture_only: true
  seats: number
  idle_duration_ms: number
  repetitions: number
  safety_poll_interval_ms: number
  fake_runtime: true
  fake_provider: true
  required_predicates: string[]
}

export const K2_BENCHMARK_PROFILES: Record<K2ProfileName, K2BenchmarkProfile> = {
  A0_correctness: {
    profile: 'A0_correctness',
    fixture_only: true,
    seats: 3,
    idle_duration_ms: 10_000,
    repetitions: 1,
    safety_poll_interval_ms: 2_000,
    fake_runtime: true,
    fake_provider: true,
    required_predicates: [
      'real_model_calls=0',
      'provider_calls=0',
      'shared_database_connections=0',
    ],
  },
  A1_reference: {
    profile: 'A1_reference',
    fixture_only: true,
    seats: 100,
    idle_duration_ms: 600_000,
    repetitions: 3,
    safety_poll_interval_ms: 2_000,
    fake_runtime: true,
    fake_provider: true,
    required_predicates: [
      'cpu_percent<1',
      'db_safety_poll_qps_per_process<=0.5',
      'rss_mib<=256',
      'real_model_calls=0',
      'provider_calls=0',
    ],
  },
  A2_soak: {
    profile: 'A2_soak',
    fixture_only: true,
    seats: 100,
    idle_duration_ms: 259_200_000,
    repetitions: 1,
    safety_poll_interval_ms: 2_000,
    fake_runtime: true,
    fake_provider: true,
    required_predicates: [
      'memory_growth_percent<10',
      'unbounded_backlog=false',
      'real_model_calls=0',
      'provider_calls=0',
    ],
  },
}

export function isK2ProfileName(value: string): value is K2ProfileName {
  return (K2_PROFILE_NAMES as readonly string[]).includes(value)
}
