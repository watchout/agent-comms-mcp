// Issue #917 Phase 1 supersedes a broad host fleet allowlist as runtime
// authority. Legacy fleet metadata remains readable, but any non-empty host
// allowlist must now be one exact, typed canary overlay.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  buildStateDaemonRestorePlan,
  parseStateDaemonLaunchAgentPlist,
  renderStateDaemonLaunchAgentPlist,
  validateStateDaemonLaunchAgentConfig,
} from '../core/state-daemon/launchagent'

const COMMIT = '316f32d6c79e4fcae9244c7f74b47b1d3d0d12f9'
const DECISION_REF = 'https://github.com/watchout/iyasaka-arc/issues/24#issuecomment-4921804733'
const RESIDUE_POLICY = '/Users/yuji/.agent-comms/queue-work-residue-policy-cp80-rerun.json'
const FLEET = 'adf-lead,kusabi,kodama,codex-audit,codex-cto,arc,devauditor,qa,check,spec,aun,suite-lead'

function probe(existingFiles: string[], existingDirs: string[]) {
  const files = new Set(existingFiles)
  const dirs = new Set(existingDirs)
  return {
    exists: (path: string) => files.has(path) || dirs.has(path),
    isDirectory: (path: string) => dirs.has(path),
    isFile: (path: string) => files.has(path),
    isExecutable: (path: string) => files.has(path),
  }
}

function buildPlan(extraEnv: Record<string, string>) {
  return buildStateDaemonRestorePlan({
    commit: COMMIT,
    restoreRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
    launchAgentsDir: '/Users/yuji/Library/LaunchAgents',
    extraEnv: {
      STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
      STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
      STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
      ...extraEnv,
    },
  })
}

function validate(plan: ReturnType<typeof buildPlan>, extraFiles: string[] = []) {
  const schemaPath = join(plan.checkoutPath, 'schemas', 'queue-work-result-v1.schema.json')
  return validateStateDaemonLaunchAgentConfig(
    parseStateDaemonLaunchAgentPlist(renderStateDaemonLaunchAgentPlist(plan)),
    { probe: probe([plan.bunPath, plan.entryPath, schemaPath, ...extraFiles], [plan.checkoutPath]) },
  )
}

describe('fleet-mode scheduler activation', () => {
  test('legacy fleet mode + multi-seat host allowlist is rejected as non-authoritative', () => {
    const plan = buildPlan({
      STATE_DAEMON_QUEUE_WORK_FLEET_MODE: '1',
      STATE_DAEMON_QUEUE_WORK_FLEET_DECISION_REF: DECISION_REF,
      STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: RESIDUE_POLICY,
      STATE_DAEMON_AGENT_ALLOWLIST: FLEET,
    })
    const result = validate(plan, [RESIDUE_POLICY])
    expect(result.errors.map(e => e.code)).toEqual(expect.arrayContaining([
      'state_daemon_canary_overlay_target_not_exact',
      'queue_work_scheduler_requires_single_agent_allowlist',
    ]))
    expect(result.ok).toBe(false)
  })

  test('fleet mode WITHOUT decision ref fails closed', () => {
    const plan = buildPlan({
      STATE_DAEMON_QUEUE_WORK_FLEET_MODE: '1',
      STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: RESIDUE_POLICY,
      STATE_DAEMON_AGENT_ALLOWLIST: FLEET,
    })
    expect(validate(plan, [RESIDUE_POLICY]).errors.map(e => e.code)).toContain(
      'queue_work_fleet_mode_requires_decision_ref',
    )
  })

  test('fleet mode with a non-GitHub decision ref fails closed', () => {
    const plan = buildPlan({
      STATE_DAEMON_QUEUE_WORK_FLEET_MODE: '1',
      STATE_DAEMON_QUEUE_WORK_FLEET_DECISION_REF: 'chat approval',
      STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: RESIDUE_POLICY,
      STATE_DAEMON_AGENT_ALLOWLIST: FLEET,
    })
    expect(validate(plan, [RESIDUE_POLICY]).errors.map(e => e.code)).toContain(
      'queue_work_fleet_mode_requires_decision_ref',
    )
  })

  test('fleet mode WITHOUT residue policy file fails closed', () => {
    const plan = buildPlan({
      STATE_DAEMON_QUEUE_WORK_FLEET_MODE: '1',
      STATE_DAEMON_QUEUE_WORK_FLEET_DECISION_REF: DECISION_REF,
      STATE_DAEMON_AGENT_ALLOWLIST: FLEET,
    })
    expect(validate(plan).errors.map(e => e.code)).toContain(
      'queue_work_fleet_mode_requires_residue_policy',
    )
  })

  test('fleet mode steady state permits an empty host allowlist', () => {
    const plan = buildPlan({
      STATE_DAEMON_QUEUE_WORK_FLEET_MODE: '1',
      STATE_DAEMON_QUEUE_WORK_FLEET_DECISION_REF: DECISION_REF,
      STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE: RESIDUE_POLICY,
      STATE_DAEMON_AGENT_ALLOWLIST: '',
    })
    const result = validate(plan, [RESIDUE_POLICY])
    expect(result.errors.map(e => e.code)).not.toContain('queue_work_scheduler_requires_single_agent_allowlist')
    expect(result.errors.map(e => e.code)).not.toContain('state_daemon_canary_overlay_identity_incomplete')
  })

  test('REGRESSION: without fleet mode, canary discipline is unchanged (single seat + fence required)', () => {
    const plan = buildPlan({
      STATE_DAEMON_AGENT_ALLOWLIST: FLEET, // multi-seat, no fleet flag
    })
    const codes = validate(plan).errors.map(e => e.code)
    expect(codes).toContain('queue_work_scheduler_requires_single_agent_allowlist')
    expect(codes).toContain('queue_work_scheduler_requires_canary_fence')
  })
})
