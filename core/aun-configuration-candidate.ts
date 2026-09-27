import { execFileSync } from 'node:child_process'
import { resolveSeatProvider, readObservedProviderRoot, type observeSeatProvider, type SeatProviderObservation } from './seat-runtime-selection'
import { resolveRuntimeEndpoint } from './runtime-endpoint'
import {
  canonicalConfigurationJson,
  computeDesiredDigest,
  configurationDigest,
  type AunConfigurationDesiredState,
} from './aun-configuration-desired-state'
import { isAbsolute, relative, resolve } from 'node:path'

export interface ObservedConfigurationRuntime {
  observation:SeatProviderObservation; providerHome:string; providerConfigRoot:string; port:number; leaseId:string; fencingToken:number
}
export async function resolveConfigurationRuntime(db:{query:(sql:string,params?:any[])=>Promise<any>},agentId:string,env:Record<string,string>,cwd:string,
  dependencies:{observeProvider?:typeof observeSeatProvider;run?:Parameters<typeof readObservedProviderRoot>[0]}={}):Promise<ObservedConfigurationRuntime> {
  const selected=await resolveSeatProvider(db,{agentId,observe:dependencies.observeProvider})
  const endpoint=await resolveRuntimeEndpoint(db,{agentId})
  const o=selected.observation
  if(!selected.ok||!o||!endpoint.endpoint||endpoint.endpoint.runtimeInstanceId!==o.runtime_instance_id) throw new Error('CONFIGURATION_CURRENT_RUNTIME_UNAVAILABLE')
  const root=await readObservedProviderRoot(dependencies.run ?? (async(command,args,options)=>{
    try {return {exitCode:0,stdout:execFileSync(command,args,{encoding:'utf8',timeout:3000,cwd:options.cwd,env:options.env})}}catch{return {exitCode:1,stdout:''}}
  }),{pid:o.provider_pid,startedAt:o.provider_started_at,provider:o.provider,cwd,env})
  if(!root?.home) throw new Error('CONFIGURATION_CURRENT_ACCOUNT_ROOT_UNAVAILABLE')
  return {observation:o,providerHome:root.home,providerConfigRoot:root.root,port:endpoint.endpoint.port,
    leaseId:endpoint.endpoint.leaseId,fencingToken:endpoint.endpoint.fencingToken}
}
export function configurationRuntimeIdentity(value:ObservedConfigurationRuntime) {
  const o=value.observation
  return {agentId:o.agent_id,runtimeInstanceId:o.runtime_instance_id,provider:o.provider,
    providerPid:o.provider_pid,providerStartedAt:o.provider_started_at,workspace:o.workspace,
    providerHome:value.providerHome,providerConfigRoot:value.providerConfigRoot,port:value.port,
    leaseId:value.leaseId,fencingToken:value.fencingToken}
}
function validateObservedRuntime(value:ObservedConfigurationRuntime,agentId:string) {
  const o=value.observation,age=Date.now()-Date.parse(o.observed_at)
  if(o.schema_version!=='seat-provider-observation/v1'||o.verified!==true||o.source!=='process_ancestry'
    ||o.agent_id!==agentId||!['codex','claude'].includes(o.provider)||!o.runtime_instance_id
    ||!Number.isInteger(o.provider_pid)||o.provider_pid<2||!Number.isFinite(Date.parse(o.provider_started_at))
    ||!Number.isFinite(age)||age<0||age>1_800_000||!isAbsolute(o.workspace)||!isAbsolute(value.providerHome)
    ||!isAbsolute(value.providerConfigRoot)||!Number.isInteger(value.port)||value.port<1||!value.leaseId||value.fencingToken<1)
    throw new Error('CONFIGURATION_CURRENT_RUNTIME_UNAVAILABLE')
}

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
  runtimeSelection?:ReturnType<typeof configurationRuntimeIdentity>
  schemaVersion: 'aun-configuration-candidate/v1'
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
  rollbackReleaseCommit: string
  rollbackReleaseTree: string
  restartRequired: boolean
  candidateDigest: string
}

export interface BuildAunConfigurationCandidateInput {
  observedRuntime?:ObservedConfigurationRuntime
  desired: AunConfigurationDesiredState
  externalRoot: AunConfigurationExternalRoot
  providerMcp: ProviderMcpProjection
  launchAgent: LaunchAgentProjection
  runtimeRegistration: RuntimeRegistrationProjection
  rollback: AunConfigurationRollbackEnvelope
  rollbackReleaseCommit?: string
  rollbackReleaseTree?: string
  restartRequired: boolean
}

export interface BuildDefaultAunConfigurationCandidateInput {
  observedRuntime:ObservedConfigurationRuntime
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
  rollbackReleaseCommit?: string
  rollbackReleaseTree?: string
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
  if(input.observedRuntime) {
    validateObservedRuntime(input.observedRuntime,input.desired.agentId)
    if(input.providerMcp.provider!==input.observedRuntime.observation.provider || input.providerMcp.providerHome!==input.observedRuntime.providerHome
      ||input.providerMcp.providerConfigRoot!==input.observedRuntime.providerConfigRoot) throw new Error('PROVIDER_CURRENT_RUNTIME_MISMATCH')
  } else if (input.providerMcp.providerHome !== input.desired.canonicalHome) throw new Error('PROVIDER_HOME_MISMATCH')
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
    || resolve(input.providerMcp.args[cwdIndex + 1]!) !== resolve(input.observedRuntime?.observation.workspace ?? input.providerMcp.checkoutRoot)) {
    throw new Error('PROVIDER_WORKSPACE_COMMAND_MISMATCH')
  }
  if (input.observedRuntime) {
    const entry = input.providerMcp.args[cwdIndex + 2]
    const sourceRelative = entry && relative(resolve(input.providerMcp.checkoutRoot), resolve(entry))
    if (!entry || !isAbsolute(entry) || !sourceRelative || sourceRelative === '..' || sourceRelative.startsWith('../') || isAbsolute(sourceRelative)) {
      throw new Error('PROVIDER_CHECKOUT_ENTRY_MISMATCH')
    }
  }
  if (input.runtimeRegistration.runtimeEngine !== (input.observedRuntime?.observation.provider ?? input.desired.runtimeEnginePreference)
    || input.runtimeRegistration.workspace !== (input.observedRuntime?.observation.workspace ?? input.desired.canonicalWorkspace)
    || input.runtimeRegistration.channelPort !== (input.observedRuntime?.port ?? input.desired.channelPort)
    || input.runtimeRegistration.supervisorIdentity !== input.desired.supervisorIdentity) {
    throw new Error('RUNTIME_PROJECTION_MISMATCH')
  }
  if (input.runtimeRegistration.supervisorIdentity !== `launchd:${input.launchAgent.label}`) {
    throw new Error('SUPERVISOR_PROJECTION_MISMATCH')
  }

  const hasRollback = Object.values(input.rollback).some(value=>value!==null)
  const rollbackReleaseCommit = input.rollbackReleaseCommit ?? (hasRollback ? '' : input.desired.releaseCommit)
  const rollbackReleaseTree = input.rollbackReleaseTree ?? (hasRollback ? '' : input.desired.releaseTree)
  if(!/^[0-9a-f]{40}$/.test(rollbackReleaseCommit)||!/^[0-9a-f]{40}$/.test(rollbackReleaseTree))throw new Error('ROLLBACK_RELEASE_IDENTITY_REQUIRED')
  const rollbackArtifactDigest = configurationDigest(input.rollback)
  const withoutDigest: Omit<AunConfigurationCandidate, 'candidateDigest'> = {
    schemaVersion: 'aun-configuration-candidate/v1',
    agentId: input.desired.agentId,
    desiredRevision: input.desired.desiredRevision,
    desiredDigest: input.desired.desiredDigest,
    releaseCommit: input.desired.releaseCommit,
    releaseTree: input.desired.releaseTree,
    controlRefs: expectedControlRefs,
    databaseLocatorRef: input.externalRoot.databaseLocatorRef,
    ...(input.observedRuntime?{runtimeSelection:configurationRuntimeIdentity(input.observedRuntime)}:{}),
    providerMcp: input.providerMcp,
    launchAgent: input.launchAgent,
    runtimeRegistration: input.runtimeRegistration,
    rollback: input.rollback,
    rollbackArtifactDigest,
    rollbackReleaseCommit,
    rollbackReleaseTree,
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
  if(!input.observedRuntime) throw new Error('CONFIGURATION_CURRENT_RUNTIME_UNAVAILABLE')
  validateObservedRuntime(input.observedRuntime,input.desired.agentId)
  const provider = input.observedRuntime.observation.provider
  const commonRefs = {
    AGENT_ID: `literal:${input.desired.agentId}`,
    AGENT_COM_EXPECTED_AGENT_ID: `literal:${input.desired.agentId}`,
    DATABASE_URL: input.databaseLocatorRef,
  }
  return buildAunConfigurationCandidate({
    observedRuntime:input.observedRuntime,
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
      providerHome: input.observedRuntime.providerHome,
      providerConfigRoot: input.observedRuntime.providerConfigRoot,
      checkoutRoot: input.providerRepoRoot,
      serverName: 'aun',
      command: input.bunPath,
      args: ['run', '--cwd', input.observedRuntime.observation.workspace, resolve(input.providerRepoRoot, input.serverEntry)],
      environmentRefs: {
        ...commonRefs,
        AGENT_COM_EXPECTED_PROVIDER_IDENTITY_REF: input.desired.expectedProviderIdentityRef,
        ...(input.desired.providerTokenSourceRef
          ? { AGENT_COM_PROVIDER_TOKEN_SOURCE_REF: input.desired.providerTokenSourceRef }
          : {}),
        AGENT_COM_PG_NOTIFY: 'literal:false',
        AGENT_COMMS_TTL_SWEEP_DISABLED: 'literal:1',
        AUN_WEBHOOK_PORT: 'literal:0',
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
      runtimeEngine: provider,
      workspace: input.observedRuntime.observation.workspace,
      channelPort: input.observedRuntime.port,
      supervisorIdentity: input.desired.supervisorIdentity,
    },
    rollback: input.rollback ?? { providerMcp: null, launchAgent: null, runtimeRegistration: null },
    rollbackReleaseCommit:input.rollbackReleaseCommit,
    rollbackReleaseTree:input.rollbackReleaseTree,
    restartRequired: input.restartRequired ?? true,
  })
}

export function candidateByteEquality(
  left: AunConfigurationCandidate,
  right: AunConfigurationCandidate,
): boolean {
  return canonicalConfigurationJson(left) === canonicalConfigurationJson(right)
}
