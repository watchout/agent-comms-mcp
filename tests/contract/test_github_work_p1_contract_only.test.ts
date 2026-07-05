import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GITHUB_WORK_EVENT_LOG_CORE_VERSION,
  GITHUB_WORK_QUEUE_VIEW_VERSION,
  classifyProtectedSurface,
  evaluateTwoPhaseClaimRace,
  parseEventLogCore,
  projectQueueView,
  type GithubWorkEventLogCore,
} from '../../core/state-daemon/github-work-event-log-core'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'github-work-p1-contract')
const SCHEMA_PATH = join(REPO_ROOT, 'schemas', 'github-work-event-log-core-v1.schema.json')

interface OverlayFixture {
  base_event_ref: string
  events: Record<string, unknown>[]
  expected: Record<string, unknown>
}

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as T
}

function overlayEvents(name: string): GithubWorkEventLogCore[] {
  const overlay = fixture<OverlayFixture>(name)
  const base = fixture<Record<string, unknown>>(overlay.base_event_ref)
  return overlay.events.map((eventOverlay) => parseFixtureEvent(deepMerge(base, eventOverlay)))
}

function parseFixtureEvent(raw: unknown): GithubWorkEventLogCore {
  const parsed = parseEventLogCore(raw)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  return parsed.event
}

function deepMerge(base: unknown, overlay: unknown): Record<string, unknown> {
  if (!isRecord(base)) return isRecord(overlay) ? overlay : {}
  if (!isRecord(overlay)) return { ...base }
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = merged[key]
    merged[key] = isRecord(baseValue) && isRecord(value) ? deepMerge(baseValue, value) : value
  }
  return merged
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('P1_contract_only GitHub work contract merge gates', () => {
  test('F1 - EventLogCore schema/parser accepts the frozen valid contract fixture', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>
    expect(schema).toMatchObject({
      title: 'GitHub Work EventLogCore v1',
      additionalProperties: false,
    })

    const parsed = parseEventLogCore(fixture('F1-event-log-core-valid.json'))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
    expect(parsed.event.schema_version).toBe(GITHUB_WORK_EVENT_LOG_CORE_VERSION)
    expect(parsed.event.lane).toBe('P1_contract_only')
    expect(parsed.event.github.repo).toBe('watchout/agent-comms-mcp')
    expect(parsed.event.claim).toMatchObject({
      phase: 'not_applicable',
      winner_confirmation_required_before_execution: true,
      winner_execution_precondition_met: false,
      runtime_execution_performed: false,
      result_publication_performed: false,
    })
    expect(parsed.event.poll_profile).toMatchObject({
      profile_id: 'serial_seat_default',
      poll_interval_ms: 120000,
      max_in_flight_claims_per_seat: 1,
      max_new_claims_per_poll: 1,
      no_poll_overlap: true,
    })
    expect(parsed.event.protected_surface).toMatchObject({
      classification_source: 'independent_classifier_v1',
      declared_protected_surface: false,
      protected_surface_classified: false,
      claim_allowed: true,
    })
    expect(parsed.event.evidence).toMatchObject({
      ssot: 'github',
      aun_is_acceleration_only: true,
      mutation_performed: false,
      live_github_api_performed: false,
      token_used: false,
      db_queue_mutation_performed: false,
    })
    expect(parsed.event.evidence.completion_evidence_not_accepted).toEqual([
      'aun_ack',
      'queue_id',
      'discord_projection',
      'tui_visibility',
      'green_ci_alone',
    ])
  })

  test('F1 - two-phase claim confirmation elects one winner and blocks loser execution/result', () => {
    const events = overlayEvents('github-double-claim-one-confirmed.yaml')
    const result = evaluateTwoPhaseClaimRace(events, { now: '2026-07-05T09:00:05.000Z' })

    expect(result.errors).toEqual([])
    expect(result.candidate_claim_ids).toEqual(['claim-a', 'claim-b'])
    expect(result.deterministic_winner_claim_id).toBe('claim-a')
    expect(result.confirmed_winner_count).toBe(1)
    expect(result.losing_claim_ids).toEqual(['claim-b'])
    expect(result.loser_runtime_execution_performed).toBe(false)
    expect(result.loser_result_publication_performed).toBe(false)

    const candidateEvents = events.filter((event) => event.claim.phase === 'claim_requested')
    expect(candidateEvents).toHaveLength(2)
    for (const event of candidateEvents) {
      expect(event.claim.confirmed_winner_claim_id).toBe(null)
      expect(event.claim.winner_execution_precondition_met).toBe(false)
      expect(event.claim.runtime_execution_performed).toBe(false)
      expect(event.claim.result_publication_performed).toBe(false)
    }
  })

  test('F2 - parser rejects P2/live/API/token/DB/queue forbidden scope', () => {
    const parsed = parseEventLogCore(fixture('F2-forbidden-live-scope.json'))

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected forbidden fixture to fail')
    expect(parsed.errors).toContain('lane_must_equal_P1_contract_only')
    expect(parsed.errors).toContain('evidence.mutation_performed_must_equal_false')
    expect(parsed.errors).toContain('evidence.live_github_api_performed_must_equal_false')
    expect(parsed.errors).toContain('evidence.live_canary_performed_must_equal_false')
    expect(parsed.errors).toContain('evidence.daemon_or_scheduler_touched_must_equal_false')
    expect(parsed.errors).toContain('evidence.token_used_must_equal_false')
    expect(parsed.errors).toContain('evidence.db_queue_mutation_performed_must_equal_false')
    expect(parsed.errors).toContain('evidence.completion_evidence_not_accepted_missing:aun_ack')
    expect(parsed.errors).toContain('evidence.completion_evidence_not_accepted_missing:green_ci_alone')
  })

  test('F2 - audit-pool profile pins #32 cadence, fairness, and backpressure recovery', () => {
    const [event] = overlayEvents('F2-audit-pool-profile.json')
    const [missedSignal] = overlayEvents('missed-signal-next-poll-recovers.yaml')

    expect(event.poll_profile).toMatchObject({
      profile_id: 'audit_pool_profile',
      source_ref: 'watchout/iyasaka-arc#32',
      poll_interval_ms: 60000,
      jitter_ms_max: 20000,
      max_in_flight_claims_per_seat: 1,
      max_new_claims_per_poll: 1,
      pool_width_source: 'count(active registered evidence_audit_gate seats in watchout/iyasaka-arc#32 registry)',
      race_behavior: 'two_phase_claim_confirmation',
      no_poll_overlap: true,
      api_rate_limit_backoff: 'exponential_backoff_with_jitter',
      repo_hammer_guard: 'etag_or_if_none_match_when_available',
    })
    expect(event.poll_profile.starvation_guard.metrics_derive_from_events).toEqual([
      'request_to_claim_latency_ms',
      'unclaimed_count_by_function',
      'active_claims_by_seat',
      'claim_lost_count_by_seat',
    ])
    expect(missedSignal.poll_profile.missed_signal_recovery).toEqual({
      signal_required_for_discovery: false,
      next_poll_discovers_work: true,
      claim_possible_without_human_relay: true,
    })
  })

  test('F3 - QueueView projector preserves GitHub SSOT and P1 no-mutation evidence', () => {
    const rawEvents = fixture<unknown[]>('F3-queue-view-events.json')
    const events = rawEvents.map(parseFixtureEvent)

    const view = projectQueueView(events)

    expect(view).toMatchObject({
      schema_version: GITHUB_WORK_QUEUE_VIEW_VERSION,
      repo: 'watchout/agent-comms-mcp',
      number: 744,
      status: 'duplicate_suppressed',
      latest_event_id: 'f3_duplicate_suppressed',
      fingerprint: 'p1-f3-fingerprint',
      ssot: 'github',
      aun_is_acceleration_only: true,
      p2_required_for_execution: true,
      mutation_performed: false,
      claim_allowed: false,
      protected_surface_classified: false,
      owner_decision_required: false,
    })
    expect(view.event_count).toBe(2)
    expect(view.blocker_codes).toEqual(['duplicate_fingerprint'])
  })

  test('F3 - independent protected-surface classifier fails closed on misdeclared input', () => {
    const classification = classifyProtectedSurface({
      declared_protected_surface: false,
      title: 'Enable state daemon LaunchAgent',
      body: 'Request selects host LaunchAgent activation for the state daemon.',
      labels: ['needs:implementation', 'owner:aun', 'route:fast', 'runner:codex'],
      changed_paths: ['scripts/state-daemon-launchagent.ts'],
      declared_operations: ['launchagent_activation', 'state-daemon enablement'],
      route_labels: ['route:fast', 'runner:codex'],
      owner_decision_url: null,
    })
    expect(classification).toMatchObject({
      protected_surface_classified: true,
      owner_decision_required: true,
      claim_allowed: false,
      queue_view_state: 'blocked',
      blocker_codes: ['PROTECTED_SURFACE_OWNER_REQUIRED'],
    })

    const [event] = overlayEvents('protected-surface-misdeclared-blocked.yaml')
    const view = projectQueueView([event])

    expect(event.route.protected).toBe(false)
    expect(event.protected_surface.declared_protected_surface).toBe(false)
    expect(event.protected_surface.protected_surface_classified).toBe(true)
    expect(view.claim_allowed).toBe(false)
    expect(view.blocker_codes).toEqual(['PROTECTED_SURFACE_OWNER_REQUIRED'])
  })

  test('F4 - required golden failure fixtures are enforced as merge gate', () => {
    const gates = fixture<{
      lane: string
      merge_gates: string[]
      runtime_wiring_forbidden: string[]
      forbidden_surfaces: string[]
      required_golden_failure_fixtures: string[]
    }>('F4-merge-gates.json')
    expect(gates.lane).toBe('P1_contract_only')
    expect(gates.merge_gates).toEqual([
      'F1_CLAIM_ATOMICITY_TWO_PHASE_CONFIRMATION',
      'F2_POLL_CADENCE_FAIRNESS_BACKPRESSURE_AUDIT_POOL',
      'F3_INDEPENDENT_PROTECTED_SURFACE_CLASSIFIER',
      'F4_GOLDEN_FAILURE_FIXTURES',
    ])
    expect(gates.required_golden_failure_fixtures).toEqual([
      'github-double-claim-one-confirmed.yaml',
      'missed-signal-next-poll-recovers.yaml',
      'function-address-binding-unresolved-blocked.yaml',
      'protected-surface-misdeclared-blocked.yaml',
      'protected-option-a-owner-required.yaml',
    ])
    for (const name of gates.required_golden_failure_fixtures) {
      expect(existsSync(join(FIXTURE_DIR, name))).toBe(true)
    }

    const binding = projectQueueView(overlayEvents('function-address-binding-unresolved-blocked.yaml'))
    expect(binding.status).toBe('blocked')
    expect(binding.claim_allowed).toBe(false)
    expect(binding.blocker_codes).toEqual(['BINDING_UNRESOLVED'])

    const optionA = projectQueueView(overlayEvents('protected-option-a-owner-required.yaml'))
    expect(optionA.status).toBe('blocked')
    expect(optionA.claim_allowed).toBe(false)
    expect(optionA.blocker_codes).toEqual(['PROTECTED_SURFACE_OWNER_REQUIRED'])
  })

  test('F4 - contract-only surface pin keeps P1 out of daemon/scheduler/AUN runner paths', () => {
    const gates = fixture<{
      lane: string
      runtime_wiring_forbidden: string[]
      forbidden_surfaces: string[]
    }>('F4-merge-gates.json')
    expect(gates.lane).toBe('P1_contract_only')
    expect(gates.forbidden_surfaces).toContain('P2_github_pull_once')
    expect(gates.forbidden_surfaces).toContain('live GitHub/API/canary')

    for (const relative of gates.runtime_wiring_forbidden) {
      const source = readFileSync(join(REPO_ROOT, relative), 'utf8')
      expect(source).not.toContain('github-work-event-log-core')
      expect(source).not.toContain('parseEventLogCore')
      expect(source).not.toContain('projectQueueView')
    }
  })
})
