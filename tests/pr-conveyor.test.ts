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
    expect(plan.gh_command).toEqual([])
  })

  test('audit-pass removes stale audit state and routes to QA', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'audit-pass',
      currentLabels: [
        'audit:l2-pending',
        'audit:l3-required',
        'needs:l2-audit',
        'state:impl-l2',
        'changes-requested',
        'route:ceo-approval',
      ],
      availableLabels: AVAILABLE_LABELS,
      evidenceUrl: 'https://github.com/watchout/agent-comms-mcp/pull/750#issuecomment-1',
    })

    expect(plan.ok).toBe(true)
    expect(plan.add_labels).toEqual(['audit:l2-passed', 'needs:qa', 'state:qa'])
    expect(plan.remove_labels).toEqual([
      'audit:l2-pending',
      'audit:l3-required',
      'changes-requested',
      'needs:l2-audit',
      'state:impl-l2',
    ])
    expect(plan.gh_command).toEqual([
      'gh',
      'pr',
      'edit',
      '750',
      '--add-label',
      'audit:l2-passed,needs:qa,state:qa',
      '--remove-label',
      'audit:l2-pending,audit:l3-required,changes-requested,needs:l2-audit,state:impl-l2',
    ])
  })

  test('l2-pass remains a compatibility alias for audit-pass', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'l2-pass',
      currentLabels: ['audit:l2-pending', 'needs:l2-audit', 'state:impl-l2'],
      availableLabels: AVAILABLE_LABELS,
    })

    expect(plan.ok).toBe(true)
    expect(plan.add_labels).toEqual(['audit:l2-passed', 'needs:qa', 'state:qa'])
    expect(plan.remove_labels).toEqual([
      'audit:l2-pending',
      'needs:l2-audit',
      'state:impl-l2',
    ])
  })

  test('qa-pass moves exact-head QA evidence to check', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'qa-pass',
      currentLabels: [
        'audit:l2-passed',
        'needs:qa',
        'state:qa',
        'audit:l1-pending',
        'needs:l1-audit',
      ],
      availableLabels: AVAILABLE_LABELS,
    })

    expect(plan.ok).toBe(true)
    expect(plan.add_labels).toEqual(['needs:check', 'state:check'])
    expect(plan.remove_labels).toEqual([
      'audit:l1-pending',
      'needs:l1-audit',
      'needs:qa',
      'state:qa',
    ])
  })

  test('check-pass defaults to merge-ready without requesting L3 review', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'check-pass',
      currentLabels: ['needs:check', 'state:check', 'audit:l2-passed'],
      availableLabels: AVAILABLE_LABELS,
    })

    expect(plan.ok).toBe(true)
    expect(plan.add_labels).toEqual(['merge-ready', 'state:merge-ready'])
    expect(plan.remove_labels).toEqual(['needs:check', 'state:check'])
  })

  test('check-pass-cto explicitly routes high-risk checks to CTO', () => {
    const plan = buildPrConveyorPlan({
      prNumber: 750,
      expectedHead: HEAD,
      currentHead: HEAD,
      transition: 'check-pass-cto',
      currentLabels: ['needs:check', 'state:check', 'evidence-ready'],
      availableLabels: AVAILABLE_LABELS,
    })

    expect(plan.ok).toBe(true)
    expect(plan.add_labels).toEqual(['needs:cto', 'state:cto'])
    expect(plan.remove_labels).toEqual([
      'evidence-ready',
      'needs:check',
      'state:check',
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
