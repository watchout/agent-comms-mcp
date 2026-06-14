import { createHash } from 'node:crypto'
import type { DBClient } from './types'

export type GithubWorkKind = 'issue' | 'pull_request'
export type GithubWorkRoute = 'fast' | 'protected' | 'manual'
export type GithubRunnerPolicy =
  | 'codex_native_fast_lane'
  | 'claude_code_autonomous_lane'
  | 'headless_runtime_adapter_lane'
  | 'governed_manual_lane'
  | 'stop_lane'

export interface GithubWorkItem {
  repo: string
  kind: GithubWorkKind
  number: number
  nodeId: string
  title: string
  url: string
  updatedAt: string
  labels: string[]
  body?: string | null
  author?: string | null
  lastActivityId?: string | null
}

export interface GithubWorkPullerConfig {
  repos: string[]
  labels: string[]
  ownerAllowlist: string[] | null
  roleOwnerMap: Record<string, string>
  intervalMs: number
  githubWritebackEnabled: boolean
}

export interface GithubWorkClassification {
  item: GithubWorkItem
  fingerprint: string
  role: string | null
  owner: string | null
  route: GithubWorkRoute
  runnerPolicy: GithubRunnerPolicy
  labelMatches: string[]
  blockedLabels: string[]
  protected: boolean
  autonomousExecutionAllowed: boolean
  phaseGoalPresent: boolean
  dispatchable: boolean
  dispatchBlocker: string | null
}

export interface GithubWorkDispatchResult {
  classification: GithubWorkClassification
  status: 'queued' | 'duplicate_suppressed' | 'blocked' | 'dispatch_failed'
  queueId: string | null
  error?: string
}

export interface GithubWorkPullerTickResult {
  scanned: number
  matched: number
  queued: number
  duplicateSuppressed: number
  blocked: number
  dispatchFailed: number
  results: GithubWorkDispatchResult[]
}

export interface GithubWorkClient {
  listOpenWorkItems(config: GithubWorkPullerConfig): Promise<GithubWorkItem[]>
  writeDispatchEvidence?(input: GithubWorkWritebackInput): Promise<void>
}

export interface GithubWorkWritebackInput {
  classification: GithubWorkClassification
  status: GithubWorkDispatchResult['status']
  queueId: string | null
  error?: string
}

const ROLE_LABEL_PREFIX = 'needs:'
const OWNER_LABEL_PREFIX = 'owner:'
const ROUTE_LABEL_PREFIX = 'route:'
const RUNNER_LABEL_PREFIX = 'runner:'
const BLOCKED_LABEL_PREFIX = 'blocked:'

export const DEFAULT_GITHUB_WORK_PULLER_INTERVAL_MS = 120_000

export const DEFAULT_ROLE_OWNER_MAP: Record<string, string> = {
  spec: 'codex-aun',
  arc: 'codex-aun',
  impl: 'agent-com-dev',
  implementation: 'agent-com-dev',
  audit: 'codex-audit',
  qa: 'qa',
  check: 'check',
  cto: 'codex-cto',
  ceo: 'ceo',
}

export function parseGithubWorkPullerCsv(value: string | undefined): string[] | null {
  if (!value) return null
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean)
  return parsed.length > 0 ? parsed : null
}

export function parseGithubWorkPullerBool(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

export function parseGithubWorkPullerRoleMap(value: string | undefined): Record<string, string> {
  if (!value) return DEFAULT_ROLE_OWNER_MAP
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_ROLE_OWNER_MAP
    const out: Record<string, string> = { ...DEFAULT_ROLE_OWNER_MAP }
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw === 'string' && key.trim() && raw.trim()) {
        out[normalizeLabelValue(key)] = raw.trim()
      }
    }
    return out
  } catch {
    return DEFAULT_ROLE_OWNER_MAP
  }
}

export function loadGithubWorkPullerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GithubWorkPullerConfig {
  const interval = Number(env.STATE_DAEMON_GITHUB_WORK_INTERVAL_MS)
  return {
    repos: parseGithubWorkPullerCsv(env.STATE_DAEMON_GITHUB_WORK_REPOS) ?? [],
    labels: parseGithubWorkPullerCsv(env.STATE_DAEMON_GITHUB_WORK_LABELS) ?? [
      'needs:arc',
      'needs:impl',
      'needs:audit',
      'needs:qa',
      'needs:check',
      'needs:cto',
    ],
    ownerAllowlist: parseGithubWorkPullerCsv(env.STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST),
    roleOwnerMap: parseGithubWorkPullerRoleMap(env.STATE_DAEMON_GITHUB_WORK_ROLE_OWNER_MAP_JSON),
    intervalMs: Number.isFinite(interval) && interval > 0
      ? Math.round(interval)
      : DEFAULT_GITHUB_WORK_PULLER_INTERVAL_MS,
    githubWritebackEnabled: parseGithubWorkPullerBool(env.STATE_DAEMON_GITHUB_WORK_WRITEBACK_ENABLED),
  }
}

export function githubWorkPullerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseGithubWorkPullerBool(env.STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED)
}

export function classifyGithubWorkItem(
  item: GithubWorkItem,
  config: GithubWorkPullerConfig,
): GithubWorkClassification {
  const labels = item.labels.map((label) => label.trim()).filter(Boolean)
  const normalized = labels.map(normalizeLabelValue)
  const configuredLabels = new Set(config.labels.map(normalizeLabelValue))
  const labelMatches = labels.filter((label) => configuredLabels.has(normalizeLabelValue(label)))
  const role = firstPrefixed(normalized, ROLE_LABEL_PREFIX)
  const ownerFromLabel = firstPrefixed(labels, OWNER_LABEL_PREFIX)
  const ownerFromRole = role ? config.roleOwnerMap[role] ?? null : null
  const owner = ownerFromLabel ?? ownerFromRole
  const routeLabel = firstPrefixed(normalized, ROUTE_LABEL_PREFIX)
  const blockedLabels = labels.filter((label) => normalizeLabelValue(label).startsWith(BLOCKED_LABEL_PREFIX))
  const runnerLabel = firstPrefixed(normalized, RUNNER_LABEL_PREFIX)
  const route = resolveRoute(role, routeLabel, blockedLabels)
  const protectedRoute = route === 'protected' || role === 'cto' || role === 'ceo'
  const runnerPolicy = resolveRunnerPolicy(runnerLabel, route)
  const phaseGoalPresent = hasPhaseGoal(item.body ?? '')
  const autonomousExecutionAllowed = route === 'fast'
    && runnerPolicy !== 'stop_lane'
    && runnerPolicy !== 'governed_manual_lane'
    && phaseGoalPresent
  const ownerAllowed = owner !== null
    && (config.ownerAllowlist === null || config.ownerAllowlist.includes(owner))
  const dispatchBlocker = labelMatches.length === 0
    ? 'no_configured_label_match'
    : owner === null
      ? 'missing_owner'
      : !ownerAllowed
        ? 'owner_not_allowlisted'
        : null

  return {
    item,
    fingerprint: githubWorkFingerprint(item),
    role,
    owner,
    route,
    runnerPolicy,
    labelMatches,
    blockedLabels,
    protected: protectedRoute,
    autonomousExecutionAllowed,
    phaseGoalPresent,
    dispatchable: dispatchBlocker === null,
    dispatchBlocker,
  }
}

export function githubWorkFingerprint(item: GithubWorkItem): string {
  const raw = [
    item.repo,
    item.kind,
    item.nodeId,
    item.number,
    item.updatedAt,
    item.lastActivityId ?? '',
  ].join('\0')
  return createHash('sha256').update(raw).digest('hex')
}

export class RestGithubWorkClient implements GithubWorkClient {
  constructor(
    private readonly options: {
      token?: string
      fetchImpl?: typeof fetch
      perRepoLimit?: number
      userAgent?: string
    } = {},
  ) {}

  async listOpenWorkItems(config: GithubWorkPullerConfig): Promise<GithubWorkItem[]> {
    const items: GithubWorkItem[] = []
    for (const repo of config.repos) {
      items.push(...await this.listRepo(repo, config))
    }
    return items
  }

  private async listRepo(repo: string, config: GithubWorkPullerConfig): Promise<GithubWorkItem[]> {
    const url = new URL(`https://api.github.com/repos/${repo}/issues`)
    url.searchParams.set('state', 'open')
    url.searchParams.set('sort', 'updated')
    url.searchParams.set('direction', 'desc')
    url.searchParams.set('per_page', String(this.options.perRepoLimit ?? 50))
    const raw = await this.githubFetch<any[]>(url)
    const out: GithubWorkItem[] = []
    for (const entry of raw) {
      const item = fromRestIssue(repo, entry)
      if (!item) continue
      if (!hasConfiguredLabel(item, config)) continue
      try {
        item.lastActivityId = await this.fetchLastActivityId(repo, entry)
      } catch {
        item.lastActivityId = null
      }
      out.push(item)
    }
    return out
  }

  async writeDispatchEvidence(input: GithubWorkWritebackInput): Promise<void> {
    const item = input.classification.item
    const url = new URL(`https://api.github.com/repos/${item.repo}/issues/${item.number}/comments`)
    await this.githubFetch(url, {
      method: 'POST',
      body: JSON.stringify({ body: renderGithubWorkWriteback(input) }),
    })
  }

  private async fetchLastActivityId(repo: string, raw: any): Promise<string | null> {
    const ids: string[] = []
    if (raw?.comments_url && Number(raw.comments) > 0) {
      const url = new URL(String(raw.comments_url))
      url.searchParams.set('per_page', '1')
      url.searchParams.set('page', String(Number(raw.comments)))
      const comments = await this.githubFetch<any[]>(url)
      const last = comments[0]
      const id = last?.node_id ?? last?.id
      if (id != null) ids.push(`comment:${String(id)}`)
    }
    if (raw?.pull_request) {
      const reviewsUrl = new URL(`https://api.github.com/repos/${repo}/pulls/${Number(raw.number)}/reviews`)
      reviewsUrl.searchParams.set('per_page', '100')
      const reviews = await this.githubFetch<any[]>(reviewsUrl)
      const last = reviews[reviews.length - 1]
      const id = last?.node_id ?? last?.id
      if (id != null) ids.push(`review:${String(id)}`)
    }
    return ids.length > 0 ? ids.join('|') : null
  }

  private async githubFetch<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.options.userAgent ?? 'agent-comms-state-daemon-github-work-puller',
      ...(init.headers as Record<string, string> | undefined),
    }
    if (init.body) headers['Content-Type'] = 'application/json'
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`
    const response = await fetchImpl(url, { ...init, headers })
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} ${response.statusText} for ${url}`)
    }
    return await response.json() as T
  }
}

function hasConfiguredLabel(item: GithubWorkItem, config: GithubWorkPullerConfig): boolean {
  const labels = new Set(item.labels.map(normalizeLabelValue))
  return config.labels.some((label) => labels.has(normalizeLabelValue(label)))
}

export class StateDaemonGithubWorkPuller {
  constructor(
    private readonly deps: {
      db: DBClient
      client: GithubWorkClient
      config: GithubWorkPullerConfig
      source?: string
    },
  ) {}

  async pollOnce(): Promise<GithubWorkPullerTickResult> {
    if (this.deps.config.repos.length === 0) {
      return emptyTick()
    }
    const items = await this.deps.client.listOpenWorkItems(this.deps.config)
    const results: GithubWorkDispatchResult[] = []
    for (const item of items) {
      const classification = classifyGithubWorkItem(item, this.deps.config)
      if (classification.labelMatches.length === 0) continue
      results.push(await this.dispatch(classification))
    }
    return summarizeTick(items.length, results)
  }

  private async dispatch(classification: GithubWorkClassification): Promise<GithubWorkDispatchResult> {
    if (!classification.dispatchable || !classification.owner) {
      await this.insertAudit('github_work.blocked', classification, null, {
        blocker: classification.dispatchBlocker,
      })
      const result: GithubWorkDispatchResult = { classification, status: 'blocked', queueId: null }
      await this.maybeWriteback(result)
      return result
    }

    const db = this.deps.db
    try {
      await db.query('BEGIN')
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [classification.fingerprint])
      const existing = await db.query(
        `SELECT 1 FROM audit_log
          WHERE event_type = 'github_work.dispatch_attempt'
            AND detail->>'fingerprint' = $1
          LIMIT 1`,
        [classification.fingerprint],
      )
      if ((existing.rowCount ?? existing.rows.length) > 0) {
        await db.query('COMMIT')
        return { classification, status: 'duplicate_suppressed', queueId: null }
      }

      const payload = this.buildQueuePayload(classification)
      const inserted = await db.query<{ id: number | string }>(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority)
          VALUES ($1, NULL, $2, 'pending', $3)
          RETURNING id`,
        [
          classification.owner,
          JSON.stringify(payload),
          classification.protected ? 20 : 10,
        ],
      )
      const queueId = inserted.rows[0]?.id != null ? String(inserted.rows[0].id) : null
      await this.insertAudit('github_work.dispatch_attempt', classification, queueId, {
        dispatch_status: 'queued',
      })
      await db.query('COMMIT')
      const result: GithubWorkDispatchResult = { classification, status: 'queued', queueId }
      await this.maybeWriteback(result)
      return result
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      await this.insertAudit('github_work.dispatch_failed', classification, null, {
        dispatch_status: 'failed',
        error: message,
      }).catch(() => {})
      const result: GithubWorkDispatchResult = { classification, status: 'dispatch_failed', queueId: null, error: message }
      await this.maybeWriteback(result)
      return result
    }
  }

  private async maybeWriteback(result: GithubWorkDispatchResult): Promise<void> {
    if (!this.deps.config.githubWritebackEnabled || !this.deps.client.writeDispatchEvidence) return
    try {
      await this.deps.client.writeDispatchEvidence({
        classification: result.classification,
        status: result.status,
        queueId: result.queueId,
        error: result.error,
      })
      await this.insertAudit('github_work.writeback', result.classification, result.queueId, {
        dispatch_status: result.status,
        writeback_status: 'ok',
      })
    } catch (err) {
      await this.insertAudit('github_work.writeback_failed', result.classification, result.queueId, {
        dispatch_status: result.status,
        writeback_status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {})
    }
  }

  private buildQueuePayload(classification: GithubWorkClassification): Record<string, unknown> {
    const item = classification.item
    return {
      source: this.deps.source ?? 'state-daemon-github-work-puller',
      message_type: 'github_work',
      channel_id: `github://${item.repo}`,
      author_id: 'state-daemon',
      content: renderGithubWorkNotification(classification),
      github: {
        repo: item.repo,
        kind: item.kind,
        number: item.number,
        node_id: item.nodeId,
        url: item.url,
        updated_at: item.updatedAt,
        last_activity_id: item.lastActivityId ?? null,
      },
      github_url: item.url,
      role: classification.role,
      owner: classification.owner,
      route: classification.route,
      runner_policy: classification.runnerPolicy,
      protected: classification.protected,
      autonomous_execution_allowed: classification.autonomousExecutionAllowed,
      phase_goal_present: classification.phaseGoalPresent,
      label_matches: classification.labelMatches,
      blocked_labels: classification.blockedLabels,
      fingerprint: classification.fingerprint,
      ssot: 'github',
      aun_is_acceleration_only: true,
      completion_evidence_not_accepted: ['aun_ack', 'queue_id', 'discord_projection', 'tui_visibility', 'green_ci_alone'],
    }
  }

  private async insertAudit(
    eventType: string,
    classification: GithubWorkClassification,
    queueId: string | null,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
        VALUES ($1, $2, $3, $4, $5)`,
      [
        eventType,
        classification.owner,
        classification.item.url,
        JSON.stringify({
          source: this.deps.source ?? 'state-daemon-github-work-puller',
          repo: classification.item.repo,
          kind: classification.item.kind,
          number: classification.item.number,
          node_id: classification.item.nodeId,
          github_url: classification.item.url,
          updated_at: classification.item.updatedAt,
          last_activity_id: classification.item.lastActivityId ?? null,
          fingerprint: classification.fingerprint,
          role: classification.role,
          owner: classification.owner,
          route: classification.route,
          runner_policy: classification.runnerPolicy,
          protected: classification.protected,
          autonomous_execution_allowed: classification.autonomousExecutionAllowed,
          phase_goal_present: classification.phaseGoalPresent,
          label_matches: classification.labelMatches,
          blocked_labels: classification.blockedLabels,
          queue_id: queueId,
          ssot: 'github',
          aun_is_acceleration_only: true,
          ...extra,
        }),
        'default',
      ],
    )
  }
}

export function renderGithubWorkNotification(classification: GithubWorkClassification): string {
  const item = classification.item
  const mode = classification.protected
    ? 'Protected route: surface only; do not approve, merge, deploy, or live-activate without required gate.'
    : 'Routine route: treat GitHub as SSOT and write evidence back to the linked issue/PR.'
  return [
    `GitHub work item detected: ${item.repo}#${item.number}`,
    `URL: ${item.url}`,
    `Role: ${classification.role ?? 'unknown'}`,
    `Owner: ${classification.owner ?? 'unresolved'}`,
    `Route: ${classification.route}`,
    `Runner policy: ${classification.runnerPolicy}`,
    mode,
  ].join('\n')
}

export function renderGithubWorkWriteback(input: GithubWorkWritebackInput): string {
  const c = input.classification
  const lines = [
    '## AUN GitHub Work Puller Evidence',
    '',
    `Source: state-daemon-github-work-puller`,
    `Status: ${input.status}`,
    `Queue ID: ${input.queueId ?? 'none'}`,
    `Owner: ${c.owner ?? 'unresolved'}`,
    `Role: ${c.role ?? 'unknown'}`,
    `Route: ${c.route}`,
    `Runner policy: ${c.runnerPolicy}`,
    `Protected: ${String(c.protected)}`,
    `Autonomous execution allowed: ${String(c.autonomousExecutionAllowed)}`,
    `Fingerprint: ${c.fingerprint}`,
    '',
    'GitHub remains the SSOT. AUN queue rows are notification/acceleration only and are not completion evidence.',
  ]
  if (input.error) lines.splice(3, 0, `Error: ${input.error}`)
  return lines.join('\n')
}

function fromRestIssue(repo: string, raw: any): GithubWorkItem | null {
  if (!raw || typeof raw !== 'object') return null
  const number = Number(raw.number)
  if (!Number.isFinite(number)) return null
  const labels = Array.isArray(raw.labels)
    ? raw.labels
      .map((label: any) => typeof label === 'string' ? label : label?.name)
      .filter((label: any): label is string => typeof label === 'string' && label.trim().length > 0)
    : []
  return {
    repo,
    kind: raw.pull_request ? 'pull_request' : 'issue',
    number,
    nodeId: String(raw.node_id ?? `${repo}#${number}`),
    title: String(raw.title ?? ''),
    url: String(raw.html_url ?? `https://github.com/${repo}/issues/${number}`),
    updatedAt: String(raw.updated_at ?? new Date(0).toISOString()),
    labels,
    body: typeof raw.body === 'string' ? raw.body : null,
    author: typeof raw.user?.login === 'string' ? raw.user.login : null,
    lastActivityId: raw.comments ? `comments:${raw.comments}` : null,
  }
}

function summarizeTick(scanned: number, results: GithubWorkDispatchResult[]): GithubWorkPullerTickResult {
  return {
    scanned,
    matched: results.length,
    queued: results.filter((result) => result.status === 'queued').length,
    duplicateSuppressed: results.filter((result) => result.status === 'duplicate_suppressed').length,
    blocked: results.filter((result) => result.status === 'blocked').length,
    dispatchFailed: results.filter((result) => result.status === 'dispatch_failed').length,
    results,
  }
}

function emptyTick(): GithubWorkPullerTickResult {
  return {
    scanned: 0,
    matched: 0,
    queued: 0,
    duplicateSuppressed: 0,
    blocked: 0,
    dispatchFailed: 0,
    results: [],
  }
}

function resolveRoute(role: string | null, routeLabel: string | null, blockedLabels: string[]): GithubWorkRoute {
  if (blockedLabels.length > 0) return 'protected'
  if (routeLabel === 'protected') return 'protected'
  if (routeLabel === 'fast') return 'fast'
  if (role === 'cto' || role === 'ceo') return 'protected'
  if (role === 'audit' || role === 'qa' || role === 'check') return 'protected'
  return 'manual'
}

function resolveRunnerPolicy(runnerLabel: string | null, route: GithubWorkRoute): GithubRunnerPolicy {
  if (route === 'protected') return 'stop_lane'
  switch (runnerLabel) {
    case 'codex':
      return 'codex_native_fast_lane'
    case 'claude-code':
    case 'claude_code':
      return 'claude_code_autonomous_lane'
    case 'headless-adapter':
    case 'headless_adapter':
      return 'headless_runtime_adapter_lane'
    case 'manual':
      return 'governed_manual_lane'
    case 'stop':
      return 'stop_lane'
    default:
      return route === 'fast' ? 'codex_native_fast_lane' : 'governed_manual_lane'
  }
}

function hasPhaseGoal(body: string): boolean {
  const required = [
    '## Goal',
    '## Scope',
    '## Non-scope',
    '## Acceptance Criteria',
    '## Stop Conditions',
    '## Required Evidence',
  ]
  return required.every((section) => body.includes(section))
}

function firstPrefixed(labels: string[], prefix: string): string | null {
  for (const label of labels) {
    const normalized = normalizeLabelValue(label)
    if (normalized.startsWith(prefix)) {
      const value = label.slice(prefix.length).trim()
      return value ? normalizeLabelValue(value) : null
    }
  }
  return null
}

function normalizeLabelValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}
