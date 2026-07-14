import { describe, expect, test } from 'bun:test'
import {
  bodySha256,
  probeQueueWorkGithubWriteback,
  queueWorkGithubWriteback,
  validateMediatedPostingRequest,
  type QueueWorkMediatedPostingRequest,
} from '../../scripts/queue-work-github-writeback'

function request(patch: Partial<QueueWorkMediatedPostingRequest> = {}): QueueWorkMediatedPostingRequest {
  const body = [
    '<!-- aun:l2-audit/v1 -->',
    'repo: watchout/agent-comms-mcp',
    'pr: 780',
    'role: codex-audit',
    'source_queue_id: 122255',
    'source_message_id: msg-122255',
    'verdict: PASS',
    'idempotency_key: queue-122255-msg-122255',
    '',
    '## Evidence',
    '- focused tests passed',
  ].join('\n')
  return {
    schema_version: 'queue_work_mediated_posting_request_v1',
    queue_id: '122255',
    agent_id: 'codex-audit',
    message_id: 'msg-122255',
    handoff_contract: {
      kind: 'github_backed_role_handoff',
      github_backed: true,
      required_writebacks: ['github_issue_comment'],
      posting_mode: 'mediated',
      detected_from: ['message_type:phase_handoff', 'github_url'],
      audit_route: {
        active_function: 'evidence_audit_gate',
        canonical_seat: 'codex-audit',
        agent_id: 'codex-audit',
        route_kind: 'evidence_audit_gate',
        legacy_input: {
          role: 'l2-audit',
          label: null,
          agent_id: 'codex-audit',
        },
        historical_input: true,
      },
      active_function: 'evidence_audit_gate',
      canonical_seat: 'codex-audit',
      canonical_agent_id: 'codex-audit',
      route_blocker: null,
      route_blocker_detail: null,
    },
    writeback: {
      mode: 'github_issue_comment',
      repo: 'watchout/agent-comms-mcp',
      issue_number: 780,
      body,
      evidence: ['exact_head:abc123'],
      idempotency_key: 'queue-122255-msg-122255',
      body_sha256: bodySha256(body),
    },
    runtime_result_summary: {
      ok: true,
      summary: 'L2 audit complete',
      next_action: 'close',
      evidence: ['focused tests passed'],
    },
    ...patch,
  }
}

describe('queue-work GitHub mediated writeback wrapper', () => {
  test('validates an approved role marker, headers, repo allowlist, and body hash', () => {
    const result = validateMediatedPostingRequest(request(), {
      allowRepos: ['watchout/agent-comms-mcp'],
    })

    expect(result).toMatchObject({
      ok: true,
      body_sha256: request().writeback.body_sha256,
    })
  })

  test('rejects comments without exactly one approved hidden AUN marker', () => {
    const invalid = request({
      writeback: {
        ...request().writeback,
        body: 'repo: watchout/agent-comms-mcp\npr: 780\nrole: l2auditor\nsource_queue_id: 122255\nsource_message_id: msg-122255\nverdict: PASS',
        body_sha256: undefined,
      },
    })

    expect(validateMediatedPostingRequest(invalid, {
      allowRepos: ['watchout/agent-comms-mcp'],
    })).toMatchObject({
      ok: false,
      error_code: 'APPROVED_MARKER_REQUIRED',
    })
  })

  test('rejects historical l2auditor as evidence-audit writeback owner', () => {
    const historical = request({
      agent_id: 'l2auditor',
      handoff_contract: {
        ...request().handoff_contract,
        canonical_agent_id: 'codex-audit',
        route_blocker: 'historical_or_mismatched_audit_owner',
      },
    })

    expect(validateMediatedPostingRequest(historical, {
      allowRepos: ['watchout/agent-comms-mcp'],
    })).toMatchObject({
      ok: false,
      error_code: 'AUDIT_ROUTE_BLOCKED',
    })
  })

  test('dry-run validates without posting', async () => {
    const result = await queueWorkGithubWriteback(request(), {
      dryRun: true,
      allowRepos: ['watchout/agent-comms-mcp'],
      env: {} as NodeJS.ProcessEnv,
    })

    expect(result).toMatchObject({
      ok: true,
      posted_with: null,
      body_sha256: request().writeback.body_sha256,
    })
  })

  test('posts through GitHub API and returns URL plus body hash', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/comments?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      return new Response(JSON.stringify({
        html_url: 'https://github.com/watchout/agent-comms-mcp/pull/780#issuecomment-1',
      }), { status: 201 })
    }) as typeof fetch

    const result = await queueWorkGithubWriteback(request(), {
      allowRepos: ['watchout/agent-comms-mcp'],
      env: { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv,
      fetchImpl,
    })

    expect(result).toMatchObject({
      ok: true,
      posted_with: 'https://github.com/watchout/agent-comms-mcp/pull/780#issuecomment-1',
      body_sha256: request().writeback.body_sha256,
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].init?.method).toBe('POST')
  })

  test('fails closed on duplicate idempotency evidence before posting', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes('/comments?')) {
        return new Response(JSON.stringify([{ body: request().writeback.body }]), { status: 200 })
      }
      throw new Error('POST should not be called')
    }) as typeof fetch

    const result = await queueWorkGithubWriteback(request(), {
      allowRepos: ['watchout/agent-comms-mcp'],
      env: { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv,
      fetchImpl,
    })

    expect(result).toMatchObject({
      ok: false,
      error_code: 'DUPLICATE_WRITEBACK',
    })
  })

  test('probe requires allowlist and token readiness', () => {
    expect(probeQueueWorkGithubWriteback({
      allowRepos: ['watchout/agent-comms-mcp'],
      env: { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv,
    })).toMatchObject({ ok: true })

    expect(probeQueueWorkGithubWriteback({
      allowRepos: ['watchout/agent-comms-mcp'],
      env: {} as NodeJS.ProcessEnv,
    })).toMatchObject({
      ok: false,
      error_code: 'GITHUB_TOKEN_MISSING',
    })
  })
})
