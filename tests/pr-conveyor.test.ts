import { describe, expect, test } from 'bun:test'
import {
  buildPrConveyorPlan,
  PR_CONVEYOR_TRANSITIONS,
} from '../core/pr-conveyor'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER_HEAD = 'fedcba9876543210fedcba9876543210fedcba98'
const AVAILABLE_LABELS = Array.from(new Set(
  Object.values(PR_CONVEYOR_TRANSITIONS).flatMap((transition) => [
    ...transition.add,
    ...transition.remove,
  ]),
))

describe('PR conveyor exact-head label controller', () => {
  test('fails closed when the current PR head does not match the expected exact head', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: OTHER_HEAD,
      transition: 'l2-pass',
      currentLabels: ['audit:l2-pending', 'needs:l2-audit', 'state:impl-l2'],
      availableLabels: AVAILABLE_LABELS,
      evidenceUrl: 'https://github.com/watchout/agent-comms-mcp/pull/750#issuecomment-1',
    })

    expect(plan.ok).toBe(false)
    expect(plan.blocker?.code).toBe('exact_head_mismatch')
    expect(plan.add_labels).toEqual([])
    expect(plan.remove_labels).toEqual([])
    expect(plan.audit_route).toBeNull()
    expect(plan.gh_command).toEqual([])
  })

  test('l2-pass removes stale L2 pending state and plans the exact-head evidence labels', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'l2-pass',
      currentLabels: [
        'audit:l2-pending',
        'needs:l2-audit',
        'state:impl-l2',
        'changes-requested',
        'route:ceo-approval',
      ],
      availableLabels: AVAILABLE_LABELS,
      evidenceUrl: 'https://github.com/watchout/agent-comms-mcp/pull/750#issuecomment-1',
    })

    expect(plan.ok).toBe(true)
    expect(plan.add_labels).toEqual(['audit:l2-passed', 'evidence-ready'])
    expect(plan.remove_labels).toEqual([
      'audit:l2-pending',
      'changes-requested',
      'needs:l2-audit',
      'state:impl-l2',
    ])
    expect(plan.audit_route).toMatchObject({
      active_function: 'evidence_audit_gate',
      canonical_seat: 'codex-audit',
      agent_id: 'codex-audit',
      route_kind: 'evidence_audit_gate',
      historical_input: true,
    })
    expect(plan.gh_command).toEqual([
      'gh',
      'pr',
      'edit',
      '750',
      '--add-label',
      'audit:l2-passed,evidence-ready',
      '--remove-label',
      'audit:l2-pending,changes-requested,needs:l2-audit,state:impl-l2',
    ])
  })

  test('impl-to-l2 keeps already-desired L2 labels while removing stale rework labels', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'impl-to-l2',
      currentLabels: [
        'audit:l2-pending',
        'needs:l2-audit',
        'state:impl-l2',
        'needs:rework',
        'state:rework',
      ],
      availableLabels: AVAILABLE_LABELS,
    })

    expect(plan.ok).toBe(true)
    expect(plan.add_labels).toEqual(['audit-pending'])
    expect(plan.remove_labels).toEqual(['needs:rework', 'state:rework'])
    expect(plan.audit_route).toMatchObject({
      active_function: 'evidence_audit_gate',
      canonical_seat: 'codex-audit',
      agent_id: 'codex-audit',
    })
  })

  test('needs-rework moves passed or ready PRs back to implementation rework', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'needs-rework',
      currentLabels: [
        'audit:l2-passed',
        'evidence-ready',
        'merge-ready',
        'state:merge-ready',
      ],
      availableLabels: AVAILABLE_LABELS,
    })

    expect(plan.ok).toBe(true)
    expect(plan.add_labels).toEqual([
      'audit:changes-requested',
      'changes-requested',
      'needs:rework',
      'state:rework',
    ])
    expect(plan.remove_labels).toEqual([
      'audit:l2-passed',
      'evidence-ready',
      'merge-ready',
      'state:merge-ready',
    ])
  })

  test('fails closed when repository label vocabulary is missing a required target label', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'check-pass',
      currentLabels: ['audit:l2-passed'],
      availableLabels: AVAILABLE_LABELS.filter((label) => label !== 'merge-ready'),
    })

    expect(plan.ok).toBe(false)
    expect(plan.blocker?.code).toBe('required_label_missing')
    expect(plan.blocker?.details).toEqual({ missing: ['merge-ready'] })
  })

  test('rejects abbreviated heads because stale evidence must be exact-head', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: '09ab463',
      currentHead: HEAD,
      transition: 'l2-pass',
      currentLabels: [],
      availableLabels: AVAILABLE_LABELS,
    })

    expect(plan.ok).toBe(false)
    expect(plan.blocker?.code).toBe('invalid_expected_head')
  })
})
