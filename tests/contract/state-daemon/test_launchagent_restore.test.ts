import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
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

function probe(existingFiles: string[], existingDirs: string[]) {
  const files = new Set(existingFiles)
  const dirs = new Set(existingDirs)
  return {
    exists: (path: string) => files.has(path) || dirs.has(path),
    isDirectory: (path: string) => dirs.has(path),
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
