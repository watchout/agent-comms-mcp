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
  validateStateDaemonLaunchAgentConfig,
} from '../../../core/state-daemon/launchagent'

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

  test('queue-work scheduler activation fails closed without a single-agent allowlist and runtime', () => {
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
      'queue_work_scheduler_requires_single_agent_allowlist',
      'queue_work_runtime_unconfigured',
    ]))
  })

  test('queue-work scheduler codex-exec activation requires the result schema before launchd load', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
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

  test('queue-work scheduler codex-exec activation passes with exact qa allowlist and schema', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      extraEnv: {
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
        STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
        STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
      },
    })
    const schemaPath = join(plan.checkoutPath, 'schemas', 'queue-work-result-v1.schema.json')
    const result = validateStateDaemonLaunchAgentConfig(
      parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
      { probe: probe([plan.bunPath, plan.entryPath, schemaPath], [plan.checkoutPath]) },
    )

    expect(result.ok).toBe(true)
    const config = parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan))
    expect(config.environmentVariables.STATE_DAEMON_AGENT_ALLOWLIST).toBe('qa')
    expect(config.environmentVariables.STATE_DAEMON_QUEUE_WORK_RUNTIME).toBe('codex-exec')
  })

  test('restore helper dry-run merges GitHub puller and queue-work activation env', () => {
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
      '--github-token-file',
      tokenFile,
      '--enable-queue-work-scheduler',
      '--agent-allowlist',
      'qa',
      '--queue-work-runtime',
      'codex-exec',
      '--queue-work-finalize',
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
      STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
      STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
      STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
    })
    expect(out.plan.extraEnv).toMatchObject(out.extraEnv)
  })

  test('restore helper dry-run can render bounded queue-work rollback env', () => {
    const proc = Bun.spawnSync([
      'bun',
      'scripts/state-daemon-launchagent.ts',
      'restore',
      '--commit',
      '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9',
      '--agent-allowlist',
      'qa',
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
      STATE_DAEMON_AGENT_ALLOWLIST: 'qa',
      STATE_DAEMON_CODEX_RUNNER_ENABLED: '0',
    })
    expect(out.extraEnv.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED).toBeUndefined()
    expect(out.plan.extraEnv).toMatchObject(out.extraEnv)
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
    const rename = src.indexOf('renameSync(plan.tempPlistPath, plan.plistPath)')
    const bootstrap = src.indexOf('bootstrap(plan.plistPath)')

    expect(ensureCheckout).toBeGreaterThan(-1)
    expect(verifyCheckout).toBeGreaterThan(ensureCheckout)
    expect(stagedPreflight).toBeGreaterThan(verifyCheckout)
    expect(rename).toBeGreaterThan(stagedPreflight)
    expect(bootstrap).toBeGreaterThan(rename)
  })
})
