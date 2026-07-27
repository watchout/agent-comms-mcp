import {
  canonicalConfigurationJson,
  computeDesiredDigest,
  configurationDigest,
  type AunConfigurationDesiredState,
} from './aun-configuration-desired-state'
import { isAbsolute, resolve } from 'node:path'

export interface AunConfigurationExternalRoot {
  databaseLocatorRef: string
  databaseCredentialRef: string
  releaseCommit: string
  releaseTree: string
  controlRefs: string[]
}

export interface ProviderMcpProjection {
  enabled: boolean
  provider: 'codex' | 'claude'
  expectedProviderIdentityRef: string
  providerTokenSourceRef: string | null
  providerHome: string
  providerConfigRoot: string
  checkoutRoot: string
  serverName: string
  command: string
  args: string[]
  environmentRefs: Record<string, string>
  databaseLocatorRef: string
}

export interface LaunchAgentProjection {
  label: string
  programArguments: string[]
  workingDirectory: string
  environmentRefs: Record<string, string>
  databaseLocatorRef: string
}

export interface RuntimeRegistrationProjection {
  enabled: boolean
  agentId: string
  runtimeEngine: string
  workspace: string
  channelPort: number
  supervisorIdentity: string
}

export interface AunConfigurationRollbackEnvelope {
  providerMcp: ProviderMcpProjection | null
  launchAgent: LaunchAgentProjection | null
  runtimeRegistration: RuntimeRegistrationProjection | null
}

export interface AunConfigurationCandidate {
  schemaVersion: 'aun-configuration-candidate/v1'
  hostId: string
  agentId: string
  desiredRevision: number
  desiredDigest: string
  releaseCommit: string
  releaseTree: string
  controlRefs: string[]
  databaseLocatorRef: string
  providerMcp: ProviderMcpProjection
  launchAgent: LaunchAgentProjection
  runtimeRegistration: RuntimeRegistrationProjection
  rollback: AunConfigurationRollbackEnvelope
  rollbackArtifactDigest: string
  restartRequired: boolean
  candidateDigest: string
}

export interface BuildAunConfigurationCandidateInput {
  hostId: string
  desired: AunConfigurationDesiredState
  externalRoot: AunConfigurationExternalRoot
  providerMcp: ProviderMcpProjection
  launchAgent: LaunchAgentProjection
  runtimeRegistration: RuntimeRegistrationProjection
  rollback: AunConfigurationRollbackEnvelope
  restartRequired: boolean
}

export interface BuildDefaultAunConfigurationCandidateInput {
  hostId: string
  desired: AunConfigurationDesiredState
  databaseLocatorRef: string
  databaseCredentialRef: string
  bunPath: string
  serverEntry: string
  providerRepoRoot: string
  providerConfigRoot: string
  daemonCheckout: string
  daemonEntry: string
  rollback?: AunConfigurationRollbackEnvelope
  restartRequired?: boolean
}

const RAW_SECRET = /(?:^|[^a-z])(?:gh[pousr]_|sk-|xox[baprs]-|Bearer\s+)[A-Za-z0-9_./+=-]{8,}/i

function assertNoRawSecrets(value: unknown): void {
  const rendered = canonicalConfigurationJson(value)
  if (RAW_SECRET.test(rendered)) throw new Error('RAW_SECRET_FORBIDDEN')
}

function normalizedRefs(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
}

export function candidateEnvelopeWithoutDigest(
  candidate: Omit<AunConfigurationCandidate, 'candidateDigest'>,
): Omit<AunConfigurationCandidate, 'candidateDigest'> {
  return {
    ...candidate,
    controlRefs: normalizedRefs(candidate.controlRefs),
  }
}

export function buildAunConfigurationCandidate(
  input: BuildAunConfigurationCandidateInput,
): AunConfigurationCandidate {
  if (!input.hostId.trim()) throw new Error('HOST_ID_REQUIRED')
  const desiredDigest = computeDesiredDigest(input.desired)
  if (desiredDigest !== input.desired.desiredDigest) throw new Error('DESIRED_DIGEST_MISMATCH')
  if (input.externalRoot.releaseCommit !== input.desired.releaseCommit
    || input.externalRoot.releaseTree !== input.desired.releaseTree) {
    throw new Error('EXTERNAL_RELEASE_REF_MISMATCH')
  }
  const expectedControlRefs = normalizedRefs(input.desired.controlRefs)
  if (canonicalConfigurationJson(normalizedRefs(input.externalRoot.controlRefs)) !== canonicalConfigurationJson(expectedControlRefs)) {
    throw new Error('EXTERNAL_CONTROL_REFS_MISMATCH')
  }
  if (input.providerMcp.databaseLocatorRef !== input.externalRoot.databaseLocatorRef
    || input.launchAgent.databaseLocatorRef !== input.externalRoot.databaseLocatorRef) {
    throw new Error('MIXED_DATABASE_ENDPOINT_CANDIDATE')
  }
  if (input.runtimeRegistration.agentId !== input.desired.agentId) throw new Error('RUNTIME_AGENT_ID_MISMATCH')
  const expectedEnabled = input.desired.profileEnabled && input.desired.ordinaryCommunicationEnrollment
  if (input.providerMcp.enabled !== expectedEnabled || input.runtimeRegistration.enabled !== expectedEnabled) {
    throw new Error('ENROLLMENT_PROJECTION_MISMATCH')
  }
  if (input.providerMcp.providerHome !== input.desired.canonicalHome) throw new Error('PROVIDER_HOME_MISMATCH')
  if (input.providerMcp.expectedProviderIdentityRef !== input.desired.expectedProviderIdentityRef
    || input.providerMcp.providerTokenSourceRef !== input.desired.providerTokenSourceRef) {
    throw new Error('PROVIDER_IDENTITY_CONTRACT_MISMATCH')
  }
  if (input.providerMcp.environmentRefs.AGENT_COM_EXPECTED_PROVIDER_IDENTITY_REF
      !== input.desired.expectedProviderIdentityRef
    || (input.desired.providerTokenSourceRef === null
      ? Object.hasOwn(input.providerMcp.environmentRefs, 'AGENT_COM_PROVIDER_TOKEN_SOURCE_REF')
      : input.providerMcp.environmentRefs.AGENT_COM_PROVIDER_TOKEN_SOURCE_REF
        !== input.desired.providerTokenSourceRef)) {
    throw new Error('PROVIDER_IDENTITY_NATIVE_PROJECTION_MISMATCH')
  }
  if (!input.providerMcp.providerConfigRoot.startsWith('/')) throw new Error('PROVIDER_CONFIG_ROOT_INVALID')
  if (!isAbsolute(input.providerMcp.checkoutRoot)) throw new Error('PROVIDER_CHECKOUT_ROOT_INVALID')
  const cwdIndex = input.providerMcp.args.indexOf('--cwd')
  if (cwdIndex < 0 || !input.providerMcp.args[cwdIndex + 1]
    || resolve(input.providerMcp.args[cwdIndex + 1]!) !== resolve(input.providerMcp.checkoutRoot)) {
    throw new Error('PROVIDER_CHECKOUT_COMMAND_MISMATCH')
  }
  if (input.runtimeRegistration.runtimeEngine !== input.desired.runtimeEnginePreference
    || input.runtimeRegistration.workspace !== input.desired.canonicalWorkspace
    || input.runtimeRegistration.channelPort !== input.desired.channelPort
    || input.runtimeRegistration.supervisorIdentity !== input.desired.supervisorIdentity) {
    throw new Error('RUNTIME_PROJECTION_MISMATCH')
  }
  if (input.runtimeRegistration.supervisorIdentity !== `launchd:${input.launchAgent.label}`) {
    throw new Error('SUPERVISOR_PROJECTION_MISMATCH')
  }

  const rollbackArtifactDigest = configurationDigest(input.rollback)
  const withoutDigest: Omit<AunConfigurationCandidate, 'candidateDigest'> = {
    schemaVersion: 'aun-configuration-candidate/v1',
    hostId: input.hostId,
    agentId: input.desired.agentId,
    desiredRevision: input.desired.desiredRevision,
    desiredDigest: input.desired.desiredDigest,
    releaseCommit: input.desired.releaseCommit,
    releaseTree: input.desired.releaseTree,
    controlRefs: expectedControlRefs,
    databaseLocatorRef: input.externalRoot.databaseLocatorRef,
    providerMcp: input.providerMcp,
    launchAgent: input.launchAgent,
    runtimeRegistration: input.runtimeRegistration,
    rollback: input.rollback,
    rollbackArtifactDigest,
    restartRequired: input.restartRequired,
  }
  assertNoRawSecrets({
    candidate: withoutDigest,
    databaseCredentialRef: input.externalRoot.databaseCredentialRef,
  })
  return {
    ...withoutDigest,
    candidateDigest: configurationDigest(candidateEnvelopeWithoutDigest(withoutDigest)),
  }
}

export function buildDefaultAunConfigurationCandidate(
  input: BuildDefaultAunConfigurationCandidateInput,
): AunConfigurationCandidate {
  const provider = input.desired.runtimeEnginePreference === 'claude' ? 'claude' : 'codex'
  const commonRefs = {
    AGENT_ID: `literal:${input.desired.agentId}`,
    AGENT_COM_EXPECTED_AGENT_ID: `literal:${input.desired.agentId}`,
    DATABASE_URL: input.databaseLocatorRef,
  }
  return buildAunConfigurationCandidate({
    hostId: input.hostId,
    desired: input.desired,
    externalRoot: {
      databaseLocatorRef: input.databaseLocatorRef,
      databaseCredentialRef: input.databaseCredentialRef,
      releaseCommit: input.desired.releaseCommit,
      releaseTree: input.desired.releaseTree,
      controlRefs: input.desired.controlRefs,
    },
    providerMcp: {
      enabled: input.desired.profileEnabled && input.desired.ordinaryCommunicationEnrollment,
      provider,
      expectedProviderIdentityRef: input.desired.expectedProviderIdentityRef,
      providerTokenSourceRef: input.desired.providerTokenSourceRef,
      providerHome: input.desired.canonicalHome,
      providerConfigRoot: input.providerConfigRoot,
      checkoutRoot: input.providerRepoRoot,
      serverName: 'aun',
      command: input.bunPath,
      args: ['run', '--cwd', input.providerRepoRoot, input.serverEntry],
      environmentRefs: {
        ...commonRefs,
        AGENT_COM_EXPECTED_PROVIDER_IDENTITY_REF: input.desired.expectedProviderIdentityRef,
        ...(input.desired.providerTokenSourceRef
          ? { AGENT_COM_PROVIDER_TOKEN_SOURCE_REF: input.desired.providerTokenSourceRef }
          : {}),
        AGENT_COM_PG_NOTIFY: 'literal:false',
        AGENT_COMMS_TTL_SWEEP_DISABLED: 'literal:1',
        AUN_WEBHOOK_PORT: `literal:${input.desired.channelPort}`,
      },
      databaseLocatorRef: input.databaseLocatorRef,
    },
    launchAgent: {
      label: 'com.agent-comms.state-daemon',
      programArguments: [input.bunPath, input.daemonEntry],
      workingDirectory: input.daemonCheckout,
      environmentRefs: {
        DATABASE_URL: input.databaseLocatorRef,
        STATE_DAEMON_CONFIGURATION_RECONCILER_ENABLED: 'literal:1',
      },
      databaseLocatorRef: input.databaseLocatorRef,
    },
    runtimeRegistration: {
      enabled: input.desired.profileEnabled && input.desired.ordinaryCommunicationEnrollment,
      agentId: input.desired.agentId,
      runtimeEngine: input.desired.runtimeEnginePreference,
      workspace: input.desired.canonicalWorkspace,
      channelPort: input.desired.channelPort,
      supervisorIdentity: input.desired.supervisorIdentity,
    },
    rollback: input.rollback ?? { providerMcp: null, launchAgent: null, runtimeRegistration: null },
    restartRequired: input.restartRequired ?? true,
  })
}

export function candidateByteEquality(
  left: AunConfigurationCandidate,
  right: AunConfigurationCandidate,
): boolean {
  return canonicalConfigurationJson(left) === canonicalConfigurationJson(right)
}
