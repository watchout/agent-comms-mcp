import { describe, expect, test } from 'bun:test'
import {
  buildProtectedGateAdvancePlan,
} from '../core/pr-protected-gate-advance'
import { PR_CONVEYOR_TRANSITIONS } from '../core/pr-conveyor'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const AVAILABLE_LABELS = Array.from(new Set(
  Object.values(PR_CONVEYOR_TRANSITIONS).flatMap((transition) => [
    ...transition.add,
    ...transition.remove,
  ]),
))

function checks(overrides: Array<{ name: string; status?: string; conclusion?: string }> = []) {
  const base = [
    { name: 'Layer 0 — machine gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'Audit signal (async)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'Auto-merge (CI green)', status: 'COMPLETED', conclusion: 'SKIPPED' },
  ]
  return base.map((check) => ({
    ...check,
    ...overrides.find((override) => override.name === check.name),
  }))
}

function plan(overrides: Partial<Parameters<typeof buildProtectedGateAdvancePlan>[0]> = {}) {
  return buildProtectedGateAdvancePlan({
    prNumber: 785,
    prUrl: 'https://github.com/watchout/agent-comms-mcp/pull/785',
    state: 'OPEN',
    isDraft: true,
    expectedHead: HEAD,
    currentHead: HEAD,
    mergeStateStatus: 'CLEAN',
    route: 'ceo-approval',
    labels: ['route:ceo-approval'],
    availableLabels: AVAILABLE_LABELS,
    checks: checks(),
    evidenceUrl: 'https://github.com/watchout/agent-comms-mcp/pull/785',
    dryRun: true,
    repo: 'watchout/agent-comms-mcp',
    ...overrides,
  })
}

describe('protected PR gate auto-advance', () => {
  test('green protected PR plans exact-head impl-to-l2 conveyor labels', () => {
    const result = plan()

    expect(result.ok).toBe(true)
    expect(result.transition).toBe('impl-to-l2')
    expect(result.conveyor_plan?.add_labels).toEqual([
      'audit-pending',
      'audit:l2-pending',
      'needs:l2-audit',
      'state:impl-l2',
    ])
    expect(result.gh_command).toEqual([
      'gh',
      'pr',
      'edit',
      '785',
      '--repo',
      'watchout/agent-comms-mcp',
      '--add-label',
      'audit-pending,audit:l2-pending,needs:l2-audit,state:impl-l2',
    ])
    expect(result.mutation_performed).toBe(false)
  })

  test('draft status does not block L2 gate auto-advance', () => {
    expect(plan({ isDraft: true }).ok).toBe(true)
  })

  test('fails closed when required checks are not green', () => {
    const result = plan({
      checks: checks([{ name: 'Layer 0 — machine gate', status: 'IN_PROGRESS', conclusion: '' }]),
    })

    expect(result.ok).toBe(false)
    expect(result.blocker?.code).toBe('required_check_not_green')
    expect(result.gh_command).toEqual([])
  })

  test('does not rewrite PRs that already moved into a review or rework state', () => {
    const pending = plan({ labels: ['route:ceo-approval', 'needs:l2-audit'] })
    const passed = plan({ labels: ['route:ceo-approval', 'audit:l2-passed', 'evidence-ready'] })
    const rework = plan({ labels: ['route:ceo-approval', 'needs:rework', 'state:rework'] })

    expect(pending.blocker?.code).toBe('already_advanced')
    expect(passed.blocker?.code).toBe('already_advanced')
    expect(rework.blocker?.code).toBe('already_advanced')
  })

  test('fails closed on stale head, non-protected route, or dirty merge state', () => {
    expect(plan({ currentHead: 'fedcba9876543210fedcba9876543210fedcba98' }).blocker?.code).toBe('exact_head_mismatch')
    expect(plan({ route: 'fast-merge' }).blocker?.code).toBe('route_not_protected')
    expect(plan({ mergeStateStatus: 'DIRTY' }).blocker?.code).toBe('merge_state_not_clean')
  })
})
