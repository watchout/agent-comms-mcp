import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildLocalLaunchdInstallDryRunPlan,
  buildLocalLaunchdSupervisorReport,
  observeLocalTmuxSession,
  planLocalLaunchdSupervisorCleanup,
} from '../core/local-supervisor-adapter'
import {
  buildStateDaemonRestorePlan,
  renderStateDaemonLaunchAgentPlist,
  type PathProbe,
} from '../core/state-daemon/launchagent'

const REPO = join(import.meta.dir, '..')
const SRC = readFileSync(join(REPO, 'core', 'local-supervisor-adapter.ts'), 'utf8')
const COMMIT = '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9'

function probe(existingFiles: string[], existingDirs: string[], executableFiles: string[] = existingFiles): PathProbe {
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

function durablePlan() {
  return buildStateDaemonRestorePlan({
    commit: COMMIT,
    restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
    launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
  })
}

function codes(report: ReturnType<typeof buildLocalLaunchdSupervisorReport>): string[] {
  return report.conformance.blockers.map((finding) => finding.code)
}

function validReport(overrides: Parameters<typeof buildLocalLaunchdSupervisorReport>[0] = {}) {
  const plan = durablePlan()
  return buildLocalLaunchdSupervisorReport({
    plistText: renderStateDaemonLaunchAgentPlist(plan, { AGENT_ID: 'state_daemon' }),
    plistPath: plan.plistPath,
    restoreRoot: plan.restoreRoot,
    probe: probe([plan.bunPath, plan.entryPath, plan.plistPath], [plan.checkoutPath, plan.logsDir]),
    ...overrides,
  })
}

describe('#602/#603 local supervisor adapter dry-run evidence', () => {
  test('/private/tmp LaunchAgent target is rejected before host mutation', () => {
    const plan = buildStateDaemonRestorePlan({
      commit: COMMIT,
      restoreRoot: '/private/tmp/agent-comms-state-daemon-checkouts',
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const report = buildLocalLaunchdSupervisorReport({
      plistText: renderStateDaemonLaunchAgentPlist(plan, { AGENT_ID: 'state_daemon' }),
      plistPath: plan.plistPath,
      restoreRoot: plan.restoreRoot,
      probe: probe([plan.bunPath, plan.entryPath, plan.plistPath], [plan.checkoutPath, plan.logsDir]),
    })

    expect(report.mutation_performed).toBe(false)
    expect(report.restart_performed).toBe(false)
    expect(report.preflight.ok).toBe(false)
    expect(report.preflight.errors.map((issue) => issue.code)).toContain('ephemeral_launchagent_path')
    expect(codes(report)).toContain('VOLATILE_RUNTIME_PATH')
  })

  test('missing executable and working directory are rejected before launchd load', () => {
    const plan = durablePlan()
    const report = buildLocalLaunchdSupervisorReport({
      plistText: renderStateDaemonLaunchAgentPlist(plan, { AGENT_ID: 'state_daemon' }),
      plistPath: plan.plistPath,
      restoreRoot: plan.restoreRoot,
      probe: probe([plan.plistPath], []),
    })

    expect(report.preflight.ok).toBe(false)
    expect(report.preflight.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'bun_path_missing',
      'state_daemon_entry_missing',
      'working_directory_missing',
    ]))
    expect(codes(report)).toContain('OBSERVED_RUNTIME_FAILED')
  })

  test('active LaunchAgent referenced checkout is protected from cleanup', () => {
    const root = '/Users/yuji/.agent-comms/state-daemon/checkouts'
    const activePlan = buildStateDaemonRestorePlan({
      commit: 'bbbbbbb',
      restoreRoot: root,
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    })
    const activePlist = renderStateDaemonLaunchAgentPlist(activePlan, { AGENT_ID: 'state_daemon' })
    const cleanup = planLocalLaunchdSupervisorCleanup({
      restoreRoot: root,
      checkoutDirs: [`${root}/aaaaaaa`, activePlan.checkoutPath, `${root}/ccccccc`],
      activeLaunchAgentPlists: [activePlist],
      keep: 1,
    })

    expect(cleanup.mutation_performed).toBe(false)
    expect(cleanup.restart_performed).toBe(false)
    expect(cleanup.protected_paths).toContain(activePlan.checkoutPath)
    expect(cleanup.targets).toContainEqual({
      path: activePlan.checkoutPath,
      action: 'protect',
      reason: 'referenced_by_active_launchagent',
    })
  })

  test('adapter without start/restart capability cannot mutate host state', () => {
    const start = validReport({ intent: 'start' })
    const restart = validReport({ intent: 'restart' })

    expect(start.mutation_performed).toBe(false)
    expect(start.restart_performed).toBe(false)
    expect(codes(start)).toContain('CAPABILITY_UNSUPPORTED')
    expect(restart.mutation_performed).toBe(false)
    expect(restart.restart_performed).toBe(false)
    expect(codes(restart)).toContain('RESTART_CAPABILITY_UNSUPPORTED')
  })

  test('host-state mutation capability requires exact approval evidence', () => {
    const noApproval = validReport({
      intent: 'start',
      capabilities: [
        { name: 'inspect', supported: true },
        { name: 'readiness', supported: true },
        { name: 'start', supported: true, requires_approval: true },
      ],
    })
    expect(codes(noApproval)).toContain('CAPABILITY_APPROVAL_REQUIRED')

    const wrongIntent = validReport({
      intent: 'start',
      capabilities: [
        { name: 'inspect', supported: true },
        { name: 'readiness', supported: true },
        { name: 'start', supported: true, requires_approval: true },
      ],
      approval: {
        approved: true,
        approval_id: 'approval-wrong-intent',
        approved_by: 'operator',
        approved_at: '2026-06-02T00:00:00.000Z',
        scope: { agent_id: 'state_daemon', supervisor_kind: 'launchd', intent: 'restart' },
      },
    })
    expect(codes(wrongIntent)).toContain('CAPABILITY_APPROVAL_REQUIRED')

    const matching = validReport({
      intent: 'start',
      capabilities: [
        { name: 'inspect', supported: true },
        { name: 'readiness', supported: true },
        { name: 'start', supported: true, requires_approval: true },
      ],
      approval: {
        approved: true,
        approval_id: 'approval-start-local-launchd',
        approved_by: 'operator',
        approved_at: '2026-06-02T00:00:00.000Z',
        scope: { agent_id: 'state_daemon', supervisor_kind: 'launchd', intent: 'start' },
      },
    })
    expect(matching.conformance.ok).toBe(true)
    expect(matching.mutation_performed).toBe(false)
  })

  test('dry-run install plan preflights ProgramArguments and atomic plist replacement only as evidence', () => {
    const expected = durablePlan()
    const dryRun = buildLocalLaunchdInstallDryRunPlan({
      commit: COMMIT,
      restoreRoot: expected.restoreRoot,
      launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
      probe: probe([expected.bunPath, expected.entryPath, expected.plistPath], [expected.checkoutPath, expected.logsDir]),
    })

    expect(dryRun.mode).toBe('dry_run')
    expect(dryRun.execute_allowed).toBe(false)
    expect(dryRun.mutation_performed).toBe(false)
    expect(dryRun.restart_performed).toBe(false)
    expect(dryRun.atomic_update).toEqual({
      staged_plist_path: expected.tempPlistPath,
      final_plist_path: expected.plistPath,
      method: 'write_temp_then_rename',
      approval_required_before_execute: true,
    })
    expect(dryRun.preflight.ok).toBe(true)
    expect(dryRun.disabled_host_actions.map((action) => action.action)).toEqual([
      'write_plist',
      'rename_plist',
      'load_or_start_job',
    ])
  })

  test('wrong LaunchAgent AGENT_ID fails closed against desired listener identity', () => {
    const plan = durablePlan()
    const report = buildLocalLaunchdSupervisorReport({
      plistText: renderStateDaemonLaunchAgentPlist(plan, { AGENT_ID: 'codex-cto' }),
      plistPath: plan.plistPath,
      restoreRoot: plan.restoreRoot,
      probe: probe([plan.bunPath, plan.entryPath, plan.plistPath], [plan.checkoutPath, plan.logsDir]),
    })

    expect(codes(report)).toContain('AGENT_IDENTITY_MISMATCH')
    expect(report.conformance.go_no_go).toBe('NO_GO')
  })

  test('optional tmux inspector is evidence-only and flags volatile paths', () => {
    const observation = observeLocalTmuxSession({
      sessionName: 'discord-codex-cto',
      observed: 'present',
      currentPath: '/private/tmp/agent-comms-session',
    })

    expect(observation).toEqual({
      supervisor_kind: 'tmux',
      session_name: 'discord-codex-cto',
      observed: 'present',
      current_path: '/private/tmp/agent-comms-session',
      volatile_path: true,
      mutation_performed: false,
      restart_performed: false,
    })
  })

  test('local adapter has no prompt-driven next/inbox/FIFO recovery or host command execution path', () => {
    const report = validReport()
    expect(report.conformance.observed_state.recovery_mechanisms).toEqual([])
    expect(SRC).not.toMatch(/Call the agent-comms next tool now/)
    expect(SRC).not.toMatch(/Start processing the agent-comms message/)
    expect(SRC).not.toMatch(/\bnext\b|\binbox\b|FIFO drain/)
    expect(SRC).not.toMatch(/from 'node:child_process'|from "node:child_process"/)
    expect(SRC).not.toMatch(/\bexec(File|Sync)?\b|\bspawn(Sync)?\b/)
    expect(SRC).not.toMatch(/launchctl\s+(bootstrap|kickstart)/)
    expect(SRC).not.toMatch(/tmux\s+(send-keys|new-session|kill-session)/)
  })
})
