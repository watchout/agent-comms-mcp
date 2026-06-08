import {
  buildCommandPlan,
  parseMaxInspect,
  receiveActionable,
  repoRoot,
  type ActionableReceiveSummary,
  type ReceiveOptions,
  type ReceiveResult,
} from './receive'
import {
  resolveCodexExecutable,
  resolveNestedBunExecutable,
} from './codex-runner'

export interface CodexRunnerPreflightOptions extends ReceiveOptions {
  maxInspect?: number
  queueId?: string
}

export interface CodexRunnerPreflightFinding {
  code: string
  severity: 'blocker' | 'warning'
  message: string
  details?: Record<string, unknown>
}

export interface CodexRunnerLifecyclePreflightReport {
  ok: boolean
  dry_run: true
  mode: 'codex-runner-preflight'
  generated_at: string
  agent_id: string | null
  expected_agent_id: string | null
  queue_id: string | null
  max_inspect: number | null
  identity: {
    ok: boolean
    error: string | null
  }
  database: {
    candidates: string[]
    reachable: boolean
    error: string | null
  }
  runner_config: {
    bun_executable: string
    codex_executable: string
    codex_sandbox: string
    codex_exec_timeout_ms: number
    auto_final_reply_enabled_by_env: boolean
    auto_complete_no_reply_enabled_by_env: boolean
  }
  receive_actionable: {
    ok: boolean
    code: number
    selected_queue_id: string | number | null
    selected_message_id: string | null
    selected_message_type: string | null
    selected_routing_decision: string | null
    selected_route_reason: string | null
    waiting: number | null
    active_claim: {
      busy: boolean
      queue_id: string | number | null
      message_id: string | null
      status: string | null
      claimed_at: string | null
      claim_expires_at: string | null
    } | null
    blocked_reason: ActionableReceiveSummary['blocked_reason'] | null
    selection_reason: string | null
    memory_ready: {
      ok: boolean
      reason: string
      runtime_instance_id: string | null
      evidence_id: string | number | null
      evidence_log_id: string | null
      valid_until: string | null
    } | null
  }
  command_preview: {
    cwd: string
    argv: string[]
  } | null
  mutation_policy: {
    read_only: true
    no_queue_claim: true
    no_queue_drain: true
    no_reply: true
    no_launch_process: true
    no_state_daemon_restart: true
    no_launchctl: true
    no_discord_write: true
    no_secret_output: true
  }
  findings: CodexRunnerPreflightFinding[]
}

export interface CodexRunnerPreflightResult extends ReceiveResult {
  report?: CodexRunnerLifecyclePreflightReport
}

function boolEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key]?.trim() === '1' || env[key]?.trim()?.toLowerCase() === 'true'
}

function positiveNumberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
}

function redactSecretUrl(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, '$1$2:***@')
}

function sanitizeText(text: string, env: NodeJS.ProcessEnv): string {
  let out = text
  const databaseUrl = env.DATABASE_URL?.trim()
  if (databaseUrl) out = out.split(databaseUrl).join(redactSecretUrl(databaseUrl))
  return redactSecretUrl(out)
}

function redactCandidates(candidates: string[]): string[] {
  return candidates.map(redactSecretUrl)
}

function mutationPolicy(): CodexRunnerLifecyclePreflightReport['mutation_policy'] {
  return {
    read_only: true,
    no_queue_claim: true,
    no_queue_drain: true,
    no_reply: true,
    no_launch_process: true,
    no_state_daemon_restart: true,
    no_launchctl: true,
    no_discord_write: true,
    no_secret_output: true,
  }
}

function selectedFrom(summary: ActionableReceiveSummary | null): CodexRunnerLifecyclePreflightReport['receive_actionable'] {
  const selected = summary?.selected ?? null
  const activeClaim = summary?.active_claim
  return {
    ok: !!summary?.ok,
    code: summary ? 0 : 1,
    selected_queue_id: selected?.queue_id ?? null,
    selected_message_id: selected?.message_id ?? null,
    selected_message_type: selected?.message_type ?? null,
    selected_routing_decision: selected?.routing_decision ?? null,
    selected_route_reason: selected?.route_reason ?? null,
    waiting: summary?.waiting ?? null,
    active_claim: activeClaim ? {
      busy: activeClaim.busy,
      queue_id: activeClaim.queue_id,
      message_id: activeClaim.message_id,
      status: activeClaim.status,
      claimed_at: activeClaim.claimed_at,
      claim_expires_at: activeClaim.claim_expires_at,
    } : null,
    blocked_reason: summary?.blocked_reason ?? null,
    selection_reason: summary?.selection_reason ?? null,
    memory_ready: summary?.memory_ready ? {
      ok: summary.memory_ready.ok,
      reason: summary.memory_ready.reason,
      runtime_instance_id: summary.memory_ready.runtime_instance_id,
      evidence_id: summary.memory_ready.evidence_id,
      evidence_log_id: summary.memory_ready.evidence_log_id,
      valid_until: summary.memory_ready.valid_until,
    } : null,
  }
}

function findingsFrom(input: {
  identityOk: boolean
  identityError: string | null
  databaseReachable: boolean
  databaseError: string | null
  receive: ActionableReceiveSummary | null
  targetQueueId: string | null
}): CodexRunnerPreflightFinding[] {
  const findings: CodexRunnerPreflightFinding[] = []
  if (!input.identityOk) {
    findings.push({
      code: 'AGENT_IDENTITY_MISMATCH',
      severity: 'blocker',
      message: input.identityError ?? 'AGENT_ID does not match AGENT_COM_EXPECTED_AGENT_ID',
    })
  }
  if (!input.databaseReachable) {
    findings.push({
      code: 'DATABASE_UNREACHABLE',
      severity: 'blocker',
      message: input.databaseError ?? 'database preflight could not read queue state',
    })
  }
  if (input.receive?.memory_ready && !input.receive.memory_ready.ok) {
    findings.push({
      code: 'MEMORY_READY_NOT_READY',
      severity: 'blocker',
      message: `memory_ready gate failed: ${input.receive.memory_ready.reason}`,
      details: {
        runtime_instance_id: input.receive.memory_ready.runtime_instance_id,
        evidence_id: input.receive.memory_ready.evidence_id,
      },
    })
  }
  if (input.receive?.blocked_reason === 'active_claim') {
    findings.push({
      code: 'ACTIVE_CLAIM_PRESENT',
      severity: 'blocker',
      message: 'agent already has active received/in_progress work',
      details: {
        queue_id: input.receive.active_claim.queue_id,
        status: input.receive.active_claim.status,
      },
    })
  }
  if (input.targetQueueId && input.receive?.blocked_reason === 'queue_not_claimable') {
    findings.push({
      code: 'TARGET_QUEUE_NOT_CLAIMABLE',
      severity: 'blocker',
      message: 'target queue row is not claimable by codex-runner',
      details: {
        queue_id: input.targetQueueId,
        selection_reason: input.receive.selection_reason,
      },
    })
  }
  if (!input.targetQueueId && input.receive && input.receive.selected === null && !input.receive.blocked_reason) {
    findings.push({
      code: 'NO_ACTIONABLE_ROW',
      severity: 'warning',
      message: 'no actionable queue row is currently visible in the inspected window',
    })
  }
  return findings
}

function reportCode(report: CodexRunnerLifecyclePreflightReport): number {
  return report.findings.some((finding) => finding.severity === 'blocker') ? 1 : 0
}

function errorReport(
  opts: CodexRunnerPreflightOptions,
  error: string,
  maxInspect: number | null = null,
): CodexRunnerLifecyclePreflightReport {
  const env = opts.env ?? process.env
  const agentId = opts.agentId?.trim() || env.AGENT_ID?.trim() || null
  const expectedAgentId = env.AGENT_COM_EXPECTED_AGENT_ID?.trim() || agentId
  const sanitized = sanitizeText(error, env)
  const findingCode = sanitized.startsWith('AGENT_ID_MISMATCH')
    ? 'AGENT_IDENTITY_MISMATCH'
    : sanitized.includes('--max-inspect')
      ? 'INVALID_MAX_INSPECT'
      : 'CODEX_RUNNER_PREFLIGHT_FAILED'
  const identityError = findingCode === 'AGENT_IDENTITY_MISMATCH' ? sanitized : null
  return {
    ok: false,
    dry_run: true,
    mode: 'codex-runner-preflight',
    generated_at: new Date().toISOString(),
    agent_id: agentId,
    expected_agent_id: expectedAgentId,
    queue_id: opts.queueId?.trim() || null,
    max_inspect: maxInspect,
    identity: {
      ok: identityError === null,
      error: identityError,
    },
    database: {
      candidates: [],
      reachable: false,
      error: null,
    },
    runner_config: {
      bun_executable: resolveNestedBunExecutable(),
      codex_executable: resolveCodexExecutable(),
      codex_sandbox: env.AUN_CODEX_SANDBOX?.trim() || 'read-only',
      codex_exec_timeout_ms: positiveNumberEnv(env, 'AUN_CODEX_EXEC_TIMEOUT_MS', 120_000),
      auto_final_reply_enabled_by_env: boolEnv(env, 'STATE_DAEMON_CODEX_RUNNER_AUTO_FINAL_REPLY'),
      auto_complete_no_reply_enabled_by_env: boolEnv(env, 'STATE_DAEMON_CODEX_RUNNER_AUTO_COMPLETE_NO_REPLY'),
    },
    receive_actionable: selectedFrom(null),
    command_preview: null,
    mutation_policy: mutationPolicy(),
    findings: [{
      code: findingCode,
      severity: 'blocker',
      message: sanitized,
    }],
  }
}

export async function codexRunnerLifecyclePreflight(
  opts: CodexRunnerPreflightOptions = {},
): Promise<CodexRunnerPreflightResult> {
  let maxInspect: number | null = null
  try {
    maxInspect = parseMaxInspect(opts.maxInspect)
    const queueId = opts.queueId?.trim() || null
    const argv = [
      resolveNestedBunExecutable(),
      'bin/aun.ts',
      'codex-runner',
      '--agent-id',
      opts.agentId?.trim() || (opts.env ?? process.env).AGENT_ID?.trim() || '<agent-id>',
      '--limit',
      '1',
      '--dry-run',
      ...(queueId ? ['--queue-id', queueId] : []),
    ]
    const plan = buildCommandPlan(opts, argv)
    const receive = await receiveActionable({
      ...opts,
      dryRun: true,
      maxInspect,
      queueId: queueId ?? undefined,
      env: plan.env,
      cwd: plan.repoRoot,
    })
    const receiveSummary = receive.summary ?? (receive.stdout
      ? JSON.parse(receive.stdout) as ActionableReceiveSummary
      : null)
    const databaseError = receive.ok || receiveSummary
      ? null
      : sanitizeText(receive.stderr || 'receive-actionable dry-run did not return a summary', opts.env ?? process.env)
    const findings = findingsFrom({
      identityOk: true,
      identityError: null,
      databaseReachable: !!receiveSummary,
      databaseError,
      receive: receiveSummary,
      targetQueueId: queueId,
    })
    const report: CodexRunnerLifecyclePreflightReport = {
      ok: !findings.some((finding) => finding.severity === 'blocker'),
      dry_run: true,
      mode: 'codex-runner-preflight',
      generated_at: new Date().toISOString(),
      agent_id: plan.env.AGENT_ID,
      expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
      queue_id: queueId,
      max_inspect: maxInspect,
      identity: {
        ok: true,
        error: null,
      },
      database: {
        candidates: redactCandidates(plan.databaseUrlCandidates),
        reachable: !!receiveSummary,
        error: databaseError,
      },
      runner_config: {
        bun_executable: resolveNestedBunExecutable(),
        codex_executable: resolveCodexExecutable(),
        codex_sandbox: plan.env.AUN_CODEX_SANDBOX?.trim() || 'read-only',
        codex_exec_timeout_ms: positiveNumberEnv(plan.env, 'AUN_CODEX_EXEC_TIMEOUT_MS', 120_000),
        auto_final_reply_enabled_by_env: boolEnv(plan.env, 'STATE_DAEMON_CODEX_RUNNER_AUTO_FINAL_REPLY'),
        auto_complete_no_reply_enabled_by_env: boolEnv(plan.env, 'STATE_DAEMON_CODEX_RUNNER_AUTO_COMPLETE_NO_REPLY'),
      },
      receive_actionable: selectedFrom(receiveSummary),
      command_preview: {
        cwd: plan.repoRoot,
        argv,
      },
      mutation_policy: mutationPolicy(),
      findings,
    }
    const code = reportCode(report)
    return {
      ok: code === 0,
      code,
      stdout: JSON.stringify(report) + '\n',
      stderr: '',
      plan,
      report,
    }
  } catch (err) {
    const report = errorReport(opts, (err as Error).message, maxInspect)
    return {
      ok: false,
      code: 2,
      stdout: JSON.stringify(report) + '\n',
      stderr: `Error [CODEX_RUNNER_PREFLIGHT_FAILED]: ${sanitizeText((err as Error).message, opts.env ?? process.env)}\n`,
      plan: {
        repoRoot: opts.cwd ?? repoRoot(),
        argv: ['bun', 'bin/aun.ts', 'codex-runner-preflight'],
        env: { ...(opts.env ?? process.env) } as Record<string, string>,
        databaseUrlCandidates: [],
      },
      report,
    }
  }
}
