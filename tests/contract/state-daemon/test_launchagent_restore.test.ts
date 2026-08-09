import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildGithubWorkPullerLaunchAgentEnv,
  buildStateDaemonRestorePlan,
  parseStateDaemonLaunchAgentPlist,
  planStateDaemonRestorePrune,
  protectedPathsFromLaunchAgentPlists,
  renderStateDaemonLaunchAgentPlist,
  STATE_DAEMON_DB_SSOT_CANARY_TARGETS,
  STATE_DAEMON_DB_SSOT_DESIGN_SUBJECT_DIGEST,
  validateStateDaemonCanaryOverlayEnv,
  validateStateDaemonLaunchAgentConfig,
  validateQueueWorkCanaryResiduePreflight,
} from '../../../core/state-daemon/launchagent'
import { loadQueueWorkResiduePolicyFile } from '../../../core/state-daemon/queue-work-residue-policy'
import {
  SHIRUBE_D1_FLEET_ACTIVATION_REF,
  SHIRUBE_D1_FLEET_TARGETS,
} from '../../../core/shirube-d1-activation-policy'

const REPO = join(import.meta.dir, '..', '..', '..')

function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(proc.exitCode, proc.stderr.toString()).toBe(0)
  return proc.stdout.toString().trim()
}

function probe(existingFiles: string[], existingDirs: string[], executableFiles: string[] = existingFiles) {
  const files = new Set(existingFiles)
  const dirs = new Set(existingDirs)
  const executable = new Set(executableFiles)
  return {
    exists: (path: string) => files.has(path) || dirs.has(path),
    isDirectory: (path: string) => dirs.has(path),
    isFile: (path: string) => files.has(path),
    isExecutable: (path: string) => executable.has(path),
  }
}

class RecordingResidueDb {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = []

  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.queries.push({ sql, params })
    return { rows: this.rows as T[], rowCount: this.rows.length }
  }
}

const RESIDUE_POLICY_FILE = join(REPO, 'config', 'queue-work-residue-policy.json')

function canaryOverlayEnv(target = 'aun'): Record<string, string> {
  return {
    STATE_DAEMON_AGENT_ALLOWLIST: target,
    STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF: 'https://github.com/watchout/agent-comms-mcp/issues/917#issuecomment-5213450982',
    STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF: 'https://github.com/watchout/agent-comms-mcp/issues/917#issuecomment-5213090076',
    STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT: '2099-08-08T14:59:59.000Z',
    STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256: 'a'.repeat(64),
    STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND: 'cp /evidence/prior.plist /evidence/installed.plist',
    STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION: 'https://github.com/watchout/agent-comms-mcp/issues/917#issuecomment-observed',
    STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST: STATE_DAEMON_DB_SSOT_DESIGN_SUBJECT_DIGEST,
  }
}

function queueWorkResidueEnv(agentId: string, withPolicy: boolean): Record<string, string> {
  return {
    STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
    STATE_DAEMON_AGENT_ALLOWLIST: agentId,
    STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
    STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
    STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'fresh-canary-message-id',
    STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER: '2026-06-15T00:00:00Z',
    ...(withPolicy ? { STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: RESIDUE_POLICY_FILE } : {}),
  }
}

function shirubeD1FleetRestoreEnv(): Record<string, string> {
  return {
    SHIRUBE_D1_ENABLED: '1',
    SHIRUBE_D1_KILL_SWITCH: '0',
    SHIRUBE_D1_ACTIVATION_MODE: 'fleet',
    SHIRUBE_D1_TARGET_ALLOWLIST: JSON.stringify(SHIRUBE_D1_FLEET_TARGETS),
    SHIRUBE_D1_AUTHORIZATION_DIGEST: 'a'.repeat(64),
    SHIRUBE_D1_ADAPTER_HEAD_SHA: 'b'.repeat(40),
    SHIRUBE_D1_AUDIT_REF: 'https://github.com/watchout/agent-comms-mcp/pull/890#issuecomment-audit',
    SHIRUBE_D1_QA_REF: 'https://github.com/watchout/agent-comms-mcp/pull/890#issuecomment-qa',
    SHIRUBE_D1_CHECK_REF: 'https://github.com/watchout/agent-comms-mcp/pull/890#issuecomment-check',
    SHIRUBE_D1_CTO_GO_REF: 'https://github.com/watchout/agent-comms-mcp/pull/890#issuecomment-cto',
    SHIRUBE_D1_FLEET_ACTIVATION_REF,
  }
}

describe('#603 state-daemon LaunchAgent durable restore contract', () => {
  test('restore plan defaults to a durable operator-owned checkout, not /private/tmp', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const plist = renderStateDaemonLaunchAgentPlist(plan)
    const config = parseStateDaemonLaunchAgentPlist(plist)

    expect(plan.checkoutPath).toBe('/Users/yuji/.agent-comms/state-daemon/checkouts/316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9')
    expect(config.programArguments[1]).toBe(join(plan.checkoutPath, 'bin', 'state-daemon.ts'))
    expect(config.workingDirectory).toBe(plan.checkoutPath)
    expect(plist).not.toContain('/private/tmp/agent-comms-state-daemon')
    expect(plist).not.toContain('<key>STATE_DAEMON_AGENT_ALLOWLIST</key>')
    expect(plist).not.toContain('STATE_DAEMON_CANARY_OVERLAY_')
  })

  test('Issue #917 typed canary overlay accepts one exact cohort target with complete rollback evidence', () => {
    const result = validateStateDaemonCanaryOverlayEnv(
      canaryOverlayEnv('aun'),
      new Date('2026-08-07T00:00:00.000Z'),
    )

    expect(result).toMatchObject({ active: true, target: 'aun', issues: [] })
    expect(STATE_DAEMON_DB_SSOT_CANARY_TARGETS).toEqual(['aun', 'codex-audit', 'adf-lead', 'devauditor'])
  })

  test('Issue #917 typed canary overlay blocks missing, duplicate, expired, retired, wrong-subject, and outside-cohort records', () => {
    const valid = canaryOverlayEnv('aun')
    const fixtures: Array<[string, Record<string, string>, string]> = [
      ['missing', { ...valid, STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND: '' }, 'state_daemon_canary_overlay_identity_incomplete'],
      ['duplicate', { ...valid, STATE_DAEMON_AGENT_ALLOWLIST: 'aun,codex-audit' }, 'state_daemon_canary_overlay_target_not_exact'],
      ['expired', { ...valid, STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT: '2026-08-06T00:00:00.000Z' }, 'state_daemon_canary_overlay_expired'],
      ['retired', canaryOverlayEnv('codex-aun'), 'state_daemon_canary_overlay_retired_target'],
      ['wrong-subject', { ...valid, STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST: `sha256:${'b'.repeat(64)}` }, 'state_daemon_canary_overlay_subject_digest_mismatch'],
      ['outside-cohort', canaryOverlayEnv('qa'), 'state_daemon_canary_overlay_target_outside_cohort'],
      ['same-control-and-owner-ref', { ...valid, STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF: valid.STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF }, 'state_daemon_canary_overlay_refs_not_distinct'],
    ]

    for (const [name, env, expectedCode] of fixtures) {
      const result = validateStateDaemonCanaryOverlayEnv(env, new Date('2026-08-07T00:00:00.000Z'))
      expect(result.issues.map((issue) => issue.code), name).toContain(expectedCode)
    }
  })

  test('preflight refuses missing ProgramArguments[1] and WorkingDirectory before launchd load', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath], []) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors.map((err) => err.code)).toEqual(expect.arrayContaining([
      'state_daemon_entry_missing',
      'working_directory_missing',
    ]))
    expect(result.errors.find((err) => err.code === 'state_daemon_entry_missing')?.message).toContain('Module not found')
  })

  test('preflight refuses a missing bun executable before launchd load', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.entryPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'bun_path_missing',
        path: plan.bunPath,
      }),
    ]))
    expect(result.errors.find((err) => err.code === 'bun_path_missing')?.message).toContain('cannot exec bun')
  })

  test('preflight refuses a bun path that is a directory before launchd load', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.entryPath], [plan.bunPath, plan.checkoutPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'bun_path_not_file',
        path: plan.bunPath,
      }),
    ]))
    expect(result.errors.find((err) => err.code === 'bun_path_not_file')?.message).toContain('regular executable file')
  })

  test('preflight refuses a non-executable bun file before launchd load', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath], [plan.checkoutPath], [plan.entryPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'bun_path_not_executable',
        path: plan.bunPath,
      }),
    ]))
    expect(result.errors.find((err) => err.code === 'bun_path_not_executable')?.message).toContain('not executable')
  })

  test('preflight rejects unowned /private/tmp detached checkout targets', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/private/tmp/agent-comms-state-daemon-316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ephemeral_launchagent_path',
        path: plan.entryPath,
      }),
      expect.objectContaining({
        code: 'ephemeral_launchagent_path',
        path: plan.checkoutPath,
      }),
    ]))
  })

  test('preflight passes only after checkout, entrypoint, and WorkingDirectory exist', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(true)
  })

  test('bounded GitHub work puller LaunchAgent env uses a token file and exact canary scope', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const tokenFile = '/Users/yuji/.config/agent-comms/github-work-token'
    const extraEnv = buildGithubWorkPullerLaunchAgentEnv({
      enabled: true,
      repos: ['watchout/agent-comms-mcp'],
      labels: ['canary:github-work-puller'],
      ownerAllowlist: ['agent-com-dev'],
      intervalMs: 120_000,
      writebackEnabled: true,
      tokenFile,
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan, extraEnv))
    const result = validateStateDaemonLaunchAgentConfig(config, {
      probe: probe([plan.bunPath, plan.entryPath, tokenFile], [plan.checkoutPath]),
    })

    expect(extraEnv).toMatchObject({
      STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED: '1',
      STATE_DAEMON_GITHUB_WORK_REPOS: 'watchout/agent-comms-mcp',
      STATE_DAEMON_GITHUB_WORK_LABELS: 'canary:github-work-puller',
      STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST: 'agent-com-dev',
      STATE_DAEMON_GITHUB_WORK_INTERVAL_MS: '120000',
      STATE_DAEMON_GITHUB_WORK_WRITEBACK_ENABLED: '1',
      STATE_DAEMON_GITHUB_TOKEN_FILE: tokenFile,
    })
    expect(extraEnv).not.toHaveProperty('STATE_DAEMON_GITHUB_TOKEN')
    expect(extraEnv).not.toHaveProperty('GITHUB_TOKEN')
    expect(result.ok).toBe(true)
  })

  test('bounded GitHub work puller LaunchAgent activation fails closed on broad or unsafe config', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const tokenFile = '/Users/yuji/.config/agent-comms/github-work-token'
    const baseEnv = {
      STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED: '1',
      STATE_DAEMON_GITHUB_WORK_REPOS: 'watchout/agent-comms-mcp',
      STATE_DAEMON_GITHUB_WORK_LABELS: 'canary:github-work-puller',
      STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST: 'agent-com-dev',
      STATE_DAEMON_GITHUB_TOKEN_FILE: tokenFile,
    }
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ STATE_DAEMON_GITHUB_WORK_REPOS: 'watchout/agent-comms-mcp,watchout/iyasaka-arc' }, 'github_work_puller_requires_single_repo'],
      [{ STATE_DAEMON_GITHUB_WORK_LABELS: 'needs:impl' }, 'github_work_puller_requires_single_canary_label'],
      [{ STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST: 'agent-com-dev,codex-audit' }, 'github_work_puller_requires_single_owner_allowlist'],
      [{ STATE_DAEMON_GITHUB_TOKEN_FILE: undefined }, 'github_work_puller_token_file_required'],
      [{ STATE_DAEMON_GITHUB_TOKEN: 'raw-token' }, 'github_token_embedded_in_launchagent'],
    ]

    for (const [patch, expectedCode] of cases) {
      const env = { ...baseEnv, ...patch }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete env[key as keyof typeof env]
      }
      const result = validateStateDaemonLaunchAgentConfig(
        parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan, env as Record<string, string>)),
        { probe: probe([plan.bunPath, plan.entryPath, tokenFile], [plan.checkoutPath]) },
      )
      expect(result.ok).toBe(false)
      expect(result.errors.map((err) => err.code)).toContain(expectedCode)
    }
  })

  test('restore helper dry-run renders bounded GitHub work puller env without writing token values', () => {
    const tokenFile = '/Users/yuji/.config/agent-comms/github-work-token'
    const proc = Bun.spawnSync([
      'bun',
      'scripts/state-daemon-launchagent.ts',
      'restore',
      '--commit',
      '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      '--github-work-puller-enabled',
      '--github-work-repos',
      'watchout/agent-comms-mcp',
      '--github-work-labels',
      'canary:github-work-puller',
      '--github-work-owner-allowlist',
      'agent-com-dev',
      '--github-work-interval-ms',
      '120000',
      '--github-work-writeback-enabled',
      '--github-token-file',
      tokenFile,
    ], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    const out = JSON.parse(proc.stdout.toString())
    expect(out.dry_run).toBe(true)
    expect(out.extraEnv).toMatchObject({
      STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED: '1',
      STATE_DAEMON_GITHUB_WORK_REPOS: 'watchout/agent-comms-mcp',
      STATE_DAEMON_GITHUB_WORK_LABELS: 'canary:github-work-puller',
      STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST: 'agent-com-dev',
      STATE_DAEMON_GITHUB_WORK_WRITEBACK_ENABLED: '1',
      STATE_DAEMON_GITHUB_TOKEN_FILE: tokenFile,
    })
    expect(proc.stdout.toString()).not.toContain('raw-token')
    expect(out.extraEnv.STATE_DAEMON_GITHUB_TOKEN).toBeUndefined()
    expect(out.extraEnv.GITHUB_TOKEN).toBeUndefined()
  })

  test('queue-work scheduler steady state needs runtime and a fleet decision or bounded fence, not a host allowlist', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
      },
    })
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors.map((err) => err.code)).toEqual(expect.arrayContaining([
      'queue_work_runtime_unconfigured',
      'queue_work_scheduler_requires_canary_fence',
    ]))
    expect(result.errors.map((err) => err.code)).not.toContain('queue_work_scheduler_requires_single_agent_allowlist')
  })

  test('queue-work scheduler codex-exec activation requires the result schema before launchd load', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        ...canaryOverlayEnv('aun'),
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'msg-canary',
      },
    })
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'queue_work_codex_schema_missing',
        path: join(plan.checkoutPath, 'schemas', 'queue-work-result-v1.schema.json'),
      }),
    ]))
  })

  test('queue-work scheduler codex-exec activation passes with exact typed aun overlay and schema', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        ...canaryOverlayEnv('aun'),
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'msg-canary',
      },
    })
    const schemaPath = join(plan.checkoutPath, 'schemas', 'queue-work-result-v1.schema.json')
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath, schemaPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(true)
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    expect(config.environmentVariables.STATE_DAEMON_AGENT_ALLOWLIST).toBe('aun')
    expect(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_RUNTIME).toBe('codex-exec')
    expect(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS).toBe('msg-canary')
  })

  test('queue-work GitHub-backed handoff activation fails closed without mediated posting', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        ...canaryOverlayEnv('codex-audit'),
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'msg-canary',
        STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT: 'github_backed_role_handoff',
      },
    })
    const schemaPath = join(plan.checkoutPath, 'schemas', 'queue-work-result-v1.schema.json')
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath, schemaPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'queue_work_github_handoff_requires_mediated_posting' }),
      expect.objectContaining({ code: 'queue_work_mediated_posting_command_missing' }),
    ]))
  })

  test('queue-work GitHub-backed handoff activation passes with explicit mediated posting command', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        ...canaryOverlayEnv('codex-audit'),
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'msg-canary',
        STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT: 'github_backed_role_handoff',
        STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE: 'mediated',
        STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND: '/Users/yuji/bin/agent-comms-post-github-comment',
      },
    })
    const schemaPath = join(plan.checkoutPath, 'schemas', 'queue-work-result-v1.schema.json')
    const postingCommand = '/Users/yuji/bin/agent-comms-post-github-comment'
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath, schemaPath, postingCommand], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(true)
  })

  test('queue-work scheduler activation fails closed when residue policy file is missing', () => {
    const policyPath = '/Users/yuji/.agent-comms/state-daemon/residue-policy.json'
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'fresh-canary-message-id',
        STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: policyPath,
      },
    })
    const schemaPath = join(plan.checkoutPath, 'schemas', 'queue-work-result-v1.schema.json')
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath, schemaPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'queue_work_residue_policy_file_missing',
        path: policyPath,
      }),
    ]))
  })

  test('queue-work scheduler activation fails closed when residue policy path is not a file', () => {
    const policyPath = '/Users/yuji/.agent-comms/state-daemon/residue-policy'
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'fresh-canary-message-id',
        STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: policyPath,
      },
    })
    const schemaPath = join(plan.checkoutPath, 'schemas', 'queue-work-result-v1.schema.json')
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath, schemaPath], [plan.checkoutPath, policyPath]) },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'queue_work_residue_policy_file_not_file',
        path: policyPath,
      }),
    ]))
  })

  test('queue-work scheduler canary residue preflight blocks non-fenced target residue without policy before launchd mutation', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: '85b7fa6f-d60a-4ebb-90da-9c53bf15e840',
        STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER: '2026-06-15T08:18:34Z',
      },
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 120245,
      agent_id: 'qa',
      message_id: 'ab20f921-4b99-4392-960a-673ee834292a',
      payload: JSON.stringify({
        receive_claim: { source: 'state-daemon-queue-work-scheduler' },
        runner_error: {
          code: 'ADAPTER_ERROR',
          invocation_source: 'state-daemon-queue-work-scheduler',
        },
      }),
      status: 'pending',
      created_at: '2026-06-14T08:46:57.674Z',
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables)

    expect(result.ok).toBe(false)
    expect(result.residues.map((row) => row.id)).toEqual([120245])
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'queue_work_residue_policy_missing',
      }),
    ]))
    expect(db.queries[0]?.sql).toContain("mq.status IN ('pending', 'received', 'in_progress')")
    expect(db.queries[0]?.sql).toContain('AND NOT (COALESCE(mq.message_id = ANY')
    expect(db.queries[0]?.sql).toContain('mq.created_at >=')
  })

  test('queue-work scheduler canary residue preflight passes for exact policy-classified residue', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: '85b7fa6f-d60a-4ebb-90da-9c53bf15e840',
        STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER: '2026-06-15T08:18:34Z',
        STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: join(REPO, 'config', 'queue-work-residue-policy.json'),
      },
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 120245,
      agent_id: 'qa',
      message_id: 'ab20f921-4b99-4392-960a-673ee834292a',
      payload: JSON.stringify({
        receive_claim: { source: 'state-daemon-queue-work-scheduler' },
        runner_error: {
          code: 'ADAPTER_ERROR',
          invocation_source: 'state-daemon-queue-work-scheduler',
        },
      }),
      status: 'pending',
      created_at: '2026-06-14T08:46:57.674Z',
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables, {
      residuePolicy: loadQueueWorkResiduePolicyFile(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE),
    })

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.residues.map((row) => row.id)).toEqual([120245])
  })

  test('queue-work scheduler canary residue preflight fails closed on policy identity drift', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'fresh-canary-message-id',
        STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: join(REPO, 'config', 'queue-work-residue-policy.json'),
      },
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 120245,
      agent_id: 'qa',
      message_id: 'drifted-message-id',
      payload: JSON.stringify({
        receive_claim: { source: 'manual-next' },
        runner_error: {
          code: 'OTHER',
          invocation_source: 'manual-next',
        },
      }),
      status: 'pending',
      created_at: '2026-06-14T08:46:57.674Z',
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables, {
      residuePolicy: loadQueueWorkResiduePolicyFile(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE),
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'queue_work_residue_policy_mismatch',
      }),
    ]))
    expect(result.errors[0]?.message).toContain('message_id expected ab20f921-4b99-4392-960a-673ee834292a')
  })

  test('queue-work scheduler canary residue preflight blocks 120138 GitHub puller residue without policy', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: queueWorkResidueEnv('agent-com-dev', false),
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 120138,
      agent_id: 'agent-com-dev',
      message_id: null,
      payload: JSON.stringify({ source: 'state-daemon-github-work-puller-canary' }),
      status: 'pending',
      created_at: '2026-06-14T08:00:00.000Z',
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables)

    expect(result.ok).toBe(false)
    expect(result.residues.map((row) => row.id)).toEqual([120138])
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'queue_work_residue_policy_missing' }),
    ]))
  })

  test('queue-work scheduler canary residue preflight passes for exact 120138 GitHub puller residue', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: queueWorkResidueEnv('agent-com-dev', true),
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 120138,
      agent_id: 'agent-com-dev',
      message_id: null,
      payload: JSON.stringify({ source: 'state-daemon-github-work-puller-canary' }),
      status: 'pending',
      created_at: '2026-06-14T08:00:00.000Z',
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables, {
      residuePolicy: loadQueueWorkResiduePolicyFile(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE),
    })

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.residues.map((row) => row.id)).toEqual([120138])
  })

  test('queue-work scheduler canary residue preflight fails closed on 120138 identity drift', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: queueWorkResidueEnv('agent-com-dev', true),
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 120138,
      agent_id: 'agent-com-dev',
      message_id: 'drifted-message-id',
      payload: JSON.stringify({ source: 'manual-dispatch' }),
      status: 'pending',
      created_at: '2026-06-14T08:00:00.000Z',
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables, {
      residuePolicy: loadQueueWorkResiduePolicyFile(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE),
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'queue_work_residue_policy_mismatch' }),
    ]))
    expect(result.errors[0]?.message).toContain('message_id expected null')
    expect(result.errors[0]?.message).toContain('payload.source expected state-daemon-github-work-puller-canary')
  })

  test('queue-work scheduler canary residue preflight blocks 121744 incomplete scheduler residue without policy', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: queueWorkResidueEnv('secretary', false),
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 121744,
      agent_id: 'secretary',
      message_id: '51647a24-0bfe-4efc-8cc8-2c795069bbf0',
      payload: JSON.stringify({
        receive_claim: { source: 'state-daemon-queue-work-scheduler' },
      }),
      status: 'in_progress',
      created_at: '2026-06-15T10:51:34.000Z',
      claimed_by: 'secretary',
      claimed_at: '2026-06-15T10:51:35.000Z',
      claim_expires_at: '2026-06-15T10:52:35.000Z',
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables)

    expect(result.ok).toBe(false)
    expect(result.residues.map((row) => row.id)).toEqual([121744])
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'queue_work_residue_policy_missing' }),
    ]))
  })

  test('queue-work scheduler canary residue preflight passes for exact 121744 incomplete scheduler residue', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: queueWorkResidueEnv('secretary', true),
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 121744,
      agent_id: 'secretary',
      message_id: '51647a24-0bfe-4efc-8cc8-2c795069bbf0',
      payload: JSON.stringify({
        receive_claim: { source: 'state-daemon-queue-work-scheduler' },
      }),
      status: 'in_progress',
      created_at: '2026-06-15T10:51:34.000Z',
      claimed_by: 'secretary',
      claimed_at: '2026-06-15T10:51:35.000Z',
      claim_expires_at: '2026-06-15T10:52:35.000Z',
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables, {
      residuePolicy: loadQueueWorkResiduePolicyFile(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE),
    })

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.residues.map((row) => row.id)).toEqual([121744])
  })

  test('queue-work scheduler canary residue preflight fails closed on 121744 status message and source drift', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: queueWorkResidueEnv('secretary', true),
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([{
      id: 121744,
      agent_id: 'secretary',
      message_id: 'drifted-message-id',
      payload: JSON.stringify({
        receive_claim: { source: 'manual-next' },
      }),
      status: 'received',
      created_at: '2026-06-15T10:51:34.000Z',
      claimed_by: 'secretary',
      claimed_at: '2026-06-15T10:51:35.000Z',
      claim_expires_at: '2026-06-15T10:52:35.000Z',
    }])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables, {
      residuePolicy: loadQueueWorkResiduePolicyFile(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE),
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'queue_work_residue_policy_mismatch' }),
    ]))
    expect(result.errors[0]?.message).toContain('status expected one of in_progress')
    expect(result.errors[0]?.message).toContain('message_id expected 51647a24-0bfe-4efc-8cc8-2c795069bbf0')
    expect(result.errors[0]?.message).toContain('receive_claim.source expected state-daemon-queue-work-scheduler')
  })

  test('queue-work scheduler canary residue preflight passes when only fenced rows are visible', async () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: '85b7fa6f-d60a-4ebb-90da-9c53bf15e840',
        STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER: '2026-06-15T08:18:34Z',
      },
    })
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    const db = new RecordingResidueDb([])

    const result = await validateQueueWorkCanaryResiduePreflight(db, config.environmentVariables)

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.residues).toEqual([])
  })

  test('restore helper dry-run merges GitHub puller and queue-work activation env', () => {
    const tokenFile = '/Users/yuji/.config/agent-comms/github-work-token'
    const { STATE_DAEMON_AGENT_ALLOWLIST: _, ...overlayMetadata } = canaryOverlayEnv('aun')
    const proc = Bun.spawnSync([
      'bun',
      'scripts/state-daemon-launchagent.ts',
      'restore',
      '--commit',
      '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      '--github-work-puller-enabled',
      '--github-work-repos',
      'watchout/agent-comms-mcp',
      '--github-work-labels',
      'canary:github-work-puller',
      '--github-work-owner-allowlist',
      'agent-com-dev',
      '--github-token-file',
      tokenFile,
      '--enable-queue-work-scheduler',
      '--agent-allowlist',
      'aun',
      '--canary-overlay-env-json',
      JSON.stringify(overlayMetadata),
      '--queue-work-runtime',
      'codex-exec',
      '--queue-work-finalize',
      '--queue-work-fence-message-ids',
      'msg-canary',
    ], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    const out = JSON.parse(proc.stdout.toString())
    expect(out.extraEnv).toMatchObject({
      STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED: '1',
      STATE_DAEMON_GITHUB_TOKEN_FILE: tokenFile,
      STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
      STATE_DAEMON_AGENT_ALLOWLIST: 'aun',
      STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
      STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
      STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'msg-canary',
    })
    expect(out.plan.extraEnv).toMatchObject(out.extraEnv)
  })

  test('restore helper binds repository-relative runtime policy paths to the durable checkout', () => {
    const commit = '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9'
    const restoreRoot = '/Users/yuji/.agent-comms/state-daemon/checkouts'
    const proc = Bun.spawnSync([
      'bun',
      'scripts/state-daemon-launchagent.ts',
      'restore',
      '--commit',
      commit,
      '--restore-root',
      restoreRoot,
      '--queue-work-residue-policy-file',
      'config/queue-work-residue-policy.json',
      '--queue-work-mediated-posting-command',
      'scripts/queue-work-mediated-posting.ts',
    ], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    const out = JSON.parse(proc.stdout.toString())
    const checkoutPath = join(restoreRoot, commit)
    expect(out.extraEnv.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE).toBe(
      join(checkoutPath, 'config', 'queue-work-residue-policy.json'),
    )
    expect(out.extraEnv.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND).toBe(
      join(checkoutPath, 'scripts', 'queue-work-mediated-posting.ts'),
    )
    expect(out.plan.extraEnv).toEqual(out.extraEnv)
  })

  test('restore helper dry-run can render bounded queue-work rollback env', () => {
    const { STATE_DAEMON_AGENT_ALLOWLIST: _, ...overlayMetadata } = canaryOverlayEnv('codex-audit')
    const proc = Bun.spawnSync([
      'bun',
      'scripts/state-daemon-launchagent.ts',
      'restore',
      '--commit',
      '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      '--agent-allowlist',
      'codex-audit',
      '--canary-overlay-env-json',
      JSON.stringify(overlayMetadata),
      '--disable-codex-runner',
    ], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    const out = JSON.parse(proc.stdout.toString())
    expect(out.dry_run).toBe(true)
    expect(out.extraEnv).toMatchObject({
      STATE_DAEMON_AGENT_ALLOWLIST: 'codex-audit',
      STATE_DAEMON_CODEX_RUNNER_ENABLED: '0',
    })
    expect(out.extraEnv.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED).toBeUndefined()
    expect(out.plan.extraEnv).toMatchObject(out.extraEnv)
  })

  test('restore helper dry-run renders only bounded Shirube D1 fleet and rollback env', () => {
    const fleetEnv = shirubeD1FleetRestoreEnv()
    const run = (env: Record<string, string>) => Bun.spawnSync([
      'bun',
      'scripts/state-daemon-launchagent.ts',
      'restore',
      '--commit',
      '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      '--shirube-d1-env-json',
      JSON.stringify(env),
    ], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })

    const fleet = run(fleetEnv)
    expect(fleet.exitCode, fleet.stderr.toString()).toBe(0)
    const fleetOut = JSON.parse(fleet.stdout.toString())
    expect(fleetOut.extraEnv).toEqual(fleetEnv)
    expect(fleetOut.plan.extraEnv).toEqual(fleetEnv)

    const rollbackEnv = { SHIRUBE_D1_ENABLED: '0', SHIRUBE_D1_KILL_SWITCH: '1', SHIRUBE_D1_TARGET_ALLOWLIST: '' }
    const rollback = run(rollbackEnv)
    expect(rollback.exitCode, rollback.stderr.toString()).toBe(0)
    const rollbackOut = JSON.parse(rollback.stdout.toString())
    expect(rollbackOut.extraEnv).toEqual(rollbackEnv)
    expect(rollbackOut.plan.extraEnv).toEqual(rollbackEnv)
  })

  test('restore helper rejects arbitrary or non-string Shirube D1 env entries', () => {
    for (const input of [
      { PATH: '/tmp/untrusted' },
      { SHIRUBE_D1_ENABLED: 1 },
      { ...shirubeD1FleetRestoreEnv(), SHIRUBE_D1_FLEET_ACTIVATION_REF: 'https://github.com/unrelated/repo/issues/1' },
    ]) {
      const proc = Bun.spawnSync([
        'bun',
        'scripts/state-daemon-launchagent.ts',
        'restore',
        '--commit',
        '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
        '--shirube-d1-env-json',
        JSON.stringify(input),
      ], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
      expect(proc.exitCode).not.toBe(0)
      expect(proc.stderr.toString()).toContain('--shirube-d1-env-json')
    }
  })

  test('restore verification build artifact does not dirty an existing checkout for repeat restore', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'state-daemon-restore-repeat-'))
    try {
      const commit = '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9'
      const plan = buildStateDaemonRestorePlan({
        commit,
        restoreRoot: join(tmp, 'checkouts'),
        launchAgentsDir: join(tmp, 'LaunchAgents'),
      })
      mkdirSync(plan.checkoutPath, { recursive: true })
      git(['init'], plan.checkoutPath)
      writeFileSync(join(plan.checkoutPath, 'README.md'), 'clean checkout\n')
      git(['add', 'README.md'], plan.checkoutPath)
      git(['-c', 'user.name=agent-comms-test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed'], plan.checkoutPath)

      mkdirSync(dirname(plan.buildOutfile), { recursive: true })
      writeFileSync(plan.buildOutfile, 'helper-owned build output\n')

      expect(plan.buildOutfile.startsWith(`${plan.checkoutPath}/`)).toBe(false)
      expect(git(['status', '--short'], plan.checkoutPath)).toBe('')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('prune protects paths referenced by the active state-daemon LaunchAgent', () => {
    const root = '/Users/yuji/.agent-comms/state-daemon/checkouts'
    const activePlan = buildStateDaemonRestorePlan({
      commit: 'bbbbbbb',
      restoreRoot: root,
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const activePlist = renderStateDaemonLaunchAgentPlist(activePlan)
    const protectedPaths = protectedPathsFromLaunchAgentPlists([activePlist])
    const targets = planStateDaemonRestorePrune({
      restoreRoot: root,
      checkoutDirs: [
        `${root}/aaaaaaa`,
        activePlan.checkoutPath,
        `${root}/ccccccc`,
      ],
      activeLaunchAgentPlists: [activePlist],
      keep: 1,
    })

    expect(protectedPaths).toContain(activePlan.checkoutPath)
    expect(targets).toEqual([
      { path: `${root}/aaaaaaa`, action: 'delete', reason: 'older_than_keep_window' },
      { path: activePlan.checkoutPath, action: 'protect', reason: 'referenced_by_active_launchagent' },
      { path: `${root}/ccccccc`, action: 'keep', reason: 'within_keep_last_1' },
    ])
  })

  test('prune defaults to a safe keep window when called with an invalid keep value', () => {
    const root = '/Users/yuji/.agent-comms/state-daemon/checkouts'
    const targets = planStateDaemonRestorePrune({
      restoreRoot: root,
      checkoutDirs: [
        `${root}/aaaaaaa`,
        `${root}/bbbbbbb`,
        `${root}/ccccccc`,
        `${root}/ddddddd`,
      ],
      keep: Number.NaN,
    })

    expect(targets).toEqual([
      { path: `${root}/aaaaaaa`, action: 'delete', reason: 'older_than_keep_window' },
      { path: `${root}/bbbbbbb`, action: 'keep', reason: 'within_keep_last_3' },
      { path: `${root}/ccccccc`, action: 'keep', reason: 'within_keep_last_3' },
      { path: `${root}/ddddddd`, action: 'keep', reason: 'within_keep_last_3' },
    ])
  })

  test('restore helper rejects invalid prune --keep values before planning deletes', () => {
    const proc = Bun.spawnSync([
      'bun',
      'scripts/state-daemon-launchagent.ts',
      'prune',
      '--restore-root',
      '/tmp/agent-comms-state-daemon-checkouts',
      '--keep',
      'not-a-number',
    ], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(proc.exitCode).not.toBe(0)
    expect(proc.stderr.toString()).toContain('--keep requires a non-negative integer')
  })

  test('restore helper verifies checkout/build and preflight before atomic plist replace and launchd bootstrap', () => {
    const src = readFileSync(join(REPO, 'scripts', 'state-daemon-launchagent.ts'), 'utf8')
    const ensureCheckout = src.indexOf('ensureCheckout(plan)')
    const verifyCheckout = src.indexOf('verifyCheckout(plan)')
    const stagedPreflight = src.indexOf('const installedPreflight = validateStateDaemonLaunchAgentConfig')
    const residuePreflight = src.indexOf('completeRestoreAfterQueueWorkCanaryResiduePreflight(stagedConfig')
    const rename = src.indexOf('renameSync(plan.tempPlistPath, plan.plistPath)')
    const bootstrap = src.indexOf('bootstrap(plan.plistPath)')

    expect(ensureCheckout).toBeGreaterThan(-1)
    expect(verifyCheckout).toBeGreaterThan(ensureCheckout)
    expect(stagedPreflight).toBeGreaterThan(verifyCheckout)
    expect(residuePreflight).toBeGreaterThan(stagedPreflight)
    expect(rename).toBeGreaterThan(residuePreflight)
    expect(bootstrap).toBeGreaterThan(rename)
  })
})
