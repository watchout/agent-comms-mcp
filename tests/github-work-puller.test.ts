import { describe, expect, test } from 'bun:test'
import {
  classifyGithubWorkItem,
  DEFAULT_ROLE_OWNER_MAP,
  RestGithubWorkClient,
  StateDaemonGithubWorkPuller,
  type GithubWorkClient,
  type GithubWorkItem,
  type GithubWorkPullerConfig,
} from '../core/state-daemon/github-work-puller'
import type { DBClient } from '../core/state-daemon/types'

class FakeGithubClient implements GithubWorkClient {
  writebacks: Array<{
    status: string
    queueId: string | null
    url: string
  }> = []

  constructor(private readonly items: GithubWorkItem[]) {}

  async listOpenWorkItems(): Promise<GithubWorkItem[]> {
    return this.items
  }

  async writeDispatchEvidence(input: Parameters<NonNullable<GithubWorkClient['writeDispatchEvidence']>>[0]): Promise<void> {
    this.writebacks.push({
      status: input.status,
      queueId: input.queueId,
      url: input.classification.item.url,
    })
  }
}

class FakeDispatchDb implements DBClient {
  queueRows: Array<{ agent_id: string; payload: Record<string, unknown>; priority: number }> = []
  audits: Array<{ event_type: string; agent_id: string | null; target: string | null; detail: Record<string, unknown> }> = []
  failQueueInsert = false

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] as T[], rowCount: 0 }
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [] as T[], rowCount: 1 }
    }
    if (sql.includes('FROM audit_log') && sql.includes("event_type = 'github_work.dispatch_attempt'")) {
      const fingerprint = String(params?.[0])
      const exists = this.audits.some((audit) => {
        return audit.event_type === 'github_work.dispatch_attempt'
          && audit.detail.fingerprint === fingerprint
      })
      return { rows: (exists ? [{ ok: 1 }] : []) as T[], rowCount: exists ? 1 : 0 }
    }
    if (sql.includes('INSERT INTO message_queue')) {
      if (this.failQueueInsert) throw new Error('message_queue unavailable')
      const id = String(this.queueRows.length + 100)
      this.queueRows.push({
        agent_id: String(params?.[0]),
        payload: JSON.parse(String(params?.[1])),
        priority: Number(params?.[2]),
      })
      return { rows: [{ id }] as T[], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO audit_log')) {
      this.audits.push({
        event_type: String(params?.[0]),
        agent_id: params?.[1] == null ? null : String(params?.[1]),
        target: params?.[2] == null ? null : String(params?.[2]),
        detail: JSON.parse(String(params?.[3])),
      })
      return { rows: [] as T[], rowCount: 1 }
    }
    return { rows: [] as T[], rowCount: 0 }
  }
}

const config: GithubWorkPullerConfig = {
  repos: ['watchout/agent-comms-mcp'],
  labels: ['needs:impl', 'needs:cto'],
  ownerAllowlist: null,
  roleOwnerMap: DEFAULT_ROLE_OWNER_MAP,
  intervalMs: 120_000,
  githubWritebackEnabled: false,
}

function phaseGoalBody(): string {
  return [
    '## Goal',
    'Implement bounded slice.',
    '## Scope',
    'Code and tests.',
    '## Non-scope',
    'No live activation.',
    '## Acceptance Criteria',
    'Tests pass.',
    '## Stop Conditions',
    'Protected boundary.',
    '## Required Evidence',
    'PR comment.',
  ].join('\n\n')
}

function item(overrides: Partial<GithubWorkItem> = {}): GithubWorkItem {
  return {
    repo: 'watchout/agent-comms-mcp',
    kind: 'issue',
    number: 744,
    nodeId: 'I_kwDORw1jW85TEST',
    title: 'P0 GitHub work puller',
    url: 'https://github.com/watchout/agent-comms-mcp/issues/744',
    updatedAt: '2026-06-14T01:06:51Z',
    labels: ['needs:impl', 'owner:agent-com-dev', 'route:fast', 'runner:codex'],
    body: phaseGoalBody(),
    author: 'watchout',
    lastActivityId: 'comment:4700297796',
    ...overrides,
  }
}

describe('GitHub work puller planner', () => {
  test('classifies a routine bounded phase goal as Codex fast lane without making AUN the SSOT', () => {
    const classification = classifyGithubWorkItem(item(), config)

    expect(classification.owner).toBe('agent-com-dev')
    expect(classification.role).toBe('impl')
    expect(classification.route).toBe('fast')
    expect(classification.runnerPolicy).toBe('codex_native_fast_lane')
    expect(classification.phaseGoalPresent).toBe(true)
    expect(classification.autonomousExecutionAllowed).toBe(true)
    expect(classification.dispatchable).toBe(true)
  })

  test('protected route resolves to stop_lane and cannot autonomous-execute', () => {
    const classification = classifyGithubWorkItem(item({
      labels: ['needs:cto', 'owner:codex-cto', 'route:protected', 'runner:codex'],
    }), config)

    expect(classification.owner).toBe('codex-cto')
    expect(classification.role).toBe('cto')
    expect(classification.protected).toBe(true)
    expect(classification.runnerPolicy).toBe('stop_lane')
    expect(classification.autonomousExecutionAllowed).toBe(false)
    expect(classification.dispatchable).toBe(true)
  })
})

describe('StateDaemonGithubWorkPuller dispatch', () => {
  test('queues a GitHub URL notification and writes durable dispatch evidence', async () => {
    const db = new FakeDispatchDb()
    const puller = new StateDaemonGithubWorkPuller({
      db,
      client: new FakeGithubClient([item()]),
      config,
    })

    const result = await puller.pollOnce()

    expect(result.queued).toBe(1)
    expect(db.queueRows).toHaveLength(1)
    expect(db.queueRows[0].agent_id).toBe('agent-com-dev')
    expect(db.queueRows[0].payload.github_url).toBe('https://github.com/watchout/agent-comms-mcp/issues/744')
    expect(db.queueRows[0].payload.ssot).toBe('github')
    expect(db.queueRows[0].payload.aun_is_acceleration_only).toBe(true)
    const audit = db.audits.find((row) => row.event_type === 'github_work.dispatch_attempt')
    expect(audit?.detail.dispatch_status).toBe('queued')
    expect(audit?.detail.queue_id).toBe('100')
    expect(audit?.detail.github_url).toBe('https://github.com/watchout/agent-comms-mcp/issues/744')
  })

  test('suppresses duplicate dispatch across restarts using persisted audit fingerprint', async () => {
    const db = new FakeDispatchDb()
    const first = new StateDaemonGithubWorkPuller({
      db,
      client: new FakeGithubClient([item()]),
      config,
    })
    const second = new StateDaemonGithubWorkPuller({
      db,
      client: new FakeGithubClient([item()]),
      config,
    })

    expect((await first.pollOnce()).queued).toBe(1)
    const secondResult = await second.pollOnce()

    expect(secondResult.duplicateSuppressed).toBe(1)
    expect(db.queueRows).toHaveLength(1)
  })

  test('records degraded dispatch failure without hiding the GitHub work item', async () => {
    const db = new FakeDispatchDb()
    db.failQueueInsert = true
    const puller = new StateDaemonGithubWorkPuller({
      db,
      client: new FakeGithubClient([item()]),
      config,
    })

    const result = await puller.pollOnce()

    expect(result.dispatchFailed).toBe(1)
    expect(result.results[0].classification.item.url).toBe('https://github.com/watchout/agent-comms-mcp/issues/744')
    expect(db.queueRows).toHaveLength(0)
    const audit = db.audits.find((row) => row.event_type === 'github_work.dispatch_failed')
    expect(audit?.detail.dispatch_status).toBe('failed')
    expect(audit?.detail.github_url).toBe('https://github.com/watchout/agent-comms-mcp/issues/744')
  })

  test('optionally writes dispatch evidence back to GitHub while keeping DB audit evidence', async () => {
    const db = new FakeDispatchDb()
    const client = new FakeGithubClient([item()])
    const puller = new StateDaemonGithubWorkPuller({
      db,
      client,
      config: { ...config, githubWritebackEnabled: true },
    })

    const result = await puller.pollOnce()

    expect(result.queued).toBe(1)
    expect(client.writebacks).toEqual([{
      status: 'queued',
      queueId: '100',
      url: 'https://github.com/watchout/agent-comms-mcp/issues/744',
    }])
    const audit = db.audits.find((row) => row.event_type === 'github_work.writeback')
    expect(audit?.detail.writeback_status).toBe('ok')
  })

  test('blocks unresolved owner instead of falling back to unsafe prompt injection', async () => {
    const db = new FakeDispatchDb()
    const puller = new StateDaemonGithubWorkPuller({
      db,
      client: new FakeGithubClient([item({
        labels: ['needs:unknown-role'],
      })]),
      config: { ...config, labels: ['needs:unknown-role'] },
    })

    const result = await puller.pollOnce()

    expect(result.blocked).toBe(1)
    expect(db.queueRows).toHaveLength(0)
    const audit = db.audits.find((row) => row.event_type === 'github_work.blocked')
    expect(audit?.detail.blocker).toBe('missing_owner')
  })
})

describe('RestGithubWorkClient', () => {
  test('fetches open issue/PR work, activity cursor, and optional writeback without relying on AUN', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const rawUrl = String(url)
      calls.push({ url: rawUrl, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
      if (rawUrl.includes('/issues?')) {
        return Response.json([{
          number: 744,
          node_id: 'ISSUE_NODE',
          title: 'work item',
          html_url: 'https://github.com/watchout/agent-comms-mcp/issues/744',
          updated_at: '2026-06-14T01:06:51Z',
          labels: [{ name: 'needs:impl' }, { name: 'owner:agent-com-dev' }],
          body: phaseGoalBody(),
          user: { login: 'watchout' },
          comments: 2,
          comments_url: 'https://api.github.com/repos/watchout/agent-comms-mcp/issues/744/comments',
          pull_request: { url: 'https://api.github.com/repos/watchout/agent-comms-mcp/pulls/744' },
        }])
      }
      if (rawUrl.includes('/comments?')) {
        return Response.json([{ node_id: 'COMMENT_NODE_2' }])
      }
      if (rawUrl.includes('/pulls/744/reviews')) {
        return Response.json([{ node_id: 'REVIEW_NODE_1' }])
      }
      if (rawUrl.endsWith('/issues/744/comments')) {
        return Response.json({ id: 1 })
      }
      return new Response('not found', { status: 404, statusText: 'not found' })
    }
    const client = new RestGithubWorkClient({ fetchImpl, token: 'token', perRepoLimit: 5 })

    const items = await client.listOpenWorkItems(config)

    expect(items).toHaveLength(1)
    expect(items[0].lastActivityId).toBe('comment:COMMENT_NODE_2|review:REVIEW_NODE_1')

    const classification = classifyGithubWorkItem(items[0], config)
    await client.writeDispatchEvidence?.({
      classification,
      status: 'queued',
      queueId: '100',
    })

    const post = calls.find((call) => call.method === 'POST')
    expect(post?.url).toBe('https://api.github.com/repos/watchout/agent-comms-mcp/issues/744/comments')
    expect(post?.body).toContain('AUN GitHub Work Puller Evidence')
  })
})
