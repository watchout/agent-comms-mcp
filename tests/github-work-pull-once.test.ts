import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GITHUB_WORK_PULL_ONCE_COMMENT_MARKER,
  buildGithubWorkPullOnceInput,
  isGithubWorkPullOnceSelfComment,
  loadGithubWorkPullOnceFixture,
  parseGithubWorkPullOnceEventComment,
  planGithubWorkPullOnce,
  renderGithubWorkPullOnceEventComment,
  runGithubWorkPullOnce,
  type GithubWorkPullOnceClient,
  type GithubWorkPullOnceComment,
} from '../core/state-daemon/github-work-pull-once'
import type { GithubWorkItem, GithubWorkPullerConfig } from '../core/state-daemon/github-work-puller'

const REPO_ROOT = join(import.meta.dir, '..')
const FIXTURE_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'github-work-p2-pull-once', 'dry-run-canary.json')
const SCHEMA_PATH = join(REPO_ROOT, 'schemas', 'github-work-pull-once-v1.schema.json')

class FakePullOnceClient implements GithubWorkPullOnceClient {
  posts: Array<{ item: GithubWorkItem; body: string; id: string; createdAt: string }> = []
  private readonly commentsByWorkKey: Record<string, GithubWorkPullOnceComment[]>

  constructor(
    private readonly items: GithubWorkItem[],
    commentsByWorkKey: Record<string, GithubWorkPullOnceComment[]> = {},
    private readonly options: { failOnPost?: boolean } = {},
  ) {
    this.commentsByWorkKey = Object.fromEntries(
      Object.entries(commentsByWorkKey).map(([key, comments]) => [key, [...comments]]),
    )
  }

  async listOpenWorkItems(_config: GithubWorkPullerConfig): Promise<GithubWorkItem[]> {
    return this.items
  }

  async listEventComments(item: GithubWorkItem): Promise<GithubWorkPullOnceComment[]> {
    return [...(this.commentsByWorkKey[workKey(item)] ?? [])]
  }

  async postEventComment(item: GithubWorkItem, body: string): Promise<{ id: string; createdAt: string }> {
    if (this.options.failOnPost) throw new Error('mock comment write failed')
    const id = `posted-${this.posts.length + 1}`
    const createdAt = `2026-07-05T10:00:0${this.posts.length + 1}.000Z`
    this.posts.push({ item, body, id, createdAt })
    this.commentsByWorkKey[workKey(item)] = [
      ...(this.commentsByWorkKey[workKey(item)] ?? []),
      { id, body, createdAt, author: 'aun' },
    ]
    return { id, createdAt }
  }
}

function input(overrides: Partial<Parameters<typeof buildGithubWorkPullOnceInput>[0]> = {}) {
  return buildGithubWorkPullOnceInput({
    repo: 'watchout/agent-comms-mcp',
    label: 'canary:github-work-pull-once',
    ownerAllowlist: ['aun'],
    targetNumber: 744,
    targetKind: 'issue',
    writebackMode: 'none',
    action: 'claim',
    actorSeat: 'aun',
    execute: false,
    now: '2026-07-05T10:00:00.000Z',
    ...overrides,
  })
}

function item(overrides: Partial<GithubWorkItem> = {}): GithubWorkItem {
  return {
    repo: 'watchout/agent-comms-mcp',
    kind: 'issue',
    number: 744,
    nodeId: 'I_kwDORw1jW85P2TEST',
    title: 'P2 GitHub pull once fixture',
    url: 'https://github.com/watchout/agent-comms-mcp/issues/744',
    createdAt: '2026-07-05T10:00:00Z',
    updatedAt: '2026-07-05T10:01:00Z',
    labels: ['canary:github-work-pull-once', 'needs:implementation', 'owner:aun', 'route:fast', 'runner:codex'],
    body: [
      '## Goal',
      'Implement bounded P2 pull-once dry-run.',
      '## Scope',
      'Fixture-only planning.',
      '## Non-scope',
      'No live API.',
      '## Acceptance Criteria',
      'Dry-run plan is emitted.',
      '## Stop Conditions',
      'Protected boundary.',
      '## Required Evidence',
      'PR evidence comment.',
    ].join('\n\n'),
    author: 'watchout',
    lastActivityId: 'comment:P2_TEST',
    activityCursor: 'content:p2-test|base:I_kwDORw1jW85P2TEST:2026-07-05T10:01:00Z',
    ...overrides,
  }
}

function workKey(workItem: GithubWorkItem): string {
  return `${workItem.repo}#${workItem.number}`
}

describe('P2_github_pull_once contract planner', () => {
  test('schema and canary fixture produce a dry-run claim plan without mutation evidence', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>
    const fixture = loadGithubWorkPullOnceFixture(FIXTURE_PATH)
    const plan = planGithubWorkPullOnce(input(), fixture.items, fixture.comments ?? {})

    expect(schema).toMatchObject({
      title: 'GitHub Work Pull Once v1',
      additionalProperties: false,
    })
    expect(plan.ok).toBe(true)
    expect(plan.go_no_go).toBe('GO_DRY_RUN')
    expect(plan.status).toBe('would_claim')
    expect(plan.scanned).toBe(1)
    expect(plan.matched).toBe(1)
    expect(plan.blocker_codes).toEqual([])
    expect(plan.selected?.classification.owner).toBe('aun')
    expect(plan.selected?.classification.route).toBe('fast')
    expect(plan.events_to_post).toHaveLength(1)
    expect(plan.events_to_post[0]).toMatchObject({
      lane: 'P2_github_pull_once',
      event_type: 'claim.requested',
      status: 'claim_requested',
      mutation_performed: false,
      live_github_api_performed: false,
      db_queue_mutation_performed: false,
      token_used: false,
    })
    expect(plan.evidence).toMatchObject({
      dry_run: true,
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
    })
  })

  test('rejects non-canary broad labels before any claim is accepted', () => {
    const plan = planGithubWorkPullOnce(input({ label: 'needs:implementation' }), [
      item({ labels: ['needs:implementation', 'owner:aun', 'route:fast', 'runner:codex'] }),
    ])

    expect(plan.ok).toBe(false)
    expect(plan.go_no_go).toBe('NO_GO')
    expect(plan.blocker_codes).toContain('canary_label_required')
    expect(plan.events_to_post).toEqual([])
  })

  test('blocks protected routes with the independent protected-surface classifier', () => {
    const plan = planGithubWorkPullOnce(input(), [
      item({
        title: 'Enable AUN runner runtime activation',
        labels: ['canary:github-work-pull-once', 'needs:cto', 'owner:aun', 'route:protected', 'runner:codex'],
        body: 'Request touches runtime activation and repo protection.',
      }),
    ])

    expect(plan.ok).toBe(false)
    expect(plan.go_no_go).toBe('NO_GO')
    expect(plan.selected?.protectedSurface.protected_surface_classified).toBe(true)
    expect(plan.selected?.protectedSurface.claim_allowed).toBe(false)
    expect(plan.blocker_codes).toContain('protected_route_blocked')
    expect(plan.blocker_codes).toContain('PROTECTED_SURFACE_OWNER_REQUIRED')
    expect(plan.events_to_post).toEqual([])
  })

  test('suppresses duplicate work when a winning claim or result already exists', () => {
    const workItem = item()
    const first = planGithubWorkPullOnce(input(), [workItem])
    const requested = first.events_to_post[0]
    const won = {
      ...requested,
      event_type: 'claim.won' as const,
      status: 'claim_won' as const,
      confirmed_winner_claim_id: requested.claim_id,
      github_created_at: '2026-07-05T10:00:02.000Z',
    }
    const plan = planGithubWorkPullOnce(input(), [workItem], {
      [workKey(workItem)]: [{
        id: 'existing-won',
        body: renderGithubWorkPullOnceEventComment(won),
        createdAt: '2026-07-05T10:00:02.000Z',
        author: 'aun',
      }],
    })

    expect(plan.ok).toBe(false)
    expect(plan.status).toBe('duplicate_suppressed')
    expect(plan.blocker_codes).toEqual(['duplicate_claim_or_result'])
    expect(plan.events_to_post).toEqual([])
  })

  test('mocked GitHub-comment writeback confirms one winner and posts result without DB or queue mutation', async () => {
    const workItem = item()
    const client = new FakePullOnceClient([workItem])
    const plan = await runGithubWorkPullOnce(input({
      execute: true,
      writebackMode: 'github-comment',
      action: 'result',
      ownerDecisionUrl: 'https://github.com/watchout/agent-comms-mcp/issues/744#issuecomment-owner',
      resultSummary: 'mocked result publication',
    }), client)

    expect(plan.ok).toBe(true)
    expect(plan.status).toBe('result_posted')
    expect(plan.events_to_post.map((event) => event.event_type)).toEqual([
      'claim.requested',
      'claim.won',
      'result.posted',
    ])
    expect(client.posts).toHaveLength(3)
    expect(client.posts.every((post) => post.body.includes(GITHUB_WORK_PULL_ONCE_COMMENT_MARKER))).toBe(true)
    expect(plan.evidence.db_queue_mutation_performed).toBe(false)
    expect(plan.evidence.queue_claim_process_completion_performed).toBe(false)
  })

  test('mocked comment dispatch failure returns work.blocked evidence instead of throwing', async () => {
    const workItem = item()
    const client = new FakePullOnceClient([workItem], {}, { failOnPost: true })
    const plan = await runGithubWorkPullOnce(input({
      execute: true,
      writebackMode: 'github-comment',
      action: 'claim',
      ownerDecisionUrl: 'https://github.com/watchout/agent-comms-mcp/issues/744#issuecomment-owner',
    }), client)

    expect(plan.ok).toBe(false)
    expect(plan.go_no_go).toBe('NO_GO')
    expect(plan.status).toBe('dispatch_failed')
    expect(plan.blocker_codes).toContain('dispatch_failed')
    expect(plan.events_to_post.map((event) => event.event_type)).toEqual(['claim.requested', 'work.blocked'])
    expect(client.posts).toEqual([])
  })

  test('self writeback comments are machine-identifiable and parseable', () => {
    const plan = planGithubWorkPullOnce(input(), [item()])
    const body = renderGithubWorkPullOnceEventComment(plan.events_to_post[0])
    const parsed = parseGithubWorkPullOnceEventComment(body)

    expect(isGithubWorkPullOnceSelfComment(body)).toBe(true)
    expect(parsed?.event_type).toBe('claim.requested')
    expect(parsed?.work_key).toBe('watchout/agent-comms-mcp#744')
    expect(parsed?.claim_id).toBe(plan.events_to_post[0].claim_id)
  })
})
