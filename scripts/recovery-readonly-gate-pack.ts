#!/usr/bin/env bun
/**
 * #602 recovery read-only gate evidence pack.
 *
 * Collects pre-activation evidence only. This script never restarts
 * state_daemon, calls launchctl, writes Discord, drains queue work, mutates DB,
 * runs schema migrations, invokes a live runtime, or retries automatically.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export type GateReportName =
  | 'cp70-preflight'
  | 'recovery-readiness'
  | 'activation-plan'
  | 'discord-projection'
  | 'state-daemon-readiness'
  | 'queue-processing-readiness'
  | 'install-plan'

const REQUIRED_REPORTS: GateReportName[] = [
  'cp70-preflight',
  'recovery-readiness',
  'activation-plan',
  'discord-projection',
  'state-daemon-readiness',
  'queue-processing-readiness',
  'install-plan',
]

export interface GatePackOptions {
  outputDir: string
  databaseUrl: string
  agentId: string
  recipientAgentId: string
  channelId: string
  scopeId: string
  installPlanCommit: string
  includeInstallPlan: boolean
  repoRoot: string
}

export interface GateCommand {
  report: GateReportName
  outputFile: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface ReportBlocker {
  source_report: GateReportName
  code: string
  subject_id?: string | number | null
  evidence?: Record<string, unknown>
}

export interface GateSummary {
  ok: boolean
  go_no_go: 'GO' | 'NO_GO'
  generated_at: string
  evidence_dir: string
  scope_file: string
  current_main_sha: string | null
  repo_head_sha: string | null
  pr_dependencies: {
    pr_671_local_supervisor_adapter: unknown
    pr_672_install_plan: unknown
  }
  reports: Record<GateReportName, {
    ok: boolean
    go_no_go: 'GO' | 'NO_GO'
    mutation_performed: boolean
    restart_performed: boolean
    blocker_codes: string[]
  }>
  blockers: ReportBlocker[]
  mutation_performed: false
  restart_performed: false
  guardrails: {
    no_state_daemon_restart: true
    no_launchctl_bootstrap_or_kickstart: true
    no_discord_live_write: true
    no_next_inbox_fifo_drain: true
    no_db_mutation_or_schema_migration: true
    no_live_runtime_call: true
    no_automatic_retry_loop: true
  }
}

type ParsedArgs = {
  flags: Record<string, string | true>
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {}
  const rest = argv.slice(2)
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { flags }
}

function flagString(flags: Record<string, string | true>, key: string, fallback: string): string {
  const value = flags[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function flagBool(flags: Record<string, string | true>, key: string, fallback = false): boolean {
  const value = flags[key]
  if (value === undefined) return fallback
  if (value === true) return true
  return !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

function runText(command: string, args: string[], cwd: string): string | null {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) return null
  const text = result.stdout.trim()
  return text.length > 0 ? text : null
}

function repoHead(repoRoot: string): string | null {
  return runText('git', ['rev-parse', 'HEAD'], repoRoot)
}

function currentMain(repoRoot: string): string | null {
  return runText('git', ['rev-parse', 'origin/main'], repoRoot)
}

function ghPrStatus(repoRoot: string, pr: number): unknown {
  const result = spawnSync('gh', [
    'pr',
    'view',
    String(pr),
    '--json',
    'number,url,state,isDraft,headRefOid,baseRefOid,mergeStateStatus',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    return {
      available: false,
      pr,
      error: result.stderr.trim() || result.stdout.trim() || 'gh pr view failed',
    }
  }
  try {
    return { available: true, ...JSON.parse(result.stdout) }
  } catch (err) {
    return {
      available: false,
      pr,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function defaultScope(options: Pick<GatePackOptions, 'scopeId' | 'agentId' | 'recipientAgentId' | 'channelId'>): Record<string, unknown> {
  return {
    scope_id: options.scopeId,
    issue: '#602',
    max_canary_count: 1,
    agents: [options.agentId],
    channels: [options.channelId],
    runtime_kinds: ['codex'],
    runner_phases: ['receive', 'process', 'completion', 'projection', 'audit'],
    fallback_allowed: false,
    cp70: {
      agent_id: options.agentId,
      stale_minutes: 15,
    },
    queue: {
      agent_id: options.agentId,
      stale_minutes: 15,
    },
    state_daemon: {
      expected: true,
      require_running: false,
      allow_private_tmp: false,
    },
    projection_checks: [{
      name: 'codex-cto-to-ceo-direct',
      channel_id: options.channelId,
      sender_agent_id: options.agentId,
      recipient_agent_ids: [options.recipientAgentId],
      expected_consumer_agent_id: options.agentId,
      expected_consumer_source: 'sender_token_evidence',
      allow_fallback: false,
    }],
    prohibited: [
      'fifo_drain',
      'prompt_driven_next',
      'prompt_driven_inbox',
      'tui_prompt_injection',
      'automatic_retry_loop',
      'fleet_wide_activation',
    ],
  }
}

export function buildReadOnlyGateCommands(options: GatePackOptions): GateCommand[] {
  const out = options.outputDir
  const dbEnv = { DATABASE_URL: options.databaseUrl }
  return [
    {
      report: 'cp70-preflight',
      outputFile: join(out, 'cp70-preflight.json'),
      command: 'bun',
      args: ['cli/index.ts', 'queue', 'cp70-preflight', '--agent-id', options.agentId, '--format', 'json'],
      env: dbEnv,
    },
    {
      report: 'discord-projection',
      outputFile: join(out, 'discord-projection.json'),
      command: 'bun',
      args: [
        'cli/index.ts',
        'diagnose-projection',
        '--channel-id',
        options.channelId,
        '--from-agent',
        options.agentId,
        '--to',
        options.recipientAgentId,
        '--format',
        'json',
      ],
      env: dbEnv,
    },
    {
      report: 'state-daemon-readiness',
      outputFile: join(out, 'state-daemon-readiness.json'),
      command: 'bun',
      args: ['cli/index.ts', 'state-daemon', 'readiness', '--format', 'json'],
    },
    {
      report: 'queue-processing-readiness',
      outputFile: join(out, 'queue-processing-readiness.json'),
      command: 'bun',
      args: ['cli/index.ts', 'state-daemon', 'queue-readiness', '--agent-id', options.agentId, '--format', 'json'],
      env: dbEnv,
    },
    {
      report: 'recovery-readiness',
      outputFile: join(out, 'recovery-readiness.json'),
      command: 'bun',
      args: ['cli/index.ts', 'recovery', 'readiness', '--scope-file', join(out, 'recovery-scope.json'), '--format', 'json'],
      env: dbEnv,
    },
    {
      report: 'activation-plan',
      outputFile: join(out, 'activation-plan.json'),
      command: 'bun',
      args: [
        'cli/index.ts',
        'recovery',
        'activation-plan',
        '--scope-file',
        join(out, 'recovery-scope.json'),
        '--readiness-report',
        join(out, 'recovery-readiness.json'),
        '--format',
        'json',
      ],
    },
  ]
}

function jsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function parseJsonOutput(stdout: string): unknown | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function commandErrorReport(
  report: GateReportName,
  result: ReturnType<typeof spawnSync<string>>,
  parsedStdout?: unknown,
): Record<string, unknown> {
  return {
    ok: false,
    go_no_go: 'NO_GO',
    report,
    command_error: true,
    exit_code: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed_stdout: parsedStdout && typeof parsedStdout === 'object' ? parsedStdout : undefined,
    mutation_performed: false,
    restart_performed: false,
    blockers: [{
      code: 'REPORT_COMMAND_FAILED',
      evidence: {
        exit_code: result.status,
        stderr: result.stderr,
      },
    }],
  }
}

function parsedReportIsExplicitNoGo(report: unknown): boolean {
  const parsed = asRecord(report)
  if (Object.keys(parsed).length === 0) return false
  if (parsed.mutation_performed === true || parsed.restart_performed === true) return false
  return parsed.go_no_go === 'NO_GO' || parsed.ok === false
}

export function runReport(command: GateCommand, repoRoot: string): unknown {
  const result = spawnSync(command.command, command.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(command.env ?? {}),
    },
  })
  const parsed = parseJsonOutput(result.stdout)
  const report = result.signal
    ? commandErrorReport(command.report, result, parsed)
    : result.status !== 0
      ? parsedReportIsExplicitNoGo(parsed)
        ? parsed
        : commandErrorReport(command.report, result, parsed)
      : parsed && typeof parsed === 'object'
        ? parsed
        : commandErrorReport(command.report, result)
  jsonFile(command.outputFile, report)
  return report
}

function cliSupportsInstallPlan(repoRoot: string): boolean {
  try {
    return readFileSync(join(repoRoot, 'cli', 'index.ts'), 'utf8').includes('install-plan')
  } catch {
    return false
  }
}

function collectInstallPlan(options: GatePackOptions): unknown {
  const outputFile = join(options.outputDir, 'install-plan.json')
  if (!options.includeInstallPlan || !cliSupportsInstallPlan(options.repoRoot)) {
    const report = {
      ok: false,
      go_no_go: 'NO_GO',
      report: 'install-plan',
      dependency_unavailable: true,
      dependency: {
        pr: 672,
        command: 'agent-com state-daemon install-plan',
        reason: options.includeInstallPlan
          ? 'install-plan CLI is not present in this checkout; wait for PR #672 or run from a branch that includes it'
          : 'install-plan collection disabled by operator flag',
      },
      mutation_performed: false,
      restart_performed: false,
      blockers: [{
        code: 'INSTALL_PLAN_UNAVAILABLE_PR_672_PENDING',
        evidence: { include_install_plan: options.includeInstallPlan },
      }],
    }
    jsonFile(outputFile, report)
    return report
  }
  return runReport({
    report: 'install-plan',
    outputFile,
    command: 'bun',
    args: [
      'cli/index.ts',
      'state-daemon',
      'install-plan',
      '--commit',
      options.installPlanCommit,
      '--format',
      'json',
    ],
  }, options.repoRoot)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function blockerCodes(report: Record<string, unknown>): string[] {
  const codes = new Set<string>()
  const preflight = asRecord(report.preflight)
  for (const code of Array.isArray(preflight.failed_blocker_codes) ? preflight.failed_blocker_codes : []) {
    if (typeof code === 'string') codes.add(code)
  }
  for (const item of Array.isArray(preflight.errors) ? preflight.errors : []) {
    const rec = asRecord(item)
    if (typeof rec.code === 'string') codes.add(rec.code)
  }
  for (const item of Array.isArray(report.blockers) ? report.blockers : []) {
    const rec = asRecord(item)
    if (typeof rec.code === 'string') codes.add(rec.code)
  }
  for (const item of Array.isArray(report.findings) ? report.findings : []) {
    const rec = asRecord(item)
    if (rec.severity === 'blocker' && typeof rec.code === 'string') codes.add(rec.code)
  }
  const launchagent = asRecord(report.launchagent)
  const validation = asRecord(launchagent.validation)
  for (const item of Array.isArray(validation.errors) ? validation.errors : []) {
    const rec = asRecord(item)
    if (typeof rec.code === 'string') codes.add(rec.code)
  }
  if (report.command_error === true) codes.add('REPORT_COMMAND_FAILED')
  if (report.dependency_unavailable === true) codes.add('INSTALL_PLAN_UNAVAILABLE_PR_672_PENDING')
  if (report.mutation_performed === true) codes.add('MUTATION_PERFORMED')
  if (report.restart_performed === true) codes.add('RESTART_PERFORMED')
  const contract = asRecord(report.contract)
  if (contract.runtime_delivery_status_contract === 'drift') {
    codes.add('CREDENTIAL_STATUS_CONTRACT_DRIFT')
  }
  return [...codes].sort()
}

function reportIsGo(report: Record<string, unknown>): boolean {
  const preflight = asRecord(report.preflight)
  if (report.command_error === true || report.dependency_unavailable === true) return false
  if (report.mutation_performed === true || report.restart_performed === true) return false
  if (typeof report.go_no_go === 'string' && report.go_no_go !== 'GO') return false
  if (typeof report.ok === 'boolean' && report.ok !== true) return false
  if (typeof preflight.ok === 'boolean' && preflight.ok !== true) return false
  if (typeof preflight.failed_blocker_count === 'number' && preflight.failed_blocker_count > 0) return false
  const hasPositiveGoSignal =
    report.go_no_go === 'GO' ||
    report.ok === true ||
    preflight.ok === true
  return hasPositiveGoSignal && blockerCodes(report).length === 0
}

export function buildSummary(input: {
  evidenceDir: string
  scopeFile: string
  currentMainSha: string | null
  repoHeadSha: string | null
  prDependencies: GateSummary['pr_dependencies']
  reports: Record<GateReportName, unknown>
  now?: Date
}): GateSummary {
  const reports: GateSummary['reports'] = {} as GateSummary['reports']
  const blockers: ReportBlocker[] = []
  for (const name of REQUIRED_REPORTS) {
    const report = asRecord(input.reports[name])
    const codes = blockerCodes(report)
    const ok = reportIsGo(report)
    reports[name] = {
      ok,
      go_no_go: ok ? 'GO' : 'NO_GO',
      mutation_performed: report.mutation_performed === true,
      restart_performed: report.restart_performed === true,
      blocker_codes: codes,
    }
    for (const code of codes.length > 0 ? codes : ok ? [] : ['REPORT_NOT_GO']) {
      blockers.push({ source_report: name, code })
    }
  }
  const ok = blockers.length === 0
  return {
    ok,
    go_no_go: ok ? 'GO' : 'NO_GO',
    generated_at: (input.now ?? new Date()).toISOString(),
    evidence_dir: input.evidenceDir,
    scope_file: input.scopeFile,
    current_main_sha: input.currentMainSha,
    repo_head_sha: input.repoHeadSha,
    pr_dependencies: input.prDependencies,
    reports,
    blockers,
    mutation_performed: false,
    restart_performed: false,
    guardrails: {
      no_state_daemon_restart: true,
      no_launchctl_bootstrap_or_kickstart: true,
      no_discord_live_write: true,
      no_next_inbox_fifo_drain: true,
      no_db_mutation_or_schema_migration: true,
      no_live_runtime_call: true,
      no_automatic_retry_loop: true,
    },
  }
}

export function optionsFromArgv(argv: string[], repoRoot = resolve(join(import.meta.dir, '..'))): GatePackOptions {
  const { flags } = parseArgs(argv)
  const outputDir = resolve(flagString(flags, 'output-dir', 'evidence'))
  const head = repoHead(repoRoot) ?? '0000000'
  return {
    outputDir,
    databaseUrl: flagString(flags, 'database-url', process.env.DATABASE_URL ?? 'postgresql:///agent_comms?host=/tmp'),
    agentId: flagString(flags, 'agent-id', 'codex-cto'),
    recipientAgentId: flagString(flags, 'to-agent', 'ceo'),
    channelId: flagString(flags, 'channel-id', '1487368919613444156'),
    scopeId: flagString(flags, 'scope-id', 'cp80-recovery-canary-602'),
    installPlanCommit: flagString(flags, 'install-plan-commit', head),
    includeInstallPlan: !flagBool(flags, 'skip-install-plan', false),
    repoRoot,
  }
}

export function collectGatePack(options: GatePackOptions): GateSummary {
  mkdirSync(options.outputDir, { recursive: true })
  const scopeFile = join(options.outputDir, 'recovery-scope.json')
  jsonFile(scopeFile, defaultScope(options))

  const reports: Record<GateReportName, unknown> = {} as Record<GateReportName, unknown>
  for (const command of buildReadOnlyGateCommands(options)) {
    reports[command.report] = runReport(command, options.repoRoot)
  }
  reports['install-plan'] = collectInstallPlan(options)

  const summary = buildSummary({
    evidenceDir: options.outputDir,
    scopeFile,
    currentMainSha: currentMain(options.repoRoot),
    repoHeadSha: repoHead(options.repoRoot),
    prDependencies: {
      pr_671_local_supervisor_adapter: ghPrStatus(options.repoRoot, 671),
      pr_672_install_plan: ghPrStatus(options.repoRoot, 672),
    },
    reports,
  })
  jsonFile(join(options.outputDir, 'summary.json'), summary)
  return summary
}

if (import.meta.main) {
  const summary = collectGatePack(optionsFromArgv(process.argv))
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exit(summary.ok ? 0 : 1)
}
