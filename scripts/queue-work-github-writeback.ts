#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  QueueWorkGithubIssueCommentWriteback,
  QueueWorkHandoffContract,
  QueueWorkRuntimeResultSummary,
} from '../core/queue-work'

export interface QueueWorkMediatedPostingRequest {
  schema_version: 'queue_work_mediated_posting_request_v1'
  operation?: 'perform' | 'readback'
  queue_id: string
  agent_id: string
  message_id: string | null
  handoff_contract: QueueWorkHandoffContract
  writeback: QueueWorkGithubIssueCommentWriteback
  runtime_result_summary: QueueWorkRuntimeResultSummary
}

export interface QueueWorkMediatedPostingResponse {
  ok: boolean
  posted_with?: string | null
  body_sha256?: string | null
  error_code?: string
  summary?: string
}

export interface QueueWorkGithubWritebackOptions {
  dryRun?: boolean
  allowRepos?: string[]
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  readTokenFile?: (path: string) => string
}

type ParsedArgs = {
  dryRun: boolean
  probe: boolean
  allowRepos: string[]
}

const APPROVED_MARKERS = new Set([
  'aun:l2-audit/v1',
  'aun:qa-check/v1',
  'aun:technical-check/v1',
  'aun:arc-technical-design/v1',
  'aun:cto-go-no-go/v1',
  'aun:state-transition-request/v1',
])

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { dryRun: false, probe: false, allowRepos: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--probe') args.probe = true
    else if (arg === '--allow-repo') args.allowRepos.push(next())
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function usage(): string {
  return `queue-work GitHub mediated writeback wrapper

Usage:
  bun scripts/queue-work-github-writeback.ts --probe --allow-repo <owner/repo>
  bun scripts/queue-work-github-writeback.ts --dry-run --allow-repo <owner/repo> < request.json
  bun scripts/queue-work-github-writeback.ts --allow-repo <owner/repo> < request.json

Input schema: queue_work_mediated_posting_request_v1
`
}

export function bodySha256(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

function resolveGithubTokenFromEnv(
  env: NodeJS.ProcessEnv,
  readTokenFile: (path: string) => string,
): { token?: string; source: string | null } {
  const tokenFile = env.STATE_DAEMON_GITHUB_TOKEN_FILE?.trim()
    ?? env.AUN_QUEUE_WORK_GITHUB_TOKEN_FILE?.trim()
  if (tokenFile) {
    const token = readTokenFile(tokenFile).trim()
    return { token: token || undefined, source: 'token_file' }
  }
  const token = (env.GH_TOKEN ?? env.GITHUB_TOKEN ?? env.STATE_DAEMON_GITHUB_TOKEN)?.trim()
  return { token: token || undefined, source: token ? 'env' : null }
}

function envAllowRepos(env: NodeJS.ProcessEnv): string[] {
  const raw = env.AUN_QUEUE_WORK_GITHUB_WRITEBACK_REPOS
    ?? env.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_REPOS
  return raw?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function approvedMarkersForAgent(agentId: string): Set<string> {
  if (/^(l1auditor|l2auditor|auditor|codex-audit)$/i.test(agentId)) {
    return new Set(['aun:l2-audit/v1'])
  }
  if (/^qa$/i.test(agentId)) return new Set(['aun:qa-check/v1'])
  if (/^check$/i.test(agentId)) return new Set(['aun:technical-check/v1'])
  if (/^arc$/i.test(agentId)) return new Set(['aun:arc-technical-design/v1'])
  if (/^(cto|codex-cto)$/i.test(agentId)) {
    return new Set(['aun:cto-go-no-go/v1', 'aun:state-transition-request/v1'])
  }
  return APPROVED_MARKERS
}

function bodyMarker(body: string): string | null {
  const start = body.match(/^<!--\s*(aun:[a-z0-9-]+\/v\d+)\s*-->/i)
  if (!start) return null
  const all = body.match(/<!--\s*aun:[a-z0-9-]+\/v\d+\s*-->/gi) ?? []
  return all.length === 1 ? start[1].toLowerCase() : null
}

function hasHeader(body: string, key: string, value?: string | number | null): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = value === undefined || value === null
    ? new RegExp(`^${escaped}:\\s*\\S+\\s*$`, 'im')
    : new RegExp(`^${escaped}:\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im')
  return pattern.test(body)
}

function validateWritebackObject(writeback: QueueWorkGithubIssueCommentWriteback): string | null {
  if (!writeback || typeof writeback !== 'object') return 'writeback must be an object'
  if (writeback.mode !== 'github_issue_comment') return 'writeback.mode must be github_issue_comment'
  if (typeof writeback.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(writeback.repo)) return 'writeback.repo must be owner/name'
  if (!Number.isInteger(writeback.issue_number) || writeback.issue_number <= 0) return 'writeback.issue_number must be a positive integer'
  if (typeof writeback.body !== 'string' || writeback.body.trim().length === 0) return 'writeback.body must be non-empty'
  // strict structured output emits optional fields as explicit null — accept both absent and null
  if (writeback.evidence !== undefined && writeback.evidence !== null && (!Array.isArray(writeback.evidence) || writeback.evidence.some((item) => typeof item !== 'string'))) {
    return 'writeback.evidence must be a string array'
  }
  if (writeback.body_sha256 !== undefined && writeback.body_sha256 !== null && !/^[a-f0-9]{64}$/.test(writeback.body_sha256)) return 'writeback.body_sha256 must be 64 lowercase hex characters'
  if (writeback.idempotency_key !== undefined && writeback.idempotency_key !== null && (typeof writeback.idempotency_key !== 'string' || writeback.idempotency_key.trim().length === 0)) {
    return 'writeback.idempotency_key must be a non-empty string'
  }
  return null
}

export function validateMediatedPostingRequest(
  request: QueueWorkMediatedPostingRequest,
  options: { allowRepos: string[] },
): { ok: true; marker: string; body_sha256: string } | { ok: false; error_code: string; summary: string } {
  if (!request || typeof request !== 'object') return { ok: false, error_code: 'INVALID_REQUEST', summary: 'request must be an object' }
  if (request.schema_version !== 'queue_work_mediated_posting_request_v1') {
    return { ok: false, error_code: 'INVALID_SCHEMA', summary: 'schema_version must be queue_work_mediated_posting_request_v1' }
  }
  if (request.operation !== undefined && request.operation !== 'perform' && request.operation !== 'readback') {
    return { ok: false, error_code: 'INVALID_OPERATION', summary: 'operation must be perform or readback' }
  }
  if (!request.queue_id || typeof request.queue_id !== 'string') return { ok: false, error_code: 'QUEUE_ID_REQUIRED', summary: 'queue_id is required' }
  if (!request.agent_id || typeof request.agent_id !== 'string') return { ok: false, error_code: 'AGENT_ID_REQUIRED', summary: 'agent_id is required' }
  if (!request.handoff_contract?.github_backed || !request.handoff_contract.required_writebacks?.includes('github_issue_comment')) {
    return { ok: false, error_code: 'HANDOFF_CONTRACT_NOT_GITHUB_BACKED', summary: 'handoff_contract must require github_issue_comment writeback' }
  }
  const writebackError = validateWritebackObject(request.writeback)
  if (writebackError) return { ok: false, error_code: 'INVALID_WRITEBACK', summary: writebackError }
  if (!options.allowRepos.includes(request.writeback.repo)) {
    return { ok: false, error_code: 'REPO_NOT_ALLOWED', summary: `repo is not allowlisted: ${request.writeback.repo}` }
  }
  const marker = bodyMarker(request.writeback.body)
  if (!marker) return { ok: false, error_code: 'APPROVED_MARKER_REQUIRED', summary: 'body must start with exactly one hidden AUN marker' }
  if (!approvedMarkersForAgent(request.agent_id).has(marker)) {
    return { ok: false, error_code: 'MARKER_NOT_ALLOWED_FOR_ROLE', summary: `marker ${marker} is not approved for ${request.agent_id}` }
  }
  if (!hasHeader(request.writeback.body, 'repo', request.writeback.repo)) {
    return { ok: false, error_code: 'REPO_HEADER_REQUIRED', summary: 'body must include matching repo header' }
  }
  if (!hasHeader(request.writeback.body, 'issue', request.writeback.issue_number) && !hasHeader(request.writeback.body, 'pr', request.writeback.issue_number)) {
    return { ok: false, error_code: 'TARGET_HEADER_REQUIRED', summary: 'body must include matching issue or pr header' }
  }
  if (!hasHeader(request.writeback.body, 'role')) return { ok: false, error_code: 'ROLE_HEADER_REQUIRED', summary: 'body must include role header' }
  if (!hasHeader(request.writeback.body, 'source_queue_id', request.queue_id)) {
    return { ok: false, error_code: 'SOURCE_QUEUE_ID_HEADER_REQUIRED', summary: 'body must include matching source_queue_id header' }
  }
  if (request.message_id && !hasHeader(request.writeback.body, 'source_message_id', request.message_id)) {
    return { ok: false, error_code: 'SOURCE_MESSAGE_ID_HEADER_REQUIRED', summary: 'body must include matching source_message_id header' }
  }
  if (!hasHeader(request.writeback.body, 'verdict') && !hasHeader(request.writeback.body, 'status')) {
    return { ok: false, error_code: 'VERDICT_OR_STATUS_HEADER_REQUIRED', summary: 'body must include verdict or status header' }
  }
  const hash = bodySha256(request.writeback.body)
  if (request.writeback.body_sha256 && request.writeback.body_sha256 !== hash) {
    return { ok: false, error_code: 'BODY_SHA256_MISMATCH', summary: 'writeback.body_sha256 does not match body' }
  }
  return { ok: true, marker, body_sha256: hash }
}

async function githubFetchJson<T>(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'agent-comms-queue-work-writeback',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub API failed status=${res.status} body=${text.slice(0, 500)}`)
  }
  return await res.json() as T
}

async function findDuplicateComment(input: {
  fetchImpl: typeof fetch
  token: string
  repo: string
  issueNumber: number
  body: string
  idempotencyKey?: string | null
}): Promise<{ receipt: string | null; conflict: boolean }> {
  const matches: Array<{ receipt: string | null; exactBody: boolean }> = []
  for (let page = 1; page <= 10; page++) {
    const comments = await githubFetchJson<Array<{
      body?: string | null
      html_url?: string | null
      url?: string | null
    }>>(
      input.fetchImpl,
      input.token,
      `https://api.github.com/repos/${input.repo}/issues/${input.issueNumber}/comments?per_page=100&page=${page}`,
    )
    for (const comment of comments) {
      const body = comment.body ?? ''
      const exactBody = body === input.body
      const sameKey = Boolean(input.idempotencyKey && new RegExp(`^idempotency_key:\\s*${input.idempotencyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im').test(body))
      if (exactBody || sameKey) {
        matches.push({ receipt: comment.html_url ?? comment.url ?? null, exactBody })
      }
    }
    if (comments.length < 100) break
  }
  if (matches.length === 0) return { receipt: null, conflict: false }
  if (matches.length !== 1 || !matches[0]!.exactBody || !matches[0]!.receipt) {
    return { receipt: matches[0]?.receipt ?? null, conflict: true }
  }
  return { receipt: matches[0]!.receipt, conflict: false }
}

export async function queueWorkGithubWriteback(
  request: QueueWorkMediatedPostingRequest,
  options: QueueWorkGithubWritebackOptions = {},
): Promise<QueueWorkMediatedPostingResponse> {
  const env = options.env ?? process.env
  const allowRepos = [...(options.allowRepos ?? []), ...envAllowRepos(env)]
  const validation = validateMediatedPostingRequest(request, { allowRepos })
  if (!validation.ok) return validation
  if (options.dryRun) {
    return { ok: true, posted_with: null, body_sha256: validation.body_sha256, summary: 'dry-run validation passed' }
  }

  const { token } = resolveGithubTokenFromEnv(env, options.readTokenFile ?? ((path) => readFileSync(path, 'utf8')))
  if (!token) return { ok: false, error_code: 'GITHUB_TOKEN_MISSING', summary: 'GitHub token is required for mediated posting' }
  const fetchImpl = options.fetchImpl ?? fetch
  const duplicate = await findDuplicateComment({
    fetchImpl,
    token,
    repo: request.writeback.repo,
    issueNumber: request.writeback.issue_number,
    body: request.writeback.body,
    idempotencyKey: request.writeback.idempotency_key,
  })
  if (duplicate.conflict) {
    return {
      ok: false,
      error_code: 'DUPLICATE_WRITEBACK_CONFLICT',
      body_sha256: validation.body_sha256,
      summary: 'idempotency readback found multiple comments or mismatched body evidence',
    }
  }
  if (duplicate.receipt) {
    return {
      ok: true,
      posted_with: duplicate.receipt,
      body_sha256: validation.body_sha256,
      summary: 'matching GitHub writeback already exists; returned the durable receipt',
    }
  }
  if (request.operation === 'readback') {
    return {
      ok: true,
      posted_with: null,
      body_sha256: validation.body_sha256,
      summary: 'no matching GitHub writeback exists; readback performed no mutation',
    }
  }
  const posted = await githubFetchJson<{ html_url?: string; url?: string }>(
    fetchImpl,
    token,
    `https://api.github.com/repos/${request.writeback.repo}/issues/${request.writeback.issue_number}/comments`,
    { method: 'POST', body: JSON.stringify({ body: request.writeback.body }) },
  )
  return {
    ok: true,
    posted_with: posted.html_url ?? posted.url ?? null,
    body_sha256: validation.body_sha256,
    summary: 'posted GitHub issue comment',
  }
}

export function probeQueueWorkGithubWriteback(options: QueueWorkGithubWritebackOptions = {}): QueueWorkMediatedPostingResponse {
  const env = options.env ?? process.env
  const allowRepos = [...(options.allowRepos ?? []), ...envAllowRepos(env)]
  if (allowRepos.length === 0) {
    return { ok: false, error_code: 'REPO_ALLOWLIST_REQUIRED', summary: 'at least one --allow-repo or env allowlist entry is required' }
  }
  const { token, source } = resolveGithubTokenFromEnv(env, options.readTokenFile ?? ((path) => readFileSync(path, 'utf8')))
  if (!token) return { ok: false, error_code: 'GITHUB_TOKEN_MISSING', summary: 'GitHub token is required for mediated posting probe' }
  return { ok: true, posted_with: null, body_sha256: null, summary: `probe passed token_source=${source}` }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2))
    const response = args.probe
      ? probeQueueWorkGithubWriteback({ allowRepos: args.allowRepos })
      : await queueWorkGithubWriteback(JSON.parse(await readStdin()), {
          dryRun: args.dryRun,
          allowRepos: args.allowRepos,
        })
    process.stdout.write(JSON.stringify(response, null, 2) + '\n')
    process.exit(response.ok ? 0 : 1)
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error_code: 'WRAPPER_ERROR',
      summary: err instanceof Error ? err.message : String(err),
    }, null, 2) + '\n')
    process.exit(1)
  }
}

if (import.meta.main) {
  void main()
}
