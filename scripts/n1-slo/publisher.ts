import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { N1MeasurementReport } from './harness'

export const N1_REPORT_REPOSITORY = 'watchout/agent-comms-mcp' as const
export const N1_REPORT_ISSUE_NUMBER = 602 as const

export interface N1PublishReceipt {
  ok: boolean
  comment_url: string | null
  raw_body_sha256: string
  idempotent_readback: boolean
  error_code?: string
}

export interface N1PublisherOptions {
  token?: string
  tokenFile?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  runGh?: () => string
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function renderN1ReportComment(report: N1MeasurementReport): string {
  return `<!-- shirube-v3:evidence:${report.report_id} -->
## N1 communication SLO measurement (machine generated)

schema_version: ${report.schema_version}
evidence_id: ${report.report_id}
n1_run_id: ${report.run_id}
source_commit: ${report.source_commit}
verdict: ${report.verdict}
provider_effect_count: ${report.effects.provider_effect_count}
discord_visible_send_count: ${report.effects.discord_visible_send_count}
residual_nonterminal_probe_rows: ${report.effects.residual_nonterminal_probe_rows}

\`\`\`json
${JSON.stringify(report, null, 2)}
\`\`\`

next_action: none
`
}

function defaultGhToken(): string {
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function resolveToken(options: N1PublisherOptions): string {
  if (options.token?.trim()) return options.token.trim()
  if (options.tokenFile?.trim()) return readFileSync(options.tokenFile, 'utf8').trim()
  const env = options.env ?? process.env
  const fromEnv = (env.GH_TOKEN ?? env.GITHUB_TOKEN)?.trim()
  if (fromEnv) return fromEnv
  return (options.runGh ?? defaultGhToken)()
}

async function githubJson<T>(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'agent-comms-n1-slo-publisher',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`GITHUB_API_${response.status}:${detail.slice(0, 300)}`)
  }
  return await response.json() as T
}

async function findExistingReport(
  fetchImpl: typeof fetch,
  token: string,
  runId: string,
  body: string,
): Promise<{ url: string | null; conflict: boolean }> {
  const marker = `n1_run_id: ${runId}`
  const matches: Array<{ body: string; url: string | null }> = []
  for (let page = 1; page <= 10; page++) {
    const comments = await githubJson<Array<{ body?: string | null; html_url?: string | null }>>(
      fetchImpl,
      token,
      `https://api.github.com/repos/${N1_REPORT_REPOSITORY}/issues/${N1_REPORT_ISSUE_NUMBER}/comments?per_page=100&page=${page}`,
    )
    for (const comment of comments) {
      if ((comment.body ?? '').includes(marker)) {
        matches.push({ body: comment.body ?? '', url: comment.html_url ?? null })
      }
    }
    if (comments.length < 100) break
  }
  if (matches.length === 0) return { url: null, conflict: false }
  if (matches.length !== 1 || matches[0]!.body !== body || !matches[0]!.url) {
    return { url: matches[0]?.url ?? null, conflict: true }
  }
  return { url: matches[0]!.url, conflict: false }
}

export async function publishN1Report(
  report: N1MeasurementReport,
  options: N1PublisherOptions = {},
): Promise<N1PublishReceipt> {
  const body = renderN1ReportComment(report)
  const digest = sha256(body)
  const token = resolveToken(options)
  if (!token) return { ok: false, comment_url: null, raw_body_sha256: digest, idempotent_readback: false, error_code: 'GITHUB_TOKEN_MISSING' }
  const fetchImpl = options.fetchImpl ?? fetch
  const existing = await findExistingReport(fetchImpl, token, report.run_id, body)
  if (existing.conflict) {
    return { ok: false, comment_url: existing.url, raw_body_sha256: digest, idempotent_readback: false, error_code: 'REPORT_IDEMPOTENCY_CONFLICT' }
  }
  if (existing.url) {
    return { ok: true, comment_url: existing.url, raw_body_sha256: digest, idempotent_readback: true }
  }
  const created = await githubJson<{ body?: string | null; html_url?: string | null; url?: string | null }>(
    fetchImpl,
    token,
    `https://api.github.com/repos/${N1_REPORT_REPOSITORY}/issues/${N1_REPORT_ISSUE_NUMBER}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
  )
  if (!created.html_url || !created.url || created.body !== body || sha256(created.body) !== digest) {
    return { ok: false, comment_url: created.html_url ?? null, raw_body_sha256: digest, idempotent_readback: false, error_code: 'REPORT_READBACK_MISMATCH' }
  }
  const readback = await githubJson<{ body?: string | null; html_url?: string | null }>(fetchImpl, token, created.url)
  if (readback.html_url !== created.html_url || readback.body !== body || sha256(readback.body ?? '') !== digest) {
    return { ok: false, comment_url: created.html_url, raw_body_sha256: digest, idempotent_readback: false, error_code: 'REPORT_READBACK_MISMATCH' }
  }
  return { ok: true, comment_url: readback.html_url, raw_body_sha256: digest, idempotent_readback: false }
}
