import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildStateDaemonRestorePlan,
  renderStateDaemonLaunchAgentPlist,
} from '../core/state-daemon/launchagent'

const REPO = join(import.meta.dir, '..')
const COMMIT = '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9'

function runCli(args: string[]) {
  return Bun.spawnSync(['bun', 'cli/index.ts', ...args], {
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, AGENT_COM_DB: 'sqlite' },
  })
}

describe('state-daemon install-plan CLI dry-run', () => {
  test('bootstrap restore plan writes all four explicit safe defaults', () => {
    const result = Bun.spawnSync([
      'bun', 'scripts/state-daemon-launchagent.ts', 'restore', '--commit', COMMIT,
      '--agent-allowlist', 'bootstrap-probe', '--bootstrap-safe-defaults', '--sqlite-path', '/tmp/bootstrap-probe.db',
    ], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    const json = JSON.parse(result.stdout.toString())
    expect(json.dry_run).toBe(true)
    expect(json.extraEnv).toMatchObject({
      SHIRUBE_D1_ENABLED: '0',
      SHIRUBE_D1_KILL_SWITCH: '1',
      SHIRUBE_D1_TARGET_ALLOWLIST: '[]',
      STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
      STATE_DAEMON_AGENT_ALLOWLIST: 'bootstrap-probe',
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: '/tmp/bootstrap-probe.db',
    })
    expect(json.extraEnv.STATE_DAEMON_CODEX_RUNNER_ENABLED).toBeUndefined()
  })

  test('emits a durable install plan without writing, loading, or restarting', () => {
    const restoreRoot = '/Users/yuji/.agent-comms/state-daemon/checkouts'
    const result = runCli([
      'state-daemon',
      'install-plan',
      '--commit',
      COMMIT,
      '--restore-root',
      restoreRoot,
      '--launch-agents-dir',
      '/Users/yuji/Library/LaunchAgents',
      '--format',
      'json',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toBe('')
    const json = JSON.parse(result.stdout.toString())

    expect(json.mode).toBe('dry_run')
    expect(json.mutation_performed).toBe(false)
    expect(json.restart_performed).toBe(false)
    expect(json.execute_allowed).toBe(false)
    expect(json.go_no_go).toBe('NO_GO')
    expect(json.plan.checkoutPath).toBe(`${restoreRoot}/${COMMIT}`)
    expect(json.plan.buildOutfile).toBe(`/Users/yuji/.agent-comms/state-daemon/build-artifacts/${COMMIT}/state-daemon-build.js`)
    expect(json.atomic_update.method).toBe('write_temp_then_rename')
    expect(json.atomic_update.approval_required_before_execute).toBe(true)
    expect(json.disabled_host_actions.map((action: { action: string }) => action.action)).toEqual([
      'write_plist',
      'rename_plist',
      'load_or_start_job',
    ])
  })

  test('/private/tmp restore root is fail-closed before any install action', () => {
    const result = runCli([
      'state-daemon',
      'install-plan',
      '--commit',
      COMMIT,
      '--restore-root',
      '/private/tmp/agent-comms-state-daemon-checkouts',
      '--format',
      'json',
    ])
    expect(result.exitCode).toBe(1)
    const json = JSON.parse(result.stdout.toString())
    expect(json.go_no_go).toBe('NO_GO')
    expect(json.preflight.errors.map((issue: { code: string }) => issue.code)).toContain('ephemeral_launchagent_path')
    expect(json.supervisor_report.conformance.blockers.map((finding: { code: string }) => finding.code)).toContain('VOLATILE_RUNTIME_PATH')
    expect(json.mutation_performed).toBe(false)
  })

  test('active LaunchAgent referenced checkout is protected in cleanup dry-run', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'state-daemon-install-plan-'))
    try {
      const restoreRoot = '/Users/yuji/.agent-comms/state-daemon/checkouts'
      const activePlan = buildStateDaemonRestorePlan({
        commit: 'bbbbbbb',
        restoreRoot,
        launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      })
      const activePlistPath = join(tmp, 'active.plist')
      writeFileSync(activePlistPath, renderStateDaemonLaunchAgentPlist(activePlan, { AGENT_ID: 'state_daemon' }))

      const result = runCli([
        'state-daemon',
        'install-plan',
        '--commit',
        COMMIT,
        '--restore-root',
        restoreRoot,
        '--active-plist-path',
        activePlistPath,
        '--checkout-dirs',
        [`${restoreRoot}/aaaaaaa`, activePlan.checkoutPath, `${restoreRoot}/ccccccc`].join(','),
        '--keep',
        '1',
        '--format',
        'json',
      ])
      expect(result.exitCode).toBe(1)
      const json = JSON.parse(result.stdout.toString())
      expect(json.cleanup.mutation_performed).toBe(false)
      expect(json.cleanup.protected_paths).toContain(activePlan.checkoutPath)
      expect(json.cleanup.targets).toContainEqual({
        path: activePlan.checkoutPath,
        action: 'protect',
        reason: 'referenced_by_active_launchagent',
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('execute flag is rejected because install execution requires separate approval', () => {
    const result = runCli([
      'state-daemon',
      'install-plan',
      '--commit',
      COMMIT,
      '--execute',
    ])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain('state-daemon install-plan is dry-run only')
    expect(result.stdout.toString()).toBe('')
  })
})
