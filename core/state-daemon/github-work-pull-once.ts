import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_ROLE_OWNER_MAP,
  classifyGithubWorkItem,
  githubWorkFingerprint,
  type GithubWorkClassification,
  type GithubWorkItem,
  type GithubWorkKind,
  type GithubWorkPullerConfig,
} from './github-work-puller'
import { classifyProtectedSurface } from './github-work-event-log-core'

export const GITHUB_WORK_PULL_ONCE_SCHEMA_VERSION = 'github_work_pull_once_v1' as const
export const GITHUB_WORK_PULL_ONCE_COMMENT_MARKER = '<!-- aun:github-work-pull-once/v1 -->'

export type GithubWorkPullOnceWritebackMode = 'none' | 'github-comment'
export type GithubWorkPullOnceAction = 'discover' | 'claim' | 'result'
export type GithubWorkPullOnceStatus =
  | 'dry_run'
  | 'would_claim'
  | 'claim_requested'
  | 'claim_won'
  | 'claim_lost'
  | 'result_posted'
  | 'duplicate_suppressed'
  | 'blocked'
  | 'dispatch_failed'
  | 'no_match'

export interface GithubWorkPullOnceInput {
  repo: string
  label: string
  ownerAllowlist: string[]
  targetNumber: number | null
  targetKind: GithubWorkKind | null
  writebackMode: GithubWorkPullOnceWritebackMode
  action: GithubWorkPullOnceAction
  actorSeat: string
  ownerDecisionUrl: string | null
  execute: boolean
  now: string
  resultSummary?: string | null
}

export interface GithubWorkPullOnceComment {
  id: string
  body: string
  createdAt: string
  author: string | null
}

export interface GithubWorkPullOnceEvent {
  schema_version: typeof GITHUB_WORK_PULL_ONCE_SCHEMA_VERSION
  lane: 'P2_github_pull_once'
  event_type: 'claim.requested' | 'claim.won' | 'claim.lost' | 'result.posted' | 'work.blocked'
  event_id: string
  repo: string
  kind: GithubWorkKind
  number: number
  url: string
  work_key: string
  fingerprint: string
  claim_id: string | null
  claimant_seat: string | null
  github_created_at: string | null
  confirmed_winner_claim_id: string | null
  status: GithubWorkPullOnceStatus
  owner_decision_url: string | null
  blocker_codes: string[]
  mutation_performed: boolean
  live_github_api_performed: boolean
  db_queue_mutation_performed: boolean
  token_used: boolean
  result_summary?: string | null
}

export interface GithubWorkPullOnceCandidate {
  item: GithubWorkItem
  classification: GithubWorkClassification
  protectedSurface: {
    protected_surface_classified: boolean
    owner_decision_required: boolean
    claim_allowed: boolean
    blocker_codes: string[]
    protected_surface_reasons: string[]
  }
  existingEvents: GithubWorkPullOnceEvent[]
  status: GithubWorkPullOnceStatus
  blockerCodes: string[]
  claimId: string | null
  wouldPostComment: boolean
}

export interface GithubWorkPullOncePlan {
  schema_version: typeof GITHUB_WORK_PULL_ONCE_SCHEMA_VERSION
  lane: 'P2_github_pull_once'
  input: GithubWorkPullOnceInput
  ok: boolean
  go_no_go: 'GO_DRY_RUN' | 'GO_EXECUTE' | 'NO_GO'
  status: GithubWorkPullOnceStatus
  scanned: number
  matched: number
  selected: GithubWorkPullOnceCandidate | null
  candidates: GithubWorkPullOnceCandidate[]
  blocker_codes: string[]
  events_to_post: GithubWorkPullOnceEvent[]
  evidence: {
    dry_run: boolean
    mutation_performed: boolean
    live_github_api_performed: boolean
    db_queue_mutation_performed: boolean
    queue_claim_process_completion_performed: boolean
    token_used: boolean
    token_value_disclosed: boolean
    daemon_or_scheduler_touched: boolean
    aun_runner_touched: boolean
    repo_settings_changed: boolean
    workflow_changed: boolean
    deploy_changed: boolean
    p1_f1_f4_contracts_remain_required: true
  }
}

export interface GithubWorkPullOnceFixture {
  items: GithubWorkItem[]
  comments?: Record<string, GithubWorkPullOnceComment[]>
}

export interface GithubWorkPullOnceClient {
  listOpenWorkItems(config: GithubWorkPullerConfig): Promise<GithubWorkItem[]>
  listEventComments(item: GithubWorkItem): Promise<GithubWorkPullOnceComment[]>
  postEventComment(item: GithubWorkItem, body: string): Promise<{ id: string; createdAt: string; url?: string | null }>
}

export function buildGithubWorkPullOnceInput(raw: {
  repo?: string
  label?: string
  ownerAllowlist?: string[]
  targetNumber?: number | null
  targetKind?: GithubWorkKind | null
  writebackMode?: string | null
  action?: string | null
  actorSeat?: string | null
  ownerDecisionUrl?: string | null
  execute?: boolean
  now?: string | null
  resultSummary?: string | null
}): GithubWorkPullOnceInput {
  const writebackMode = raw.writebackMode === 'github-comment' ? 'github-comment' : 'none'
  const action = raw.action === 'claim' || raw.action === 'result' ? raw.action : 'discover'
  return {
    repo: raw.repo?.trim() ?? '',
    label: raw.label?.trim() ?? '',
    ownerAllowlist: raw.ownerAllowlist ?? [],
    targetNumber: raw.targetNumber ?? null,
    targetKind: raw.targetKind ?? null,
    writebackMode,
    action,
    actorSeat: raw.actorSeat?.trim() || 'aun',
    ownerDecisionUrl: raw.ownerDecisionUrl?.trim() || null,
    execute: raw.execute === true,
    now: raw.now?.trim() || new Date().toISOString(),
    resultSummary: raw.resultSummary ?? null,
  }
}

export function loadGithubWorkPullOnceFixture(path: string): GithubWorkPullOnceFixture {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as GithubWorkPullOnceFixture
  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
    comments: parsed.comments && typeof parsed.comments === 'object' ? parsed.comments : {},
  }
}

export function planGithubWorkPullOnce(
  input: GithubWorkPullOnceInput,
  items: GithubWorkItem[],
  commentsByWorkKey: Record<string, GithubWorkPullOnceComment[]> = {},
): GithubWorkPullOncePlan {
  const scopeBlockers = validateGithubWorkPullOnceScope(input)
  const config: GithubWorkPullerConfig = {
    repos: [input.repo],
    labels: [input.label],
    ownerAllowlist: input.ownerAllowlist,
    roleOwnerMap: DEFAULT_ROLE_OWNER_MAP,
    intervalMs: 0,
    githubWritebackEnabled: input.writebackMode === 'github-comment',
  }
  const candidates = items
    .filter((item) => item.repo === input.repo)
    .filter((item) => input.targetNumber === null || item.number === input.targetNumber)
    .filter((item) => input.targetKind === null || item.kind === input.targetKind)
    .filter((item) => item.labels.map(normalizeLabel).includes(normalizeLabel(input.label)))
    .map((item) => candidateFromItem(input, config, item, commentsByWorkKey[workKey(item)] ?? []))

  const selected = candidates[0] ?? null
  const blockerCodes = [...scopeBlockers]
  if (items.length === 0) blockerCodes.push('fixture_or_client_items_required')
  if (candidates.length === 0 && scopeBlockers.length === 0) blockerCodes.push('no_matching_github_work_item')
  if (selected) blockerCodes.push(...selected.blockerCodes)
  const uniqueBlockers = Array.from(new Set(blockerCodes)).sort()
  const status = scopeBlockers.length > 0
    ? 'blocked'
    : selected?.status ?? (uniqueBlockers.length > 0 ? 'blocked' : 'no_match')
  const ok = uniqueBlockers.length === 0 && selected !== null
  const eventsToPost = ok && selected && selected.claimId && selected.status === 'would_claim'
    ? [buildPullOnceEvent(input, selected, 'claim.requested', 'claim_requested', selected.claimId, null)]
    : []
  return {
    schema_version: GITHUB_WORK_PULL_ONCE_SCHEMA_VERSION,
    lane: 'P2_github_pull_once',
    input,
    ok,
    go_no_go: ok ? (input.execute ? 'GO_EXECUTE' : 'GO_DRY_RUN') : 'NO_GO',
    status,
    scanned: items.length,
    matched: candidates.length,
    selected,
    candidates,
    blocker_codes: uniqueBlockers,
    events_to_post: eventsToPost,
    evidence: evidenceFor(input),
  }
}

export async function runGithubWorkPullOnce(
  input: GithubWorkPullOnceInput,
  client: GithubWorkPullOnceClient,
): Promise<GithubWorkPullOncePlan> {
  const config: GithubWorkPullerConfig = {
    repos: [input.repo],
    labels: [input.label],
    ownerAllowlist: input.ownerAllowlist,
    roleOwnerMap: DEFAULT_ROLE_OWNER_MAP,
    intervalMs: 0,
    githubWritebackEnabled: input.writebackMode === 'github-comment',
  }
  const items = await client.listOpenWorkItems(config)
  const commentsByWorkKey: Record<string, GithubWorkPullOnceComment[]> = {}
  for (const item of items) {
    commentsByWorkKey[workKey(item)] = await client.listEventComments(item)
  }
  const plan = planGithubWorkPullOnce(input, items, commentsByWorkKey)
  if (!input.execute || !plan.ok || !plan.selected) return plan
  if (input.writebackMode !== 'github-comment') {
    return withExecutionFailure(plan, 'github_comment_writeback_required_for_execute')
  }
  try {
    for (const event of plan.events_to_post) {
      const posted = await client.postEventComment(plan.selected.item, renderGithubWorkPullOnceEventComment(event))
      event.github_created_at = posted.createdAt
    }
    const reread = await client.listEventComments(plan.selected.item)
    const events = reread
      .map((comment) => parseGithubWorkPullOnceEventComment(comment.body))
      .filter((event): event is GithubWorkPullOnceEvent => event !== null)
    const winner = electGithubWorkPullOnceWinner(events, plan.selected.item, input.now)
    if (winner === plan.selected.claimId) {
      const won = buildPullOnceEvent(input, plan.selected, 'claim.won', 'claim_won', winner, winner)
      const postedWon = await client.postEventComment(plan.selected.item, renderGithubWorkPullOnceEventComment(won))
      won.github_created_at = postedWon.createdAt
      plan.events_to_post.push(won)
      if (input.action === 'result') {
        const result = buildPullOnceEvent(input, plan.selected, 'result.posted', 'result_posted', winner, winner)
        const postedResult = await client.postEventComment(plan.selected.item, renderGithubWorkPullOnceEventComment(result))
        result.github_created_at = postedResult.createdAt
        plan.events_to_post.push(result)
        plan.status = 'result_posted'
      } else {
        plan.status = 'claim_won'
      }
      return plan
    }
    const lost = buildPullOnceEvent(input, plan.selected, 'claim.lost', 'claim_lost', plan.selected.claimId, winner)
    const postedLost = await client.postEventComment(plan.selected.item, renderGithubWorkPullOnceEventComment(lost))
    lost.github_created_at = postedLost.createdAt
    plan.events_to_post.push(lost)
    plan.status = 'duplicate_suppressed'
    plan.blocker_codes = ['claim_lost_to_earlier_valid_claim']
    plan.ok = false
    plan.go_no_go = 'NO_GO'
    return plan
  } catch (err) {
    return withExecutionFailure(plan, err instanceof Error ? err.message : String(err))
  }
}

export function renderGithubWorkPullOnceEventComment(event: GithubWorkPullOnceEvent): string {
  return [
    GITHUB_WORK_PULL_ONCE_COMMENT_MARKER,
    '',
    '```json',
    JSON.stringify(event, null, 2),
    '```',
  ].join('\n')
}

export function parseGithubWorkPullOnceEventComment(body: string): GithubWorkPullOnceEvent | null {
  if (!body.includes(GITHUB_WORK_PULL_ONCE_COMMENT_MARKER)) return null
  const match = body.match(/```json\s*([\s\S]*?)\s*```/m)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as GithubWorkPullOnceEvent
    return parsed.schema_version === GITHUB_WORK_PULL_ONCE_SCHEMA_VERSION ? parsed : null
  } catch {
    return null
  }
}

export function isGithubWorkPullOnceSelfComment(body: unknown): boolean {
  return typeof body === 'string' && body.includes(GITHUB_WORK_PULL_ONCE_COMMENT_MARKER)
}

export function formatGithubWorkPullOncePlanText(plan: GithubWorkPullOncePlan): string {
  const selected = plan.selected
  return [
    `GitHub work pull-once: ${plan.go_no_go}`,
    `status: ${plan.status}`,
    `repo: ${plan.input.repo}`,
    `label: ${plan.input.label}`,
    `target: ${plan.input.targetKind ?? 'any'}#${plan.input.targetNumber ?? 'any'}`,
    `scanned: ${plan.scanned}`,
    `matched: ${plan.matched}`,
    `selected: ${selected ? `${selected.item.repo}#${selected.item.number}` : 'none'}`,
    `owner: ${selected?.classification.owner ?? 'none'}`,
    `route: ${selected?.classification.route ?? 'none'}`,
    `protected: ${String(selected?.classification.protected ?? false)}`,
    `blockers: ${plan.blocker_codes.length ? plan.blocker_codes.join(',') : 'none'}`,
    `mutation_performed: ${String(plan.evidence.mutation_performed)}`,
    `live_github_api_performed: ${String(plan.evidence.live_github_api_performed)}`,
    `db_queue_mutation_performed: ${String(plan.evidence.db_queue_mutation_performed)}`,
    `token_used: ${String(plan.evidence.token_used)}`,
  ].join('\n') + '\n'
}

function validateGithubWorkPullOnceScope(input: GithubWorkPullOnceInput): string[] {
  const blockers: string[] = []
  if (!/^[^/\s,]+\/[^/\s,]+$/.test(input.repo)) blockers.push('single_repo_required')
  if (!input.label) blockers.push('single_label_required')
  if (input.label.includes(',')) blockers.push('single_label_required')
  if (!normalizeLabel(input.label).startsWith('canary:')) blockers.push('canary_label_required')
  if (input.ownerAllowlist.length !== 1) blockers.push('single_owner_allowlist_required')
  if (!input.targetNumber && !normalizeLabel(input.label).startsWith('canary:')) {
    blockers.push('target_issue_or_canary_selector_required')
  }
  if (input.writebackMode !== 'none' && input.writebackMode !== 'github-comment') {
    blockers.push('writeback_mode_invalid')
  }
  if (input.execute) {
    if (!input.ownerDecisionUrl) blockers.push('owner_decision_url_required_for_execute')
    if (input.writebackMode !== 'github-comment') blockers.push('github_comment_writeback_required_for_execute')
  }
  return blockers
}

function candidateFromItem(
  input: GithubWorkPullOnceInput,
  config: GithubWorkPullerConfig,
  item: GithubWorkItem,
  comments: GithubWorkPullOnceComment[],
): GithubWorkPullOnceCandidate {
  const classification = classifyGithubWorkItem(item, config)
  const protectedSurface = classifyProtectedSurface({
    declared_protected_surface: false,
    title: item.title,
    body: item.body ?? '',
    labels: item.labels,
    changed_paths: [],
    declared_operations: ['github_comment_eventlog_claim', input.action === 'result' ? 'github_comment_result_post' : 'github_comment_claim'],
    route_labels: item.labels.filter((label) => normalizeLabel(label).startsWith('route:') || normalizeLabel(label).startsWith('runner:')),
    owner_decision_url: input.ownerDecisionUrl,
  })
  const existingEvents = comments
    .map((comment) => parseGithubWorkPullOnceEventComment(comment.body))
    .filter((event): event is GithubWorkPullOnceEvent => event !== null)
    .filter((event) => event.fingerprint === githubWorkFingerprint(item))
  const blockerCodes = [
    ...(classification.dispatchBlocker ? [classification.dispatchBlocker] : []),
    ...(classification.protected ? ['protected_route_blocked'] : []),
    ...protectedSurface.blocker_codes,
  ]
  if (existingEvents.some((event) => event.event_type === 'claim.won' || event.event_type === 'result.posted')) {
    return {
      item,
      classification,
      protectedSurface,
      existingEvents,
      status: 'duplicate_suppressed',
      blockerCodes: ['duplicate_claim_or_result'],
      claimId: null,
      wouldPostComment: false,
    }
  }
  const claimAllowed = blockerCodes.length === 0 && classification.dispatchable && protectedSurface.claim_allowed
  const claimId = claimAllowed ? deterministicClaimId(input, item) : null
  return {
    item,
    classification,
    protectedSurface,
    existingEvents,
    status: claimAllowed ? 'would_claim' : 'blocked',
    blockerCodes,
    claimId,
    wouldPostComment: claimAllowed,
  }
}

function buildPullOnceEvent(
  input: GithubWorkPullOnceInput,
  candidate: GithubWorkPullOnceCandidate,
  eventType: GithubWorkPullOnceEvent['event_type'],
  status: GithubWorkPullOnceStatus,
  claimId: string | null,
  confirmedWinnerClaimId: string | null,
): GithubWorkPullOnceEvent {
  const item = candidate.item
  return {
    schema_version: GITHUB_WORK_PULL_ONCE_SCHEMA_VERSION,
    lane: 'P2_github_pull_once',
    event_type: eventType,
    event_id: deterministicEventId(input, item, eventType),
    repo: item.repo,
    kind: item.kind,
    number: item.number,
    url: item.url,
    work_key: workKey(item),
    fingerprint: githubWorkFingerprint(item),
    claim_id: claimId,
    claimant_seat: input.actorSeat,
    github_created_at: input.execute ? null : input.now,
    confirmed_winner_claim_id: confirmedWinnerClaimId,
    status,
    owner_decision_url: input.ownerDecisionUrl,
    blocker_codes: candidate.blockerCodes,
    mutation_performed: input.execute,
    live_github_api_performed: input.execute,
    db_queue_mutation_performed: false,
    token_used: input.execute,
    result_summary: eventType === 'result.posted' ? input.resultSummary ?? 'confirmed winning claim result' : null,
  }
}

function electGithubWorkPullOnceWinner(
  events: GithubWorkPullOnceEvent[],
  item: GithubWorkItem,
  now: string,
): string | null {
  const fingerprint = githubWorkFingerprint(item)
  const claims = events
    .filter((event) => event.event_type === 'claim.requested')
    .filter((event) => event.fingerprint === fingerprint)
    .filter((event) => event.claim_id)
    .sort((a, b) => {
      const createdA = a.github_created_at ?? now
      const createdB = b.github_created_at ?? now
      const byCreated = createdA.localeCompare(createdB)
      return byCreated !== 0 ? byCreated : String(a.claim_id).localeCompare(String(b.claim_id))
    })
  return claims[0]?.claim_id ?? null
}

function withExecutionFailure(plan: GithubWorkPullOncePlan, reason: string): GithubWorkPullOncePlan {
  const blocked = plan.selected
    ? buildPullOnceEvent(plan.input, { ...plan.selected, blockerCodes: ['dispatch_failed'] }, 'work.blocked', 'dispatch_failed', plan.selected.claimId, null)
    : null
  if (blocked) blocked.result_summary = reason
  return {
    ...plan,
    ok: false,
    go_no_go: 'NO_GO',
    status: 'dispatch_failed',
    blocker_codes: Array.from(new Set([...plan.blocker_codes, 'dispatch_failed'])).sort(),
    events_to_post: [
      ...plan.events_to_post,
      ...(blocked ? [blocked] : []),
    ],
  }
}

function evidenceFor(input: GithubWorkPullOnceInput): GithubWorkPullOncePlan['evidence'] {
  return {
    dry_run: !input.execute,
    mutation_performed: false,
    live_github_api_performed: false,
    db_queue_mutation_performed: false,
    queue_claim_process_completion_performed: false,
    token_used: false,
    token_value_disclosed: false,
    daemon_or_scheduler_touched: false,
    aun_runner_touched: false,
    repo_settings_changed: false,
    workflow_changed: false,
    deploy_changed: false,
    p1_f1_f4_contracts_remain_required: true,
  }
}

function deterministicClaimId(input: GithubWorkPullOnceInput, item: GithubWorkItem): string {
  return createHash('sha256')
    .update([input.actorSeat, workKey(item), githubWorkFingerprint(item), input.now].join('\0'))
    .digest('hex')
    .slice(0, 20)
}

function deterministicEventId(input: GithubWorkPullOnceInput, item: GithubWorkItem, eventType: string): string {
  return createHash('sha256')
    .update([eventType, input.actorSeat, workKey(item), githubWorkFingerprint(item), input.now].join('\0'))
    .digest('hex')
    .slice(0, 24)
}

function workKey(item: GithubWorkItem): string {
  return `${item.repo}#${item.number}`
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-')
}
