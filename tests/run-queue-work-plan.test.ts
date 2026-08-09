import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  buildCodexExecQueueWorkCommand,
  buildRunQueueWorkPlan,
  describeCodexExecFailure,
  frameMediatedGithubWriteback,
  resolveQueueWorkBunExecutable,
  runQueueWork,
} from '../bin/aun/run-queue-work'
import { validateMediatedPostingRequest } from '../scripts/queue-work-github-writeback'

describe('buildRunQueueWorkPlan expected_claim_source', () => {
  test('trusted mediator frames an unmarked audit body with exact provenance headers', () => {
    const framed = frameMediatedGithubWriteback({
      queueId: '154244',
      agentId: 'codex-audit',
      messageId: 'msg-154244',
      writeback: {
        mode: 'github_issue_comment',
        repo: 'watchout/agent-comms-mcp',
        issue_number: 917,
        body: '## Audit finding\n\nOne blocking finding.',
        idempotency_key: 'audit-154244',
        body_sha256: null,
      },
    })

    expect(framed.body).toStartWith('<!-- aun:l2-audit/v1 -->\n')
    expect(framed.body).toContain('repo: watchout/agent-comms-mcp\n')
    expect(framed.body).toContain('issue: 917\n')
    expect(framed.body).toContain('role: codex-audit\n')
    expect(framed.body).toContain('source_queue_id: 154244\n')
    expect(framed.body).toContain('source_message_id: msg-154244\n')
    expect(framed.body).toContain('status: completed\n')
    expect(framed.body).toContain('idempotency_key: audit-154244\n')
    expect(framed.body).toEndWith('## Audit finding\n\nOne blocking finding.')
    expect(framed.body_sha256).toBeNull()
    expect(validateMediatedPostingRequest({
      schema_version: 'queue_work_mediated_posting_request_v1',
      queue_id: '154244',
      agent_id: 'codex-audit',
      message_id: 'msg-154244',
      handoff_contract: {
        kind: 'github_backed_role_handoff',
        github_backed: true,
        required_writebacks: ['github_issue_comment'],
        posting_mode: 'mediated',
        detected_from: ['github_url'],
      },
      writeback: framed,
      runtime_result_summary: {
        ok: true,
        summary: 'blocking finding completed',
        next_action: 'reply',
        evidence: [],
      },
    }, { allowRepos: ['watchout/agent-comms-mcp'] }).ok).toBe(true)
  })

  test('trusted mediator does not rewrite an existing or misplaced authority marker', () => {
    const base = {
      mode: 'github_issue_comment' as const,
      repo: 'watchout/agent-comms-mcp',
      issue_number: 917,
    }
    const existing = frameMediatedGithubWriteback({
      queueId: '1', agentId: 'codex-audit', messageId: null,
      writeback: { ...base, body: '<!-- aun:l2-audit/v1 -->\nrepo: watchout/agent-comms-mcp' },
    })
    const misplaced = frameMediatedGithubWriteback({
      queueId: '1', agentId: 'codex-audit', messageId: null,
      writeback: { ...base, body: 'text\n<!-- aun:l2-audit/v1 -->' },
    })

    expect(existing.body).toBe('<!-- aun:l2-audit/v1 -->\nrepo: watchout/agent-comms-mcp')
    expect(misplaced.body).toBe('text\n<!-- aun:l2-audit/v1 -->')
  })

  test('resolves from explicit option first', () => {
    const plan = buildRunQueueWorkPlan({
      queueId: '42',
      agentId: 'codex-audit',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      env: { AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE: 'env-source' } as NodeJS.ProcessEnv,
    })
    expect(plan.expected_claim_source).toBe('state-daemon-queue-work-scheduler')
  })

  test('falls back to AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE env', () => {
    const plan = buildRunQueueWorkPlan({
      queueId: '42',
      agentId: 'codex-audit',
      env: { AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE: 'env-source' } as NodeJS.ProcessEnv,
    })
    expect(plan.expected_claim_source).toBe('env-source')
  })

  test('defaults to null so manual operator runs stay unrestricted', () => {
    const plan = buildRunQueueWorkPlan({
      queueId: '42',
      agentId: 'codex-audit',
      env: {} as NodeJS.ProcessEnv,
    })
    expect(plan.expected_claim_source).toBeNull()
  })

  test('dry-run result surfaces the resolved claim source in the plan', async () => {
    const result = await runQueueWork({
      queueId: '42',
      agentId: 'codex-audit',
      expectedClaimSource: 'state-daemon-queue-work-scheduler',
      dryRun: true,
      env: {} as NodeJS.ProcessEnv,
    })
    expect(result.ok).toBe(true)
    expect(result.dry_run).toBe(true)
    expect(result.plan.expected_claim_source).toBe('state-daemon-queue-work-scheduler')
  })

  test('resolves state-daemon queue-work runtime env for launchagent canary', () => {
    const plan = buildRunQueueWorkPlan({
      queueId: '42',
      agentId: 'qa',
      env: {
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
      } as NodeJS.ProcessEnv,
    })
    expect(plan.runtime).toBe('codex-exec')
  })

  test('keeps the immutable subject root separate from the target agent runtime workspace', () => {
    const plan = buildRunQueueWorkPlan({
      cwd: '/subject-checkout',
      runtimeCwd: '/agent-workspace',
      env: {} as NodeJS.ProcessEnv,
    })

    expect(plan.repoRoot).toBe('/subject-checkout')
    expect(plan.runtime_cwd).toBe('/agent-workspace')
  })

  test('nested finalizers do not rely on bare bun under launchd PATH', () => {
    const launchdEnv = {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    } as NodeJS.ProcessEnv

    expect(resolveQueueWorkBunExecutable(launchdEnv)).toBe(process.execPath)
    expect(resolveQueueWorkBunExecutable({
      ...launchdEnv,
      STATE_DAEMON_BUN_EXECUTABLE: '/operator/state-daemon-bun',
    } as NodeJS.ProcessEnv)).toBe('/operator/state-daemon-bun')
    expect(resolveQueueWorkBunExecutable({
      ...launchdEnv,
      STATE_DAEMON_BUN_EXECUTABLE: '/operator/state-daemon-bun',
      AUN_BUN_EXECUTABLE: '/operator/aun-bun',
    } as NodeJS.ProcessEnv)).toBe('/operator/aun-bun')

    const runtimeV2Source = readFileSync(new URL('../bin/aun/runtime-v2.ts', import.meta.url), 'utf8')
    expect(runtimeV2Source).toContain('execFileAsync(resolveQueueWorkBunExecutable(this.env), [')
    expect(runtimeV2Source).not.toContain("execFileAsync('bun', [")
  })

  test('codex-exec queue-work command uses schema, output-last-message, sandbox, cd, and stdin prompt', () => {
    const command = buildCodexExecQueueWorkCommand({
      cwd: '/agent-workspace',
      subjectRoot: '/repo',
      outputLastMessagePath: '/tmp/final-message.json',
      env: {
        AUN_QUEUE_WORK_CODEX_OUTPUT_SCHEMA: '/repo/schemas/queue-work-result-v1.schema.json',
        AUN_QUEUE_WORK_CODEX_SANDBOX: 'read-only',
        AUN_QUEUE_WORK_CODEX_EXECUTABLE: '/opt/homebrew/bin/codex',
        AUN_QUEUE_WORK_CODEX_IGNORE_RULES: '1',
      } as NodeJS.ProcessEnv,
      envelope: {
        schema_version: 'queue_work_envelope_v1',
        queue_id: '42',
        message_id: 'msg-42',
        agent_id: 'qa',
        channel: null,
        thread_id: null,
        requester: 'agent-com-dev',
        content: 'canary',
        reply_contract: {
          required: false,
          reply_to: 'msg-42',
          mention: 'agent-com-dev',
        },
        runtime_contract: {
          do_not_call_next: true,
          do_not_call_inbox: true,
          return_schema: 'queue_work_result_v1',
        },
        handoff_contract: {
          kind: 'plain_queue_work',
          github_backed: false,
          required_writebacks: [],
          posting_mode: 'none',
          detected_from: [],
        },
      },
    })

    expect(command.command).toBe('/opt/homebrew/bin/codex')
    expect(command.args).toEqual([
      'exec',
      '--json',
      '--output-schema', '/repo/schemas/queue-work-result-v1.schema.json',
      '--output-last-message', '/tmp/final-message.json',
      '--sandbox', 'read-only',
      '--cd', '/agent-workspace',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',
      '-',
    ])
    expect(command.stdin).toContain('Return only JSON matching queue_work_result_v1')
    expect(command.stdin).toContain('A negative audit, gate, or domain finding is still successfully completed work')
    expect(command.stdin).toContain('Use ok=false only when the requested inspection or work itself could not be completed safely')
    expect(command.stdin).toContain('immutable implementation subject is available read-only at /repo')
    expect(command.stdin).toContain('"queue_id":"42"')
    expect(command.stdin).toContain('Do not call next, inbox')
  })

  test('codex-exec failure diagnostics include stdout and final-message when stderr is empty', () => {
    const detail = describeCodexExecFailure({
      result: {
        status: 1,
        stdout: '{"error":"schema rejected"}\n',
        stderr: '',
        errorMessage: 'Command failed: codex exec',
      },
      outputLastMessagePath: '/tmp/aun-queue-work-missing-final-message.json',
    })

    expect(detail).toContain('status=1')
    expect(detail).toContain('stderr=<empty>')
    expect(detail).toContain('stdout=')
    expect(detail).toContain('schema rejected')
    expect(detail).toContain('error=')
    expect(detail).toContain('final_message=<missing>')
  })

  test('execFileAsync successful child exit path is null-safe', () => {
    const source = readFileSync(new URL('../bin/aun/run-queue-work.ts', import.meta.url), 'utf8')

    expect(source).toContain('signal: execErr?.signal ?? null')
    expect(source).toContain('killed: execErr?.killed')
    expect(source).not.toContain('signal: execErr.signal ?? null')
    expect(source).not.toContain('killed: execErr.killed')
  })

  test('production expected-claim-source requires and forwards an exact claim fence', () => {
    const source = readFileSync(new URL('../bin/aun/run-queue-work.ts', import.meta.url), 'utf8')

    expect(source).toContain('claimFence: opts.claimFence')
    expect(source).toContain('requireClaimFence: opts.requireClaimFence ?? plan.expected_claim_source !== null')
    expect(source).toContain('claimResultFence:')
    expect(source).toContain('expectedRuntimeId: adapter.runtime_id')
  })

  test('packaged queue-work result schema is Codex structured-output compatible', () => {
    const schema = JSON.parse(readFileSync(new URL('../schemas/queue-work-result-v1.schema.json', import.meta.url), 'utf8'))

    expect(schema.additionalProperties).toBe(false)
    // strict structured output: required must include EVERY key in properties
    // (CP80 canary invalid_json_schema failure 2026-07-09, #846 — writeback was missing here)
    expect(schema.required).toEqual(['schema_version', 'ok', 'summary', 'reply', 'evidence', 'writeback', 'next_action'])
    expect(schema.properties.schema_version).toMatchObject({
      type: 'string',
      const: 'queue_work_result_v1',
    })
    expect(schema.properties.reply.type).toEqual(['string', 'null'])
    expect(schema.properties.evidence).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    })
    expect(schema.properties.writeback).toMatchObject({
      type: ['object', 'null'],
      required: ['mode', 'repo', 'issue_number', 'body', 'evidence', 'idempotency_key', 'body_sha256'],
    })
    expect(schema.properties.next_action).toMatchObject({
      type: 'string',
      enum: ['reply', 'close', 'none', 'retry'],
    })
  })
})
