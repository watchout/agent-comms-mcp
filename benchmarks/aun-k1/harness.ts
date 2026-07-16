import { K1_BENCHMARK_PROFILES, type K1BenchmarkProfileId } from './profiles'

export interface K1BenchmarkPlan {
  schema_version: 'aun-k1-benchmark-plan/v1'
  profile: K1BenchmarkProfileId
  execution: 'plan_only'
  database_scope: 'isolated_disposable_fixture'
  production_apply: false
  provider_dispatch: 'disabled'
  V1_mode: 'observe_only_no_traversal'
  workers: number
  turns: number
  historic_prefix: number
  lease_ms: number
  required_predicates: string[]
}

export function buildK1BenchmarkPlan(profileId: K1BenchmarkProfileId): K1BenchmarkPlan {
  const profile = K1_BENCHMARK_PROFILES[profileId]
  if (!profile) throw new Error(`unknown K1 benchmark profile: ${profileId}`)
  return {
    schema_version: 'aun-k1-benchmark-plan/v1',
    profile: profile.profile,
    execution: 'plan_only',
    database_scope: 'isolated_disposable_fixture',
    production_apply: false,
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    workers: profile.workers,
    turns: profile.turns,
    historic_prefix: profile.historic_prefix,
    lease_ms: profile.lease_ms,
    required_predicates: [...profile.required_predicates],
  }
}
