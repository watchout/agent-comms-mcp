import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GITHUB_WORK_EVENT_LOG_CORE_VERSION,
  GITHUB_WORK_QUEUE_VIEW_VERSION,
  parseEventLogCore,
  projectQueueView,
  type GithubWorkEventLogCore,
} from '../../core/state-daemon/github-work-event-log-core'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'github-work-p1-contract')
const SCHEMA_PATH = join(REPO_ROOT, 'schemas', 'github-work-event-log-core-v1.schema.json')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
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

  test('F3 - QueueView projector preserves GitHub SSOT and P1 no-mutation evidence', () => {
    const rawEvents = fixture('F3-queue-view-events.json') as unknown[]
    const events: GithubWorkEventLogCore[] = rawEvents.map((raw) => {
      const parsed = parseEventLogCore(raw)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
      return parsed.event
    })

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
    })
    expect(view.event_count).toBe(2)
    expect(view.blocker_codes).toEqual(['duplicate_fingerprint'])
  })

  test('F4 - contract-only surface pin keeps P1 out of daemon/scheduler/AUN runner paths', () => {
    const gates = fixture('F4-merge-gates.json') as {
      lane: string
      merge_gates: string[]
      runtime_wiring_forbidden: string[]
      forbidden_surfaces: string[]
    }
    expect(gates.lane).toBe('P1_contract_only')
    expect(gates.merge_gates).toEqual([
      'F1_EVENT_LOG_CORE_SCHEMA_PARSER',
      'F2_FORBIDDEN_SCOPE_REJECTION',
      'F3_QUEUE_VIEW_PROJECTOR',
      'F4_CONTRACT_ONLY_SURFACE_PIN',
    ])
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
