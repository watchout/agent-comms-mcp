import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildStateDaemonRestorePlan,
  renderStateDaemonLaunchAgentPlist,
  validateAllAgentCommunicationManifestArtifact,
  validateAllAgentCommunicationManifestLaunchAgentEnv,
} from '../core/state-daemon/launchagent'
import { buildAllAgentCommunicationManifest } from '../core/all-agent-communication-manifest'

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
  test('bootstrap restore plan writes safe defaults without a steady-state host allowlist', () => {
    const result = Bun.spawnSync([
      'bun', 'scripts/state-daemon-launchagent.ts', 'restore', '--commit', COMMIT,
      '--bootstrap-safe-defaults', '--sqlite-path', '/tmp/bootstrap-probe.db',
    ], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    const json = JSON.parse(result.stdout.toString())
    expect(json.dry_run).toBe(true)
    expect(json.extraEnv).toMatchObject({
      SHIRUBE_D1_ENABLED: '0',
      SHIRUBE_D1_KILL_SWITCH: '1',
      SHIRUBE_D1_TARGET_ALLOWLIST: '[]',
      STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
      STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED: '0',
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: '/tmp/bootstrap-probe.db',
    })
    expect(json.extraEnv.STATE_DAEMON_AGENT_ALLOWLIST).toBeUndefined()
    expect(json.extraEnv.STATE_DAEMON_CODEX_RUNNER_ENABLED).toBeUndefined()
  })

  test('ordinary manifest activation input is identity-complete and fail-closed', () => {
    const complete = {
      STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED: '1',
      STATE_DAEMON_ALL_AGENT_MANIFEST_ID: 'm1',
      STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION: '1',
      STATE_DAEMON_ALL_AGENT_MANIFEST_ARTIFACT_DIGEST: 'a'.repeat(64),
      STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256: 'b'.repeat(64),
      STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF: 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-owner',
      STATE_DAEMON_ALL_AGENT_MANIFEST_PATH: '/durable/manifests/m1.json',
    }
    expect(validateAllAgentCommunicationManifestLaunchAgentEnv(complete)).toEqual([])
    expect(validateAllAgentCommunicationManifestLaunchAgentEnv({
      ...complete,
      STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256: '',
    }).map(issue => issue.code)).toContain('all_agent_manifest_identity_incomplete')
    expect(validateAllAgentCommunicationManifestLaunchAgentEnv({
      ...complete,
      STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION: '0',
    }).map(issue => issue.code)).toContain('all_agent_manifest_revision_invalid')
  })

  test('ordinary manifest artifact must match every pinned LaunchAgent identity field', () => {
    const manifest = buildAllAgentCommunicationManifest({
      manifest_id: 'm1',
      revision: 1,
      issued_at: '2026-07-26T00:00:00Z',
      not_before: '2026-07-26T00:00:00Z',
      expires_at: '2026-07-27T00:00:00Z',
      owner_decision_ref: 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-owner',
      targets: [{
        agent_id: 'dev-001',
        target_repository: 'watchout/agent-comms-mcp',
        control_source: 'https://github.com/watchout/agent-comms-mcp/issues/887',
        active_function: 'implementation_executor',
        workspace_id: 'w1',
        workspace_path: '/work/dev-001',
        runtime_engine: 'codex-exec',
        runtime_profile_ref: 'agent-profile://dev-001/revision/1',
        provider_identity_ref: 'discord-identity://dev-001/id1',
        communication_auto_receive: true,
        protected_d1: false,
        discord_mode: 'native_verified',
      }],
      release_commit: 'a'.repeat(40),
      release_tree: 'b'.repeat(40),
      policy_digest: 'c'.repeat(64),
      revoked_or_superseded_refs: [],
    })
    const env = {
      STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED: '1',
      STATE_DAEMON_ALL_AGENT_MANIFEST_ID: manifest.manifest_id,
      STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION: String(manifest.revision),
      STATE_DAEMON_ALL_AGENT_MANIFEST_ARTIFACT_DIGEST: manifest.artifact_digest,
      STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256: manifest.target_sha256,
      STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF: manifest.owner_decision_ref,
      STATE_DAEMON_ALL_AGENT_MANIFEST_PATH: '/durable/manifests/m1.json',
    }
    expect(validateAllAgentCommunicationManifestArtifact(env, JSON.stringify(manifest))).toEqual([])
    expect(validateAllAgentCommunicationManifestArtifact({
      ...env,
      STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256: 'f'.repeat(64),
    }, JSON.stringify(manifest)).map(issue => issue.code)).toEqual(['all_agent_manifest_env_artifact_mismatch'])
  })

  test('restore helper accepts bounded ordinary manifest env only as an explicit dry-run plan', () => {
    const env = {
      STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED: '1',
      STATE_DAEMON_ALL_AGENT_MANIFEST_ID: 'm1',
      STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION: '1',
      STATE_DAEMON_ALL_AGENT_MANIFEST_ARTIFACT_DIGEST: 'a'.repeat(64),
      STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256: 'b'.repeat(64),
      STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF: 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-owner',
      STATE_DAEMON_ALL_AGENT_MANIFEST_PATH: '/durable/manifests/m1.json',
    }
    const result = Bun.spawnSync([
      'bun', 'scripts/state-daemon-launchagent.ts', 'restore', '--commit', COMMIT,
      '--all-agent-manifest-env-json', JSON.stringify(env),
    ], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout.toString())
    expect(output.dry_run).toBe(true)
    expect(output.extraEnv).toMatchObject(env)
    expect(output.bootstrapped).toBeUndefined()
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
