import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  QUEUE_WORK_RUNTIME_ENGINE_CONFIGURATION_CONTRACTS,
  buildCodexExecQueueWorkCommand,
  buildClaudeCodeQueueWorkCommand,
  buildRunQueueWorkPlan,
  describeCodexExecFailure,
  frameMediatedGithubWriteback,
  parseClaudeStreamJsonQueueWorkResult,
  parseCodexJsonlQueueWorkFallback,
  resolveQueueWorkBunExecutable,
  runQueueWork,
} from '../bin/aun/run-queue-work'
import { QueueWorkAdapterInvocationError } from '../core/queue-work'
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
    const subjectRoot = new URL('..', import.meta.url).pathname
    const schemaPath = new URL('../schemas/queue-work-result-v1.schema.json', import.meta.url).pathname
    const command = buildCodexExecQueueWorkCommand({
      cwd: '/agent-workspace',
      subjectRoot,
      outputLastMessagePath: '/tmp/final-message.json',
      env: {
        AUN_QUEUE_WORK_CODEX_OUTPUT_SCHEMA: schemaPath,
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

    expect(command.runtimeId).toBe('codex-exec')
    expect(QUEUE_WORK_RUNTIME_ENGINE_CONFIGURATION_CONTRACTS['codex-exec']).toEqual({
      runtime_id: 'codex-exec',
      result_schema: 'file',
      mcp_config_mode: 'none',
    })
    expect(command.command).toBe('/opt/homebrew/bin/codex')
    expect(command.args).toEqual([
      'exec',
      '--json',
      '--output-schema', schemaPath,
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
    expect(command.stdin).toContain(`immutable implementation subject is available read-only at ${subjectRoot}`)
    expect(command.stdin).toContain('"queue_id":"42"')
    expect(command.stdin).toContain('Do not call next, inbox')
  })

  test('exit zero with no output-last-message is a dedicated typed failure when same-invocation fallback is absent', () => {
    let failure: unknown
    try {
      parseCodexJsonlQueueWorkFallback([
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 0 } }),
      ].join('\n'))
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(QueueWorkAdapterInvocationError)
    expect(failure).toMatchObject({
      code: 'CODEX_OUTPUT_LAST_MESSAGE_MISSING',
      retryable: false,
    })
    expect((failure as Error).message).not.toContain('ADAPTER_ERROR')
  })

  test('codex same-invocation JSONL fallback returns the final completed agent result with typed evidence', () => {
    const result = parseCodexJsonlQueueWorkFallback([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({
            schema_version: 'queue_work_result_v1',
            ok: true,
            summary: 'completed through fallback',
            reply: null,
            evidence: ['fixture=codex-jsonl'],
            writeback: null,
            next_action: 'close',
          }),
        },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'))

    expect(result).toMatchObject({
      ok: true,
      summary: 'completed through fallback',
      next_action: 'close',
    })
    expect(result.evidence).toEqual(expect.arrayContaining([
      'fixture=codex-jsonl',
      'runtime_adapter_fallback=codex_jsonl_agent_message',
      'runtime_adapter_primary_failure=CODEX_OUTPUT_LAST_MESSAGE_MISSING',
    ]))
  })

  test('claude-code queue-work command keeps the envelope on stdin and requests stream-json schema output', () => {
    const subjectRoot = new URL('..', import.meta.url).pathname
    const command = buildClaudeCodeQueueWorkCommand({
      cwd: '/agent-workspace',
      subjectRoot,
      env: { AUN_QUEUE_WORK_CLAUDE_EXECUTABLE: '/opt/homebrew/bin/claude' } as NodeJS.ProcessEnv,
      envelope: {
        schema_version: 'queue_work_envelope_v1',
        queue_id: '43',
        message_id: 'msg-43',
        agent_id: 'devauditor',
        channel: 'audit',
        thread_id: null,
        requester: 'arc',
        content: 'private queue content',
        reply_contract: { required: false, reply_to: 'msg-43', mention: 'arc' },
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

    expect(command.command).toBe('/opt/homebrew/bin/claude')
    expect(command.runtimeId).toBe('claude-code')
    expect(command.mcpConfigSource).toBe('generated')
    expect(QUEUE_WORK_RUNTIME_ENGINE_CONFIGURATION_CONTRACTS['claude-code']).toEqual({
      runtime_id: 'claude-code',
      result_schema: 'inline-json-from-file',
      mcp_config_mode: 'strict',
    })
    expect(command.args).toContain('stream-json')
    expect(command.args).toContain('--json-schema')
    expect(command.args).toContain('--strict-mcp-config')
    const mcpConfigIndex = command.args.indexOf('--mcp-config')
    expect(mcpConfigIndex).toBeGreaterThan(-1)
    expect(command.args[mcpConfigIndex + 1]).toBe('{"mcpServers":{}}')
    expect(JSON.parse(command.args[mcpConfigIndex + 1]!)).toEqual({ mcpServers: {} })
    expect(command.args.join(' ')).not.toContain('private queue content')
    expect(command.stdin).toContain('private queue content')
  })

  test('claude-code missing mcpServers fails closed before process launch with the missing input typed', () => {
    const subjectRoot = new URL('..', import.meta.url).pathname
    let failure: unknown
    try {
      buildClaudeCodeQueueWorkCommand({
        cwd: '/agent-workspace',
        subjectRoot,
        env: {
          AUN_QUEUE_WORK_CLAUDE_MCP_CONFIG: '{}',
        } as NodeJS.ProcessEnv,
        envelope: {
          schema_version: 'queue_work_envelope_v1',
          queue_id: '44',
          message_id: 'msg-44',
          agent_id: 'devauditor',
          channel: 'audit',
          thread_id: null,
          requester: 'arc',
          content: 'must never reach a runtime process',
          reply_contract: { required: false, reply_to: 'msg-44', mention: 'arc' },
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
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(QueueWorkAdapterInvocationError)
    expect(failure).toMatchObject({
      code: 'ADAPTER_CONFIGURATION_INVALID',
      retryable: false,
    })
    expect((failure as Error).message).toContain('mcpServers')
    expect((failure as Error).message).not.toContain('must never reach a runtime process')
  })

  test('claude stream-json accepts only the final structured result and records its runtime evidence', () => {
    const result = parseClaudeStreamJsonQueueWorkResult([
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        structured_output: {
          schema_version: 'queue_work_result_v1',
          ok: true,
          summary: 'claude completed',
          reply: null,
          evidence: [],
          writeback: null,
          next_action: 'close',
        },
      }),
    ].join('\n'))

    expect(result).toMatchObject({
      ok: true,
      summary: 'claude completed',
      next_action: 'close',
    })
    expect(result.evidence).toContain('runtime_adapter_engine=claude-code')
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
