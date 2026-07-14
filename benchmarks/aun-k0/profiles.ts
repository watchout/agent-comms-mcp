export const PROFILE_NAMES = ['A0_correctness', 'A1_reference', 'A2_soak'] as const
export type ProfileName = typeof PROFILE_NAMES[number]

export interface BenchmarkProfile {
  database: 'postgresql'
  closed_history: number
  active_turns: number
  worker_count: number
  payload_profile: string
  duration_hours: number | null
  injected_failures: string[]
}

export const PROFILES: Record<ProfileName, BenchmarkProfile> = {
  A0_correctness: {
    database: 'postgresql',
    closed_history: 100_000,
    active_turns: 10_000,
    worker_count: 32,
    payload_profile: 'correctness_matrix',
    duration_hours: null,
    injected_failures: [],
  },
  A1_reference: {
    database: 'postgresql',
    closed_history: 1_000_000,
    active_turns: 10_000,
    worker_count: 100,
    payload_profile: 'median_4096_bytes',
    duration_hours: null,
    injected_failures: [],
  },
  A2_soak: {
    database: 'postgresql',
    closed_history: 1_000_000,
    active_turns: 10_000,
    worker_count: 32,
    payload_profile: 'soak_mixed_payload',
    duration_hours: 72,
    injected_failures: ['worker_kill', 'database_restart', 'listener_loss', 'adapter_timeout'],
  },
}

export const ACCEPTANCE = [
  ['AUN-PERF-001', 'p95 <= 25 and p99 <= 100'],
  ['AUN-PERF-002', 'p95 <= 50 and p99 <= 200 at expected_peak_x2'],
  ['AUN-PERF-003', 'p95 <= 50 and p99 <= 150'],
  ['AUN-PERF-004', 'p95 <= 100 and poll_backstop_ms <= 2000'],
  ['AUN-PERF-005', 'p95 <= 100 excluding_provider'],
  ['AUN-PERF-006', 'completed_turns_per_second >= 250 and event_appends_per_second >= 1000'],
  ['AUN-RES-001', 'count == 0 at every crash point'],
  ['AUN-RES-002', 'count == 0'],
  ['AUN-RES-003', 'count == 0 when adapter capability is idempotent'],
  ['AUN-RES-004', 'model_invocation_count == 0 for invalid binding fixtures'],
  ['AUN-RES-005', 'rejected == 100_percent'],
  ['AUN-RES-006', 'rto_seconds <= 30 and committed_event_rpo == 0'],
  ['AUN-RES-007', 'hung_seat_additional_p95_delay_ms <= 100 for other seats and outbox'],
  ['AUN-RES-008', 'deadlocks == 0 and memory_growth_percent < 10 and unbounded_backlog == false'],
  ['AUN-EFF-001', 'cpu_percent < 1 and db_safety_poll_qps_per_process <= 0.5 and rss_mib <= 256'],
] as const

export const SPECIMEN_IDS = [
  'event_id_same_payload_idempotent',
  'event_id_different_payload_collision',
  'two_live_daemons_no_claim_steal',
  'stale_fencing_token_rejected',
  'every_crash_boundary_zero_loss',
  'historic_prefix_does_not_starve_matched_reconciliation',
  'notification_loss_converges_via_scan',
  'runtime_timeout_is_not_semantic_completion',
  'invalid_binding_causes_zero_model_calls',
  'provider_without_receipt_never_emits_delivered',
  'same_nonce_retry_has_one_external_effect',
  'long_history_keeps_query_slo',
] as const

export function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value)
}
