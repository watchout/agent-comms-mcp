/**
 * #602 runtime supervisor adapter contract.
 *
 * AUN core owns desired runtime state, identity, endpoint evidence, queue
 * readiness, and recovery policy. Host-specific process/session control lives
 * behind supervisor adapters. This module is intentionally pure: it evaluates
 * typed adapter evidence and never shells out to tmux, launchd, systemd, or a
 * runtime CLI.
 */

export type RuntimeKind =
  | 'codex'
  | 'claude_code'
  | 'openclaw'
  | 'state_daemon'
  | 'http_service'
  | 'stdio'
  | 'other'

export type RuntimeSupervisorKind =
  | 'none'
  | 'process'
  | 'tmux'
  | 'launchd'
  | 'systemd'
  | 'kubernetes'
  | 'nomad'
  | 'docker'
  | 'docker_compose'
  | 'mdm_desktop_agent'
  | 'managed_runner'
  | 'other'

export type RuntimeEndpointKind =
  | 'tcp'
  | 'unix_socket'
  | 'stdio'
  | 'http'
  | 'streamable_http'
  | 'remote_url'
  | 'none'

export type RuntimeDesiredState = 'disabled' | 'stopped' | 'ready' | 'running'
export type RuntimeObservedState = 'unknown' | 'not_found' | 'starting' | 'ready' | 'running' | 'degraded' | 'stopped' | 'failed'

export type RuntimeSupervisorCapabilityName =
  | 'inspect'
  | 'readiness'
  | 'wake'
  | 'start'
  | 'restart'
  | 'stop'
  | 'logs'
  | 'attach'

export type RuntimeSupervisorIntent =
  | 'inspect'
  | 'readiness'
  | 'wake'
  | 'start'
  | 'restart'

export type RuntimeSupervisorBlockerCode =
  | 'MISSING_ENDPOINT_IDENTITY'
  | 'MISSING_OBSERVED_ENDPOINT_IDENTITY'
  | 'AGENT_IDENTITY_MISMATCH'
  | 'RUNTIME_KIND_MISMATCH'
  | 'VOLATILE_RUNTIME_PATH'
  | 'PROMPT_DRIVEN_RECOVERY_FORBIDDEN'
  | 'CAPABILITY_UNSUPPORTED'
  | 'RESTART_CAPABILITY_UNSUPPORTED'
  | 'RESTART_APPROVAL_REQUIRED'
  | 'OBSERVED_RUNTIME_FAILED'

export interface RuntimeEndpointIdentity {
  endpoint_kind: RuntimeEndpointKind
  endpoint_id?: string | null
  endpoint_uri?: string | null
  host_id?: string | null
  agent_id: string
  runtime_instance_id?: string | null
  connector_instance_id?: string | null
  fingerprint?: string | null
}

export interface RuntimePathEvidence {
  role: 'program' | 'working_directory' | 'artifact' | 'log' | 'config' | 'other'
  path: string
  exists?: boolean
  executable?: boolean
  volatile?: boolean
}

export interface RuntimeSupervisorCapability {
  name: RuntimeSupervisorCapabilityName
  supported: boolean
  requires_approval?: boolean
  evidence?: Record<string, unknown>
}

export interface RuntimeSupervisorDesiredStateEvidence {
  agent_id: string
  runtime_kind: RuntimeKind
  desired_state: RuntimeDesiredState
  supervisor_kind: RuntimeSupervisorKind
  endpoint_identity: RuntimeEndpointIdentity | null
}

export interface RuntimeSupervisorObservedStateEvidence {
  supervisor_kind: RuntimeSupervisorKind
  runtime_kind?: RuntimeKind | null
  observed_state: RuntimeObservedState
  endpoint_identity?: RuntimeEndpointIdentity | null
  capabilities: RuntimeSupervisorCapability[]
  paths?: RuntimePathEvidence[]
  health?: {
    ok: boolean
    readiness: 'ready' | 'not_ready' | 'unknown'
    failure_codes?: string[]
  }
  recovery_mechanisms?: string[]
}

export interface RuntimeSupervisorApprovalEvidence {
  approved: boolean
  approval_id: string
  approved_by: string
  approved_at: string
  scope: {
    agent_id: string
    supervisor_kind: RuntimeSupervisorKind
    intent: RuntimeSupervisorIntent
  }
}

export interface RuntimeSupervisorConformanceInput {
  intent: RuntimeSupervisorIntent
  desired: RuntimeSupervisorDesiredStateEvidence
  observed: RuntimeSupervisorObservedStateEvidence
  approval?: RuntimeSupervisorApprovalEvidence | null
}

export interface RuntimeSupervisorConformanceFinding {
  code: RuntimeSupervisorBlockerCode
  severity: 'blocker' | 'warning'
  subject_type: 'runtime' | 'endpoint' | 'capability' | 'path' | 'approval' | 'recovery_mechanism'
  subject_id: string
  evidence: Record<string, unknown>
}

export interface RuntimeSupervisorConformanceReport {
  ok: boolean
  go_no_go: 'GO' | 'NO_GO'
  intent: RuntimeSupervisorIntent
  mutation_performed: false
  restart_performed: false
  desired_state: RuntimeSupervisorDesiredStateEvidence
  observed_state: RuntimeSupervisorObservedStateEvidence
  blockers: RuntimeSupervisorConformanceFinding[]
  warnings: RuntimeSupervisorConformanceFinding[]
}

const CAPABILITY_FOR_INTENT: Record<RuntimeSupervisorIntent, RuntimeSupervisorCapabilityName> = {
  inspect: 'inspect',
  readiness: 'readiness',
  wake: 'wake',
  start: 'start',
  restart: 'restart',
}

const FORBIDDEN_RECOVERY_MECHANISMS = new Set([
  'next',
  'inbox',
  'fifo_drain',
  'prompt_driven_processing',
  'tui_prompt_injection',
])

function textPresent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function isVolatileRuntimePath(path: string): boolean {
  const normalized = path.replace(/\/+$/, '')
  return normalized === '/tmp'
    || normalized.startsWith('/tmp/')
    || normalized === '/private/tmp'
    || normalized.startsWith('/private/tmp/')
}

export function runtimeEndpointIdentityPresent(identity: RuntimeEndpointIdentity | null | undefined): boolean {
  if (!identity) return false
  return textPresent(identity.endpoint_id)
    || textPresent(identity.endpoint_uri)
    || textPresent(identity.runtime_instance_id)
    || textPresent(identity.connector_instance_id)
    || textPresent(identity.fingerprint)
}

export function runtimeSupervisorCapability(
  observed: RuntimeSupervisorObservedStateEvidence,
  name: RuntimeSupervisorCapabilityName,
): RuntimeSupervisorCapability | null {
  return observed.capabilities.find((capability) => capability.name === name) ?? null
}

function blocker(
  code: RuntimeSupervisorBlockerCode,
  subject_type: RuntimeSupervisorConformanceFinding['subject_type'],
  subject_id: string,
  evidence: Record<string, unknown>,
): RuntimeSupervisorConformanceFinding {
  return { code, severity: 'blocker', subject_type, subject_id, evidence }
}

export function evaluateRuntimeSupervisorConformance(
  input: RuntimeSupervisorConformanceInput,
): RuntimeSupervisorConformanceReport {
  const blockers: RuntimeSupervisorConformanceFinding[] = []
  const warnings: RuntimeSupervisorConformanceFinding[] = []
  const desired = input.desired
  const observed = input.observed
  const desiredEndpoint = desired.endpoint_identity
  const observedEndpoint = observed.endpoint_identity ?? null

  if (!runtimeEndpointIdentityPresent(desiredEndpoint)) {
    blockers.push(blocker('MISSING_ENDPOINT_IDENTITY', 'endpoint', desired.agent_id, {
      expected_agent_id: desired.agent_id,
      endpoint_identity: desiredEndpoint,
    }))
  }

  if (desired.desired_state !== 'disabled'
    && desired.desired_state !== 'stopped'
    && !runtimeEndpointIdentityPresent(observedEndpoint)) {
    blockers.push(blocker('MISSING_OBSERVED_ENDPOINT_IDENTITY', 'endpoint', desired.agent_id, {
      observed_state: observed.observed_state,
      endpoint_identity: observedEndpoint,
    }))
  }

  if (observedEndpoint?.agent_id && observedEndpoint.agent_id !== desired.agent_id) {
    blockers.push(blocker('AGENT_IDENTITY_MISMATCH', 'endpoint', observedEndpoint.agent_id, {
      expected_agent_id: desired.agent_id,
      observed_agent_id: observedEndpoint.agent_id,
    }))
  }

  if (observed.runtime_kind && observed.runtime_kind !== desired.runtime_kind) {
    blockers.push(blocker('RUNTIME_KIND_MISMATCH', 'runtime', desired.agent_id, {
      expected_runtime_kind: desired.runtime_kind,
      observed_runtime_kind: observed.runtime_kind,
    }))
  }

  for (const pathEvidence of observed.paths ?? []) {
    if (pathEvidence.volatile === true || isVolatileRuntimePath(pathEvidence.path)) {
      blockers.push(blocker('VOLATILE_RUNTIME_PATH', 'path', pathEvidence.path, {
        role: pathEvidence.role,
        path: pathEvidence.path,
        volatile: pathEvidence.volatile ?? isVolatileRuntimePath(pathEvidence.path),
      }))
    }
  }

  for (const mechanism of observed.recovery_mechanisms ?? []) {
    if (FORBIDDEN_RECOVERY_MECHANISMS.has(mechanism)) {
      blockers.push(blocker('PROMPT_DRIVEN_RECOVERY_FORBIDDEN', 'recovery_mechanism', mechanism, {
        mechanism,
      }))
    }
  }

  if (observed.observed_state === 'failed') {
    blockers.push(blocker('OBSERVED_RUNTIME_FAILED', 'runtime', desired.agent_id, {
      observed_state: observed.observed_state,
      health: observed.health ?? null,
    }))
  }

  const requiredCapability = CAPABILITY_FOR_INTENT[input.intent]
  const capability = runtimeSupervisorCapability(observed, requiredCapability)
  if (!capability?.supported) {
    blockers.push(blocker(
      input.intent === 'restart' ? 'RESTART_CAPABILITY_UNSUPPORTED' : 'CAPABILITY_UNSUPPORTED',
      'capability',
      requiredCapability,
      { intent: input.intent, capability: capability ?? null },
    ))
  }

  if (input.intent === 'restart') {
    const approval = input.approval
    const approvalMatchesScope = approval?.approved === true
      && approval.scope.agent_id === desired.agent_id
      && approval.scope.supervisor_kind === desired.supervisor_kind
      && approval.scope.intent === 'restart'
      && textPresent(approval.approval_id)
      && textPresent(approval.approved_by)
      && textPresent(approval.approved_at)

    if (!approvalMatchesScope) {
      blockers.push(blocker('RESTART_APPROVAL_REQUIRED', 'approval', desired.agent_id, {
        required_intent: 'restart',
        approval: approval ?? null,
      }))
    }
  }

  return {
    ok: blockers.length === 0,
    go_no_go: blockers.length === 0 ? 'GO' : 'NO_GO',
    intent: input.intent,
    mutation_performed: false,
    restart_performed: false,
    desired_state: desired,
    observed_state: observed,
    blockers,
    warnings,
  }
}
