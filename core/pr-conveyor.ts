export type PrConveyorTransition =
  | 'impl-to-l2'
  | 'audit-pass'
  | 'l2-pass'
  | 'qa-pass'
  | 'needs-rework'
  | 'check-pass'
  | 'check-pass-cto'
  | 'cto-go'
  | 'blocked'

export type PrConveyorBlockerCode =
  | 'invalid_pr_number'
  | 'invalid_expected_head'
  | 'unknown_transition'
  | 'exact_head_mismatch'
  | 'required_label_missing'

export type PrConveyorPlan = {
  ok: boolean
  dry_run: boolean
  pr_number: number
  pr_url?: string
  expected_head: string
  current_head: string
  transition: string
  evidence_url?: string
  current_labels: string[]
  add_labels: string[]
  remove_labels: string[]
  gh_command: string[]
  blocker: null | {
    code: PrConveyorBlockerCode
    message: string
    details?: Record<string, unknown>
  }
}

export type BuildPrConveyorPlanInput = {
  prNumber: number
  prUrl?: string
  expectedHead: string
  currentHead: string
  transition: string
  currentLabels: string[]
  availableLabels?: string[]
  evidenceUrl?: string
  dryRun?: boolean
}

type TransitionSpec = {
  add: string[]
  remove: string[]
}

const STATE_LABELS = [
  'state:impl',
  'state:impl-l1',
  'state:impl-l2',
  'state:impl-l3',
  'state:qa',
  'state:check',
  'state:cto',
  'state:ceo-approval',
  'state:merge-ready',
  'state:blocked',
  'state:rework',
  'state:done',
]

const NEEDS_LABELS = [
  'needs:l1-audit',
  'needs:l2-audit',
  'needs:l3-review',
  'needs:qa',
  'needs:check',
  'needs:cto',
  'needs:ceo-approval',
  'needs:implementation',
  'needs:rework',
]

const AUDIT_PENDING_LABELS = [
  'audit:l1-pending',
  'audit:l2-pending',
  'audit:l3-pending',
]

const AUDIT_REQUIRED_LABELS = [
  'audit:l2-required',
  'audit:l3-required',
]

const AUDIT_PASS_LABELS = [
  'audit:l1-passed',
  'audit:l2-passed',
  'audit:l3-passed',
  'audit-passed',
]

const REVIEW_BLOCK_LABELS = [
  'audit:blocked',
  'audit:changes-requested',
  'blocked-stop-lane',
  'changes-requested',
]

const READINESS_LABELS = [
  'audit-pending',
  'evidence-ready',
  'merge-ready',
  'implementing',
  'rework-implementing',
]

function unique(labels: string[]): string[] {
  return Array.from(new Set(labels))
}

function resetConveyorLabels(): string[] {
  return unique([
    ...STATE_LABELS,
    ...NEEDS_LABELS,
    ...AUDIT_PENDING_LABELS,
    ...AUDIT_REQUIRED_LABELS,
    ...REVIEW_BLOCK_LABELS,
    ...READINESS_LABELS,
  ])
}

const AUDIT_PASS_TO_QA: TransitionSpec = {
  add: ['audit:l2-passed', 'needs:qa', 'state:qa'],
  remove: unique([
    ...AUDIT_PENDING_LABELS,
    ...AUDIT_REQUIRED_LABELS,
    'audit:changes-requested',
    'changes-requested',
    'audit-pending',
    'evidence-ready',
    'needs:l1-audit',
    'needs:l2-audit',
    'needs:l3-review',
    'needs:rework',
    'state:impl-l1',
    'state:impl-l2',
    'state:impl-l3',
    'state:rework',
    'rework-implementing',
  ]),
}

export const PR_CONVEYOR_TRANSITIONS: Record<PrConveyorTransition, TransitionSpec> = {
  'impl-to-l2': {
    add: ['audit:l2-pending', 'needs:l2-audit', 'state:impl-l2', 'audit-pending'],
    remove: resetConveyorLabels(),
  },
  'audit-pass': AUDIT_PASS_TO_QA,
  'l2-pass': AUDIT_PASS_TO_QA,
  'qa-pass': {
    add: ['needs:check', 'state:check'],
    remove: unique([
      ...AUDIT_PENDING_LABELS,
      ...AUDIT_REQUIRED_LABELS,
      'audit:changes-requested',
      'changes-requested',
      'audit-pending',
      'evidence-ready',
      'needs:l1-audit',
      'needs:l2-audit',
      'needs:l3-review',
      'needs:qa',
      'needs:rework',
      'state:impl-l1',
      'state:impl-l2',
      'state:impl-l3',
      'state:qa',
      'state:rework',
      'rework-implementing',
    ]),
  },
  'needs-rework': {
    add: ['audit:changes-requested', 'changes-requested', 'needs:rework', 'state:rework'],
    remove: unique([
      ...AUDIT_PENDING_LABELS,
      ...AUDIT_PASS_LABELS,
      'audit-pending',
      'evidence-ready',
      'merge-ready',
      'needs:l1-audit',
      'needs:l2-audit',
      'needs:l3-review',
      'needs:qa',
      'needs:check',
      'needs:cto',
      'state:impl-l1',
      'state:impl-l2',
      'state:impl-l3',
      'state:qa',
      'state:check',
      'state:cto',
      'state:merge-ready',
    ]),
  },
  'check-pass': {
    add: ['merge-ready', 'state:merge-ready'],
    remove: unique([
      'evidence-ready',
      'audit-pending',
      'needs:l1-audit',
      'needs:l2-audit',
      'needs:l3-review',
      'needs:qa',
      'needs:check',
      'needs:cto',
      'state:impl-l1',
      'state:impl-l2',
      'state:impl-l3',
      'state:qa',
      'state:check',
      'state:cto',
      'audit:changes-requested',
      'changes-requested',
    ]),
  },
  'check-pass-cto': {
    add: ['needs:cto', 'state:cto'],
    remove: unique([
      'evidence-ready',
      'audit-pending',
      'merge-ready',
      'needs:l1-audit',
      'needs:l2-audit',
      'needs:l3-review',
      'needs:qa',
      'needs:check',
      'state:impl-l1',
      'state:impl-l2',
      'state:impl-l3',
      'state:qa',
      'state:check',
      'state:merge-ready',
      'audit:changes-requested',
      'changes-requested',
    ]),
  },
  'cto-go': {
    add: ['merge-ready', 'state:merge-ready'],
    remove: unique([
      'audit:l3-pending',
      'needs:l3-review',
      'needs:cto',
      'state:impl-l3',
      'state:cto',
      'state:ceo-approval',
      'needs:ceo-approval',
      'audit:changes-requested',
      'changes-requested',
      'blocked-stop-lane',
    ]),
  },
  blocked: {
    add: ['audit:blocked', 'blocked-stop-lane', 'state:blocked'],
    remove: unique([
      ...AUDIT_PENDING_LABELS,
      'audit-passed',
      'evidence-ready',
      'merge-ready',
      ...NEEDS_LABELS,
      'state:impl-l1',
      'state:impl-l2',
      'state:impl-l3',
      'state:qa',
      'state:check',
      'state:cto',
      'state:merge-ready',
    ]),
  },
}

function blocker(
  input: BuildPrConveyorPlanInput,
  code: PrConveyorBlockerCode,
  message: string,
  details?: Record<string, unknown>,
): PrConveyorPlan {
  return {
    ok: false,
    dry_run: input.dryRun !== false,
    pr_number: input.prNumber,
    pr_url: input.prUrl,
    expected_head: input.expectedHead,
    current_head: input.currentHead,
    transition: input.transition,
    evidence_url: input.evidenceUrl,
    current_labels: unique(input.currentLabels).sort(),
    add_labels: [],
    remove_labels: [],
    gh_command: [],
    blocker: { code, message, details },
  }
}

export function buildGhPrEditCommand(prNumber: number, addLabels: string[], removeLabels: string[], repo?: string): string[] {
  const command = ['gh', 'pr', 'edit', String(prNumber)]
  if (repo) command.push('--repo', repo)
  if (addLabels.length > 0) command.push('--add-label', addLabels.join(','))
  if (removeLabels.length > 0) command.push('--remove-label', removeLabels.join(','))
  return command
}

export function buildPrConveyorPlan(input: BuildPrConveyorPlanInput): PrConveyorPlan {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return blocker(input, 'invalid_pr_number', 'prNumber must be a positive integer')
  }
  if (!/^[0-9a-f]{40}$/i.test(input.expectedHead)) {
    return blocker(input, 'invalid_expected_head', 'expectedHead must be a full 40-character git SHA')
  }
  const spec = PR_CONVEYOR_TRANSITIONS[input.transition as PrConveyorTransition]
  if (!spec) {
    return blocker(input, 'unknown_transition', `unknown transition: ${input.transition}`, {
      allowed: Object.keys(PR_CONVEYOR_TRANSITIONS),
    })
  }
  if (input.currentHead !== input.expectedHead) {
    return blocker(input, 'exact_head_mismatch', 'current PR head does not match expected exact head', {
      expected: input.expectedHead,
      current: input.currentHead,
    })
  }

  const current = new Set(input.currentLabels)
  const desiredLabels = new Set(unique(spec.add))
  const addLabels = unique(spec.add).filter((label) => !current.has(label)).sort()
  const removeLabels = unique(spec.remove)
    .filter((label) => current.has(label) && !desiredLabels.has(label))
    .sort()

  if (input.availableLabels) {
    const available = new Set(input.availableLabels)
    const missing = addLabels.filter((label) => !available.has(label))
    if (missing.length > 0) {
      return blocker(input, 'required_label_missing', 'transition requires labels that do not exist in the repository', {
        missing,
      })
    }
  }

  return {
    ok: true,
    dry_run: input.dryRun !== false,
    pr_number: input.prNumber,
    pr_url: input.prUrl,
    expected_head: input.expectedHead,
    current_head: input.currentHead,
    transition: input.transition,
    evidence_url: input.evidenceUrl,
    current_labels: unique(input.currentLabels).sort(),
    add_labels: addLabels,
    remove_labels: removeLabels,
    gh_command: buildGhPrEditCommand(input.prNumber, addLabels, removeLabels),
    blocker: null,
  }
}
