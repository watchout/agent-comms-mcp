export type ConveyorEvidenceRole = 'audit' | 'qa' | 'check' | 'cto'

export type ConveyorEvidenceMarker =
  | 'audit-result/v1'
  | 'qa-result/v1'
  | 'check-result/v1'
  | 'cto-result/v1'
  | 'cto-gate/v1'

export type ConveyorVerdict =
  | 'PASS'
  | 'NO-GO'
  | 'HOLD'
  | 'CONDITIONAL GO'
  | 'GO'
  | 'REJECT'
  | 'UNKNOWN'

export interface PhaseEvidenceComment {
  body: string
  url?: string
  author?: string | null
  createdAt?: string | null
}

export interface ConveyorPhaseEvidence {
  marker: ConveyorEvidenceMarker
  role: ConveyorEvidenceRole
  repo: string | null
  pr: number | null
  issue: number | null
  phase: string | null
  verdict: ConveyorVerdict
  verdictRaw: string | null
  exactHead: string | null
  sourceHandoffUrl: string | null
  requiredFixes: string | null
  nextRole: string | null
  nonScope: string | null
  auditLevel: string | null
  url?: string
  author?: string | null
  createdAt?: string | null
  missingRequiredFields: string[]
  valid: boolean
}

export interface PhaseHandoffQueueRow {
  id: string | number
  agent_id: string
  status: string
  created_at?: string | null
  claimed_at?: string | null
  read_at?: string | null
  replied_at?: string | null
  done_at?: string | null
  failed_reason?: string | null
  payload: unknown
}

export interface ParsedPhaseHandoff {
  queueId: string
  agentId: string
  status: string
  repo: string | null
  pr: number | null
  issue: number | null
  phase: string | null
  targetRole: string | null
  exactHead: string | null
  sourceUrl: string | null
  requiredResponse: string | null
  dedupeKey: string | null
  ttlSeconds: number | null
  createdBy: string | null
  createdAt?: string | null
}

export type PhaseReconcileFindingCode =
  | 'superseded_by_github_evidence'
  | 'github_label_phase_drift'
  | 'phase_handoff_stalled'
  | 'missing_independent_phase_evidence'
  | 'invalid_phase_evidence'

export interface PhaseReconcileFinding {
  code: PhaseReconcileFindingCode
  severity: 'info' | 'warning' | 'blocker'
  message: string
  details: Record<string, unknown>
  suggestedCommand?: string
}

export interface AgentRuntimeStatus {
  agent_id: string
  status?: string | null
  runtime?: string | null
  last_seen_at?: string | null
}

export interface ReconcileWithGithubInput {
  repo: string
  pr: number
  currentHead: string
  labels: string[]
  comments: PhaseEvidenceComment[]
  queueRows?: PhaseHandoffQueueRow[]
  agentStatuses?: AgentRuntimeStatus[]
  now?: string | Date
  ttlSeconds?: number
}

export interface ReconcileWithGithubReport {
  repo: string
  pr: number
  current_head: string
  labels: string[]
  evidence: ConveyorPhaseEvidence[]
  handoffs: ParsedPhaseHandoff[]
  findings: PhaseReconcileFinding[]
}

const MARKER_ROLE: Record<ConveyorEvidenceMarker, ConveyorEvidenceRole> = {
  'audit-result/v1': 'audit',
  'qa-result/v1': 'qa',
  'check-result/v1': 'check',
  'cto-result/v1': 'cto',
  'cto-gate/v1': 'cto',
}

const ROLE_ORDER: Record<ConveyorEvidenceRole, number> = {
  audit: 1,
  qa: 2,
  check: 3,
  cto: 4,
}

const ACTIVE_QUEUE_STATUSES = new Set(['pending', 'received', 'in_progress'])

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function stripMarkdown(raw: string | undefined): string | null {
  if (raw === undefined) return null
  let value = raw.trim()
  value = value.replace(/^`+|`+$/g, '')
  value = value.replace(/^\*+|\*+$/g, '')
  value = value.replace(/^"+|"+$/g, '')
  value = value.trim()
  return value.length > 0 ? value : null
}

function parseIntField(raw: string | null): number | null {
  if (!raw) return null
  const match = raw.match(/\d+/)
  if (!match) return null
  const value = Number.parseInt(match[0], 10)
  return Number.isFinite(value) ? value : null
}

function normalizeVerdict(raw: string | null): ConveyorVerdict {
  if (!raw) return 'UNKNOWN'
  const upper = raw.replace(/\*/g, '').trim().toUpperCase()
  if (upper.includes('CONDITIONAL GO')) return 'CONDITIONAL GO'
  if (upper.includes('NO-GO') || upper.includes('NO GO')) return 'NO-GO'
  if (upper.includes('REJECT')) return 'REJECT'
  if (upper.includes('HOLD')) return 'HOLD'
  if (upper.includes('PASS')) return 'PASS'
  if (upper.includes('GO')) return 'GO'
  return 'UNKNOWN'
}

function extractMarker(body: string): ConveyorEvidenceMarker | null {
  const html = body.match(/<!--\s*conveyor:([a-z-]+\/v1)\s*-->/i)?.[1]
  const line = body.match(/^\s*conveyor:\s*([a-z-]+\/v1)\s*$/im)?.[1]
  const marker = (html ?? line)?.toLowerCase()
  if (
    marker === 'audit-result/v1'
    || marker === 'qa-result/v1'
    || marker === 'check-result/v1'
    || marker === 'cto-result/v1'
    || marker === 'cto-gate/v1'
  ) {
    return marker
  }
  return null
}

function parseKeyValues(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('- ')) continue
    const match = line.match(/^([A-Za-z][A-Za-z0-9 _-]{1,40}):\s*(.+)$/)
    if (!match) continue
    const key = normalizeKey(match[1])
    const value = stripMarkdown(match[2])
    if (value !== null && out[key] === undefined) out[key] = value
  }
  return out
}

function firstValue(values: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = values[key]
    if (value !== undefined) return value
  }
  return null
}

function validateEvidence(evidence: Omit<ConveyorPhaseEvidence, 'missingRequiredFields' | 'valid'>): string[] {
  const missing: string[] = []
  if (!evidence.repo) missing.push('repo')
  if (evidence.pr === null && evidence.issue === null) missing.push('pr_or_issue')
  if (!evidence.role) missing.push('role')
  if (!evidence.phase) missing.push('phase')
  if (evidence.verdict === 'UNKNOWN') missing.push('verdict')
  if (evidence.pr !== null && !evidence.exactHead) missing.push('exact_head')
  if (!evidence.sourceHandoffUrl) missing.push('source_handoff_url')
  if (!evidence.requiredFixes) missing.push('required_fixes')
  if (!evidence.nextRole) missing.push('next_role')
  if (!evidence.nonScope) missing.push('non_scope')
  return missing
}

export function parseConveyorPhaseEvidenceComment(comment: PhaseEvidenceComment): ConveyorPhaseEvidence | null {
  const marker = extractMarker(comment.body)
  if (!marker) return null
  const values = parseKeyValues(comment.body)
  const roleRaw = firstValue(values, ['role'])
  const role = roleRaw && ['audit', 'qa', 'check', 'cto'].includes(roleRaw.toLowerCase())
    ? roleRaw.toLowerCase() as ConveyorEvidenceRole
    : MARKER_ROLE[marker]
  const verdictRaw = firstValue(values, ['verdict', 'decision'])
  const evidence = {
    marker,
    role,
    repo: firstValue(values, ['repo', 'repository']),
    pr: parseIntField(firstValue(values, ['pr', 'pull_request'])),
    issue: parseIntField(firstValue(values, ['issue'])),
    phase: firstValue(values, ['phase']),
    verdict: normalizeVerdict(verdictRaw),
    verdictRaw,
    exactHead: firstValue(values, ['exact_head', 'head']),
    sourceHandoffUrl: firstValue(values, ['source_handoff_url', 'source_url', 'handoff_url']),
    requiredFixes: firstValue(values, ['required_fixes', 'required_before_merge']),
    nextRole: firstValue(values, ['next_role']),
    nonScope: firstValue(values, ['non_scope', 'nonscope']),
    auditLevel: firstValue(values, ['audit_level']),
    url: comment.url,
    author: comment.author ?? null,
    createdAt: comment.createdAt ?? null,
  }
  const missingRequiredFields = validateEvidence(evidence)
  return {
    ...evidence,
    missingRequiredFields,
    valid: missingRequiredFields.length === 0,
  }
}

export function parseConveyorPhaseEvidenceComments(comments: PhaseEvidenceComment[]): ConveyorPhaseEvidence[] {
  return comments
    .map(parseConveyorPhaseEvidenceComment)
    .filter((evidence): evidence is ConveyorPhaseEvidence => evidence !== null)
}

function safeJsonPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return { content: payload }
    }
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
}

function nestedObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') return parseIntField(value)
  return null
}

function extractGithubUrl(text: string): string | null {
  return text.match(/https:\/\/github\.com\/[^\s)]+/)?.[0] ?? null
}

function inferPhase(text: string, fallback: string | null): string | null {
  const lower = text.toLowerCase()
  if (lower.includes('l2') || lower.includes('l1') || lower.includes('audit')) return 'audit'
  if (lower.includes('qa')) return 'qa'
  if (lower.includes('check')) return 'check'
  if (lower.includes('cto') || lower.includes('l3')) return 'cto'
  return fallback
}

export function parsePhaseHandoffQueueRow(row: PhaseHandoffQueueRow): ParsedPhaseHandoff | null {
  const payload = safeJsonPayload(row.payload)
  const envelope = nestedObject(payload.phase_handoff) ?? (payload.kind === 'phase_handoff' ? payload : null)
  const content = asString(payload.content) ?? JSON.stringify(payload)
  const repoFromUrl = content.match(/github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\//)?.[1] ?? null
  const prFromUrl = parseIntField(content.match(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/)?.[1] ?? null)
  const issueFromUrl = parseIntField(content.match(/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/)?.[1] ?? null)
  const exactHeadFromText = content.match(/[0-9a-f]{40}/i)?.[0] ?? null
  const repo = asString(envelope?.repo) ?? repoFromUrl
  const pr = asNumber(envelope?.pr) ?? prFromUrl ?? parseIntField(content.match(/PR\s*#?(\d+)/i)?.[1] ?? null)
  const issue = asNumber(envelope?.issue) ?? issueFromUrl
  const phase = asString(envelope?.phase) ?? inferPhase(content, null)
  const sourceUrl = asString(envelope?.source_url) ?? extractGithubUrl(content)
  const exactHead = asString(envelope?.exact_head) ?? exactHeadFromText
  const targetRole = asString(envelope?.target_role) ?? asString(envelope?.target_agent_id) ?? row.agent_id
  const requiredResponse = asString(envelope?.required_response)
  const dedupeKey = asString(envelope?.dedupe_key)
  const ttlSeconds = asNumber(envelope?.ttl_seconds)
  const createdBy = asString(envelope?.created_by)

  if (!repo && pr === null && issue === null && !exactHead && !phase) return null
  return {
    queueId: String(row.id),
    agentId: row.agent_id,
    status: row.status,
    repo,
    pr,
    issue,
    phase,
    targetRole,
    exactHead,
    sourceUrl,
    requiredResponse,
    dedupeKey,
    ttlSeconds,
    createdBy,
    createdAt: row.created_at ?? null,
  }
}

function evidenceForHead(input: ReconcileWithGithubInput, evidence: ConveyorPhaseEvidence[]): ConveyorPhaseEvidence[] {
  return evidence.filter((item) => {
    return item.valid
      && item.repo === input.repo
      && item.pr === input.pr
      && item.exactHead === input.currentHead
  })
}

function latestByRole(evidence: ConveyorPhaseEvidence[]): Map<ConveyorEvidenceRole, ConveyorPhaseEvidence> {
  const byRole = new Map<ConveyorEvidenceRole, ConveyorPhaseEvidence>()
  for (const item of evidence) {
    const previous = byRole.get(item.role)
    const previousAt = previous?.createdAt ? Date.parse(previous.createdAt) : 0
    const itemAt = item.createdAt ? Date.parse(item.createdAt) : 0
    if (!previous || itemAt >= previousAt) byRole.set(item.role, item)
  }
  return byRole
}

function phaseToRole(phase: string | null): ConveyorEvidenceRole | null {
  if (!phase) return null
  const lower = phase.toLowerCase()
  if (lower.includes('audit') || lower.includes('l1') || lower.includes('l2') || lower.includes('l3')) return 'audit'
  if (lower.includes('qa')) return 'qa'
  if (lower.includes('check')) return 'check'
  if (lower.includes('cto')) return 'cto'
  return null
}

function auditLevelRank(text: string | null): number | null {
  if (!text) return null
  const match = text.match(/(?:^|[^a-z0-9])l\s*([123])(?:$|[^a-z0-9])/i)
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

function evidenceAuditRank(evidence: ConveyorPhaseEvidence): number | null {
  return auditLevelRank(evidence.auditLevel) ?? auditLevelRank(evidence.phase)
}

function evidenceSatisfiesAuditRank(evidence: ConveyorPhaseEvidence, requiredRank: number): boolean {
  const rank = evidenceAuditRank(evidence)
  return rank !== null && rank >= requiredRank
}

function isSamePrHead(input: ReconcileWithGithubInput, handoff: ParsedPhaseHandoff): boolean {
  return handoff.repo === input.repo
    && handoff.pr === input.pr
    && handoff.exactHead === input.currentHead
}

function evidenceSatisfiesHandoff(handoff: ParsedPhaseHandoff, evidence: ConveyorPhaseEvidence): boolean {
  const handoffRole = phaseToRole(handoff.phase)
  if (!handoffRole) return false
  if (ROLE_ORDER[evidence.role] > ROLE_ORDER[handoffRole]) return true
  if (evidence.role !== handoffRole) return false
  if (handoffRole !== 'audit') return true

  const requiredAuditRank = auditLevelRank(handoff.phase)
  if (requiredAuditRank === null) return true
  return evidenceSatisfiesAuditRank(evidence, requiredAuditRank)
}

function isLaterEvidence(handoff: ParsedPhaseHandoff, evidence: ConveyorPhaseEvidence): boolean {
  if (!handoff.createdAt || !evidence.createdAt) return true
  return Date.parse(evidence.createdAt) >= Date.parse(handoff.createdAt)
}

function prConveyorCommand(input: ReconcileWithGithubInput, transition: string, evidenceUrl?: string): string {
  const parts = [
    'bun scripts/pr-conveyor.ts',
    '--pr',
    String(input.pr),
    '--head',
    input.currentHead,
    '--transition',
    transition,
  ]
  if (evidenceUrl) parts.push('--evidence-url', evidenceUrl)
  return parts.join(' ')
}

export function reconcileWithGithub(input: ReconcileWithGithubInput): ReconcileWithGithubReport {
  const evidence = parseConveyorPhaseEvidenceComments(input.comments)
  const validEvidence = evidenceForHead(input, evidence)
  const byRole = latestByRole(validEvidence)
  const handoffs = (input.queueRows ?? [])
    .map(parsePhaseHandoffQueueRow)
    .filter((handoff): handoff is ParsedPhaseHandoff => handoff !== null)
  const findings: PhaseReconcileFinding[] = []

  for (const item of evidence) {
    if (!item.valid) {
      findings.push({
        code: 'invalid_phase_evidence',
        severity: 'warning',
        message: `GitHub phase evidence is present but missing required fields for ${item.role}`,
        details: {
          role: item.role,
          marker: item.marker,
          url: item.url,
          missing_required_fields: item.missingRequiredFields,
        },
      })
    }
  }

  for (const role of ['audit', 'qa', 'check'] as ConveyorEvidenceRole[]) {
    if (byRole.has('cto') || (role !== 'check' && byRole.has('check'))) {
      if (!byRole.has(role)) {
        findings.push({
          code: 'missing_independent_phase_evidence',
          severity: 'blocker',
          message: `Missing independent ${role} evidence at current exact head`,
          details: {
            role,
            current_head: input.currentHead,
            downstream_evidence_roles: Array.from(byRole.keys()),
          },
        })
      }
    }
  }

  const labels = new Set(input.labels)
  const l2Audit = validEvidence.find((item) => item.role === 'audit' && evidenceSatisfiesAuditRank(item, 2))
  if (l2Audit && (labels.has('needs:l2-audit') || labels.has('audit:l2-pending') || labels.has('state:impl-l2'))) {
    findings.push({
      code: 'github_label_phase_drift',
      severity: 'warning',
      message: 'PR labels still indicate L2 audit pending after exact-head audit evidence exists',
      details: {
        stale_labels: input.labels.filter((label) => ['needs:l2-audit', 'audit:l2-pending', 'state:impl-l2'].includes(label)),
        evidence_url: l2Audit.url,
      },
      suggestedCommand: prConveyorCommand(input, 'l2-pass', l2Audit.url),
    })
  }
  const check = byRole.get('check')
  if (check && (labels.has('needs:l2-audit') || labels.has('state:impl-l2') || labels.has('evidence-ready'))) {
    findings.push({
      code: 'github_label_phase_drift',
      severity: 'warning',
      message: 'PR labels lag behind exact-head check evidence',
      details: {
        stale_labels: input.labels.filter((label) => ['needs:l2-audit', 'state:impl-l2', 'evidence-ready'].includes(label)),
        evidence_url: check.url,
      },
      suggestedCommand: prConveyorCommand(input, 'check-pass', check.url),
    })
  }

  const nowMs = input.now ? new Date(input.now).getTime() : Date.now()
  const ttlSeconds = input.ttlSeconds ?? 3600
  const agentById = new Map((input.agentStatuses ?? []).map((agent) => [agent.agent_id, agent]))
  for (const handoff of handoffs) {
    if (!ACTIVE_QUEUE_STATUSES.has(handoff.status) || !isSamePrHead(input, handoff)) continue
    const superseding = validEvidence.find((item) => {
      return evidenceSatisfiesHandoff(handoff, item) && isLaterEvidence(handoff, item)
    }) ?? null
    if (superseding) {
      findings.push({
        code: 'superseded_by_github_evidence',
        severity: 'info',
        message: 'AUN handoff queue row is superseded by later GitHub phase evidence',
        details: {
          queue_id: handoff.queueId,
          agent_id: handoff.agentId,
          queue_status: handoff.status,
          handoff_phase: handoff.phase,
          evidence_role: superseding.role,
          evidence_url: supersedingUrl(superseding),
        },
      })
      continue
    }
    const createdMs = handoff.createdAt ? Date.parse(handoff.createdAt) : nowMs
    if (Number.isFinite(createdMs) && nowMs - createdMs > ttlSeconds * 1000) {
      findings.push({
        code: 'phase_handoff_stalled',
        severity: 'warning',
        message: 'AUN phase handoff is still active beyond TTL and no GitHub result evidence was found',
        details: {
          queue_id: handoff.queueId,
          agent_id: handoff.agentId,
          queue_status: handoff.status,
          handoff_phase: handoff.phase,
          created_at: handoff.createdAt,
          ttl_seconds: ttlSeconds,
          runtime: agentById.get(handoff.agentId) ?? null,
        },
      })
    }
  }

  return {
    repo: input.repo,
    pr: input.pr,
    current_head: input.currentHead,
    labels: input.labels.slice().sort(),
    evidence,
    handoffs,
    findings,
  }
}

function supersedingUrl(evidence: ConveyorPhaseEvidence): string | undefined {
  return evidence.url
}
