import {
  buildGhPrEditCommand,
  buildPrConveyorPlan,
  type PrConveyorPlan,
} from './pr-conveyor'

export type ProtectedGateCheck = {
  name: string
  status: string
  conclusion: string
}

export type ProtectedGateAdvanceInput = {
  prNumber: number
  prUrl?: string
  state: string
  isDraft: boolean
  expectedHead: string
  currentHead: string
  mergeStateStatus: string
  route: string
  labels: string[]
  availableLabels?: string[]
  checks: ProtectedGateCheck[]
  evidenceUrl?: string
  dryRun?: boolean
  repo?: string
}

export type ProtectedGateAdvanceBlockerCode =
  | 'invalid_pr_number'
  | 'invalid_expected_head'
  | 'exact_head_mismatch'
  | 'pr_not_open'
  | 'route_not_protected'
  | 'merge_state_not_clean'
  | 'required_check_not_green'
  | 'already_advanced'
  | 'conveyor_blocked'

export type ProtectedGateAdvancePlan = {
  ok: boolean
  dry_run: boolean
  pr_number: number
  pr_url?: string
  expected_head: string
  current_head: string
  route: string
  state: string
  is_draft: boolean
  merge_state_status: string
  current_labels: string[]
  checks: ProtectedGateCheck[]
  transition: 'impl-to-l2' | null
  conveyor_plan: PrConveyorPlan | null
  gh_command: string[]
  blocker: null | {
    code: ProtectedGateAdvanceBlockerCode
    message: string
    details?: Record<string, unknown>
  }
  mutation_performed: false
}

const PROTECTED_ROUTES = new Set(['ceo-approval', 'protected', 'route:ceo-approval', 'route:protected'])
const REQUIRED_GREEN_CHECKS = ['Layer 0 — machine gate', 'Audit signal (async)']
const ADVANCED_LABELS = new Set([
  'needs:l2-audit',
  'audit:l2-pending',
  'state:impl-l2',
  'audit:l2-passed',
  'audit:l3-pending',
  'audit:l3-passed',
  'evidence-ready',
  'merge-ready',
  'state:merge-ready',
  'needs:l3-review',
  'audit:changes-requested',
  'changes-requested',
  'needs:rework',
  'state:rework',
  'audit:blocked',
  'blocked-stop-lane',
])

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function blocker(
  input: ProtectedGateAdvanceInput,
  code: ProtectedGateAdvanceBlockerCode,
  message: string,
  details?: Record<string, unknown>,
): ProtectedGateAdvancePlan {
  return {
    ok: false,
    dry_run: input.dryRun !== false,
    pr_number: input.prNumber,
    pr_url: input.prUrl,
    expected_head: input.expectedHead,
    current_head: input.currentHead,
    route: input.route,
    state: input.state,
    is_draft: input.isDraft,
    merge_state_status: input.mergeStateStatus,
    current_labels: sortedUnique(input.labels),
    checks: input.checks,
    transition: null,
    conveyor_plan: null,
    gh_command: [],
    blocker: { code, message, details },
    mutation_performed: false,
  }
}

function checkByName(checks: ProtectedGateCheck[], name: string): ProtectedGateCheck | null {
  return checks.find((check) => check.name === name) ?? null
}

export function buildProtectedGateAdvancePlan(input: ProtectedGateAdvanceInput): ProtectedGateAdvancePlan {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return blocker(input, 'invalid_pr_number', 'prNumber must be a positive integer')
  }
  if (!/^[0-9a-f]{40}$/i.test(input.expectedHead)) {
    return blocker(input, 'invalid_expected_head', 'expectedHead must be a full 40-character git SHA')
  }
  if (input.currentHead !== input.expectedHead) {
    return blocker(input, 'exact_head_mismatch', 'current PR head does not match expected exact head', {
      expected: input.expectedHead,
      current: input.currentHead,
    })
  }
  if (input.state !== 'OPEN') {
    return blocker(input, 'pr_not_open', 'protected gate auto-advance only applies to open pull requests', {
      state: input.state,
    })
  }
  if (!PROTECTED_ROUTES.has(input.route)) {
    return blocker(input, 'route_not_protected', 'auto-advance is limited to protected route PRs', {
      route: input.route,
    })
  }
  if (input.mergeStateStatus !== 'CLEAN') {
    return blocker(input, 'merge_state_not_clean', 'protected gate auto-advance requires a clean merge state', {
      merge_state_status: input.mergeStateStatus,
    })
  }

  const missingOrFailedChecks = REQUIRED_GREEN_CHECKS
    .map((name) => checkByName(input.checks, name) ?? { name, status: 'MISSING', conclusion: 'MISSING' })
    .filter((check) => check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS')
  if (missingOrFailedChecks.length > 0) {
    return blocker(input, 'required_check_not_green', 'protected gate auto-advance requires green machine checks', {
      checks: missingOrFailedChecks,
    })
  }

  const advancedLabels = input.labels.filter((label) => ADVANCED_LABELS.has(label)).sort()
  if (advancedLabels.length > 0) {
    return blocker(input, 'already_advanced', 'PR already has review/gate state labels; auto-advance will not rewrite it', {
      labels: advancedLabels,
    })
  }

  const conveyorPlan = buildPrConveyorPlan({
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    expectedHead: input.expectedHead,
    currentHead: input.currentHead,
    transition: 'impl-to-l2',
    currentLabels: input.labels,
    availableLabels: input.availableLabels,
    evidenceUrl: input.evidenceUrl,
    dryRun: input.dryRun,
  })
  if (!conveyorPlan.ok) {
    return blocker(input, 'conveyor_blocked', 'underlying PR conveyor transition failed closed', {
      conveyor_blocker: conveyorPlan.blocker,
    })
  }
  const ghCommand = buildGhPrEditCommand(input.prNumber, conveyorPlan.add_labels, conveyorPlan.remove_labels, input.repo)
  return {
    ok: true,
    dry_run: input.dryRun !== false,
    pr_number: input.prNumber,
    pr_url: input.prUrl,
    expected_head: input.expectedHead,
    current_head: input.currentHead,
    route: input.route,
    state: input.state,
    is_draft: input.isDraft,
    merge_state_status: input.mergeStateStatus,
    current_labels: sortedUnique(input.labels),
    checks: input.checks,
    transition: 'impl-to-l2',
    conveyor_plan: {
      ...conveyorPlan,
      gh_command: ghCommand,
    },
    gh_command: ghCommand,
    blocker: null,
    mutation_performed: false,
  }
}
