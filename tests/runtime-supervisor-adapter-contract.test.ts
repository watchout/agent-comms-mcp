import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  evaluateRuntimeSupervisorConformance,
  type RuntimeSupervisorConformanceInput,
} from '../core/runtime-supervisor-adapter'

const REPO = join(import.meta.dir, '..')
const CORE_SRC = readFileSync(join(REPO, 'core', 'runtime-supervisor-adapter.ts'), 'utf8')
const SPEC_SRC = readFileSync(join(REPO, 'docs', 'spec', 'aun-runtime-supervisor-adapter-contract.md'), 'utf8')
const WBS_SRC = readFileSync(join(REPO, 'docs', 'design', 'aun-agent-communication-control-plane-wbs.md'), 'utf8')

function baseInput(): RuntimeSupervisorConformanceInput {
  return {
    intent: 'readiness',
    desired: {
      agent_id: 'codex-cto',
      runtime_kind: 'codex',
      desired_state: 'ready',
      supervisor_kind: 'managed_runner',
      endpoint_identity: {
        endpoint_kind: 'streamable_http',
        endpoint_uri: 'http://127.0.0.1:8797/mcp',
        agent_id: 'codex-cto',
        runtime_instance_id: 'rt-codex-cto',
      },
    },
    observed: {
      supervisor_kind: 'managed_runner',
      runtime_kind: 'codex',
      observed_state: 'ready',
      endpoint_identity: {
        endpoint_kind: 'streamable_http',
        endpoint_uri: 'http://127.0.0.1:8797/mcp',
        agent_id: 'codex-cto',
        runtime_instance_id: 'rt-codex-cto',
      },
      capabilities: [
        { name: 'inspect', supported: true },
        { name: 'readiness', supported: true },
        { name: 'restart', supported: false },
      ],
      paths: [
        { role: 'working_directory', path: '/Users/yuji/.agent-comms/runtimes/codex-cto', exists: true },
      ],
      health: { ok: true, readiness: 'ready' },
      recovery_mechanisms: [],
    },
  }
}

function codes(input: RuntimeSupervisorConformanceInput): string[] {
  return evaluateRuntimeSupervisorConformance(input).blockers.map((finding) => finding.code)
}

describe('#602 runtime supervisor adapter conformance', () => {
  test('adapter that only supports inspect/readiness is valid for readiness', () => {
    const report = evaluateRuntimeSupervisorConformance(baseInput())
    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.mutation_performed).toBe(false)
    expect(report.restart_performed).toBe(false)
  })

  test('adapter without restart capability cannot be used for restart', () => {
    const input = baseInput()
    input.intent = 'restart'
    expect(codes(input)).toContain('RESTART_CAPABILITY_UNSUPPORTED')
  })

  test('missing endpoint identity fails closed', () => {
    const input = baseInput()
    input.desired.endpoint_identity = null
    expect(codes(input)).toContain('MISSING_ENDPOINT_IDENTITY')
  })

  test('volatile path evidence becomes NO_GO', () => {
    const input = baseInput()
    input.observed.paths = [
      { role: 'working_directory', path: '/private/tmp/agent-comms-reboot-checkout', exists: true },
    ]
    const report = evaluateRuntimeSupervisorConformance(input)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.blockers.map((finding) => finding.code)).toContain('VOLATILE_RUNTIME_PATH')
  })

  test('prompt-driven next/inbox/FIFO is not a recovery mechanism', () => {
    const input = baseInput()
    input.observed.recovery_mechanisms = ['next', 'inbox', 'fifo_drain', 'tui_prompt_injection']
    const report = evaluateRuntimeSupervisorConformance(input)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.blockers.filter((finding) => finding.code === 'PROMPT_DRIVEN_RECOVERY_FORBIDDEN')).toHaveLength(4)
  })

  test('state_daemon restart requires explicit adapter capability and approval evidence', () => {
    const input = baseInput()
    input.intent = 'restart'
    input.desired.agent_id = 'state_daemon'
    input.desired.runtime_kind = 'state_daemon'
    input.desired.supervisor_kind = 'launchd'
    input.desired.endpoint_identity = {
      endpoint_kind: 'none',
      endpoint_id: 'com.agent-comms.state-daemon',
      agent_id: 'state_daemon',
      runtime_instance_id: 'rt-state-daemon',
    }
    input.observed.supervisor_kind = 'launchd'
    input.observed.runtime_kind = 'state_daemon'
    input.observed.endpoint_identity = input.desired.endpoint_identity
    input.observed.capabilities = [
      { name: 'inspect', supported: true },
      { name: 'readiness', supported: true },
      { name: 'restart', supported: true, requires_approval: true },
    ]

    expect(codes(input)).toEqual(['RESTART_APPROVAL_REQUIRED'])

    input.approval = {
      approved: true,
      approval_id: 'approval-602-state-daemon-canary',
      approved_by: 'operator',
      approved_at: '2026-06-02T00:00:00.000Z',
      scope: { agent_id: 'state_daemon', supervisor_kind: 'launchd', intent: 'restart' },
    }

    const report = evaluateRuntimeSupervisorConformance(input)
    expect(report.ok).toBe(true)
    expect(report.restart_performed).toBe(false)
  })

  test('start capability requiring approval fails closed without exact matching approval', () => {
    const input = baseInput()
    input.intent = 'start'
    input.observed.capabilities = [
      { name: 'inspect', supported: true },
      { name: 'readiness', supported: true },
      { name: 'start', supported: true, requires_approval: true },
    ]

    expect(codes(input)).toContain('CAPABILITY_APPROVAL_REQUIRED')

    input.approval = {
      approved: true,
      approval_id: 'approval-wrong-intent',
      approved_by: 'operator',
      approved_at: '2026-06-02T00:00:00.000Z',
      scope: { agent_id: 'codex-cto', supervisor_kind: 'managed_runner', intent: 'wake' },
    }
    expect(codes(input)).toContain('CAPABILITY_APPROVAL_REQUIRED')

    input.approval = {
      approved: true,
      approval_id: 'approval-start',
      approved_by: 'operator',
      approved_at: '2026-06-02T00:00:00.000Z',
      scope: { agent_id: 'codex-cto', supervisor_kind: 'managed_runner', intent: 'start' },
    }
    expect(evaluateRuntimeSupervisorConformance(input).ok).toBe(true)
  })

  test('wake capability requiring approval fails closed without exact matching approval', () => {
    const input = baseInput()
    input.intent = 'wake'
    input.observed.capabilities = [
      { name: 'inspect', supported: true },
      { name: 'readiness', supported: true },
      { name: 'wake', supported: true, requires_approval: true },
    ]

    expect(codes(input)).toContain('CAPABILITY_APPROVAL_REQUIRED')

    input.approval = {
      approved: true,
      approval_id: 'approval-wrong-agent',
      approved_by: 'operator',
      approved_at: '2026-06-02T00:00:00.000Z',
      scope: { agent_id: 'other-agent', supervisor_kind: 'managed_runner', intent: 'wake' },
    }
    expect(codes(input)).toContain('CAPABILITY_APPROVAL_REQUIRED')

    input.approval = {
      approved: true,
      approval_id: 'approval-wake',
      approved_by: 'operator',
      approved_at: '2026-06-02T00:00:00.000Z',
      scope: { agent_id: 'codex-cto', supervisor_kind: 'managed_runner', intent: 'wake' },
    }
    expect(evaluateRuntimeSupervisorConformance(input).ok).toBe(true)
  })

  test('core contract has no host-specific lifecycle calls', () => {
    expect(CORE_SRC).not.toMatch(/from 'node:child_process'|from "node:child_process"/)
    expect(CORE_SRC).not.toMatch(/\bexec(File|Sync)?\b/)
    expect(CORE_SRC).not.toMatch(/\bspawn(Sync)?\b/)
    expect(CORE_SRC).not.toMatch(/launchctl\s+(bootstrap|kickstart)/)
    expect(CORE_SRC).not.toMatch(/tmux\s+(new-session|send-keys|kill-session)/)
  })

  test('spec defines adapter boundary and documents local adapters as examples only', () => {
    expect(SPEC_SRC).toContain('Issue: #602')
    expect(SPEC_SRC).toContain('AUN core owns desired runtime state')
    expect(SPEC_SRC).toContain('runtime supervisor adapter owns host-specific process/session control')
    expect(SPEC_SRC).toContain('tmux/launchd are local-dev adapter examples only')
    expect(SPEC_SRC).toContain('systemd')
    expect(SPEC_SRC).toContain('Kubernetes')
    expect(SPEC_SRC).toContain('Nomad')
    expect(SPEC_SRC).toContain('Docker Compose')
    expect(SPEC_SRC).toContain('managed runner')
    expect(SPEC_SRC).toContain('#667')
    expect(SPEC_SRC).toContain('#668')
  })

  test('WBS links the runtime supervisor contract into the recovery stack', () => {
    expect(WBS_SRC).toContain('CP-05 runtime supervisor adapter contract')
    expect(WBS_SRC).toContain('Issue #602')
    expect(WBS_SRC).toContain('local tmux/launchd path is only the first adapter')
  })
})
