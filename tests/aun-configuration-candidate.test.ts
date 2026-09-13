import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  buildAunConfigurationCandidate,
  buildDefaultAunConfigurationCandidate,
  candidateByteEquality,
  type BuildAunConfigurationCandidateInput,
} from '../core/aun-configuration-candidate'
import { computeDesiredDigest, type AunConfigurationDesiredState } from '../core/aun-configuration-desired-state'

const COMMIT = 'b09a7bd5deca0e4814d1f6e57455579ba7af2c50'
const TREE = '20fd33be3849089516655238c14fc0af6e746222'
const CONTROL = 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-5082585803'
const REPO = join(import.meta.dir, '..')

function input(overrides: Partial<BuildAunConfigurationCandidateInput> = {}): BuildAunConfigurationCandidateInput {
  const desired = {
    agentId: 'misell', profileEnabled: true, runtimeEnginePreference: 'codex',
    canonicalWorkspace: '/srv/misell', canonicalHome: '/Users/misell', channelPort: 8810,
    supervisorIdentity: 'launchd:com.agent-comms.state-daemon',
    expectedProviderIdentityRef: 'agent-profile:misell:expected-provider-identity:abc',
    providerTokenSourceRef: 'env:DISCORD_TOKEN', ordinaryCommunicationEnrollment: true,
    ordinaryProjection: {
      mode: 'native', provider_repo_root: '/srv/agent-comms', provider_config_root: '/Users/misell/.codex',
      daemon_checkout: '/srv/state-daemon',
    }, desiredRevision: 2, desiredDigest: '',
    releaseCommit: COMMIT, releaseTree: TREE, controlRefs: [CONTROL], updatedAt: 'now', updatedBy: 'fixture',
  } satisfies AunConfigurationDesiredState
  desired.desiredDigest = computeDesiredDigest(desired)
  return {
    hostId: 'host-a', desired,
    externalRoot: {
      databaseLocatorRef: 'env:DATABASE_URL', databaseCredentialRef: 'env:DATABASE_URL',
      releaseCommit: COMMIT, releaseTree: TREE, controlRefs: [CONTROL],
    },
    providerMcp: {
      enabled: true,
      expectedProviderIdentityRef: desired.expectedProviderIdentityRef,
      providerTokenSourceRef: desired.providerTokenSourceRef,
      provider: 'codex', providerHome: '/Users/misell', providerConfigRoot: '/Users/misell/.codex',
      checkoutRoot: '/srv/agent-comms',
      serverName: 'aun', command: '/usr/local/bin/bun',
      args: ['run', '--cwd', '/srv/agent-comms', 'server.ts'], environmentRefs: {
        DATABASE_URL: 'env:DATABASE_URL',
        AGENT_COM_EXPECTED_PROVIDER_IDENTITY_REF: desired.expectedProviderIdentityRef,
        AGENT_COM_PROVIDER_TOKEN_SOURCE_REF: desired.providerTokenSourceRef!,
      },
      databaseLocatorRef: 'env:DATABASE_URL',
    },
    launchAgent: {
      label: 'com.agent-comms.state-daemon', programArguments: ['/usr/local/bin/bun', 'bin/state-daemon.ts'],
      workingDirectory: '/srv/misell', environmentRefs: { DATABASE_URL: 'env:DATABASE_URL' },
      databaseLocatorRef: 'env:DATABASE_URL',
    },
    runtimeRegistration: {
      enabled: true,
      agentId: 'misell', runtimeEngine: 'codex', workspace: '/srv/misell', channelPort: 8810,
      supervisorIdentity: 'launchd:com.agent-comms.state-daemon',
    },
    rollback: { providerMcp: null, launchAgent: null, runtimeRegistration: null },
    restartRequired: true,
    ...overrides,
  }
}

describe('AUN immutable configuration candidate', () => {
  test('default generated bridge requests OS port zero despite an old desired profile port',()=>{
    const fixture=input()
    const candidate=buildDefaultAunConfigurationCandidate({hostId:fixture.hostId,desired:fixture.desired,
      observedRuntime:{observation:{schema_version:'seat-provider-observation/v1',agent_id:'misell',host_id:'host-a',runtime_instance_id:'current',process_id:12,provider_pid:13,
        provider_started_at:new Date(Date.now()-1000).toISOString(),provider:'claude',workspace:'/new-host/misell',session_name:'new-session',observed_at:new Date().toISOString(),source:'process_ancestry',verified:true},
        providerHome:'/new-home',providerConfigRoot:'/new-home/.claude',port:19001,leaseId:'lease-current',fencingToken:2},
      providerConfigRoot:fixture.providerMcp.providerConfigRoot,providerRepoRoot:fixture.providerMcp.checkoutRoot,
      daemonCheckout:fixture.launchAgent.workingDirectory,bunPath:'/bin/bun',serverEntry:'server.ts',daemonEntry:'bin/state-daemon.ts',
      databaseLocatorRef:'env:DATABASE_URL',databaseCredentialRef:'env:DATABASE_URL'})
    expect(candidate.providerMcp.environmentRefs.AUN_WEBHOOK_PORT).toBe('literal:0')
    expect(candidate.providerMcp.environmentRefs.AGENT_ID).toBe('literal:misell')
    expect(fixture.desired.channelPort).toBe(8810)
    expect(candidate.providerMcp.provider).toBe('claude')
    expect(candidate.providerMcp.providerHome).toBe('/new-home')
    expect(candidate.runtimeRegistration.workspace).toBe('/new-host/misell')
    expect(candidate.runtimeRegistration.channelPort).toBe(19001)
    expect(fixture.desired.runtimeEnginePreference).toBe('codex')
  })
  test('ordinary projection without fresh runtime facts cannot fall back to desired preference',()=>{
    const fixture=input()
    expect(()=>buildDefaultAunConfigurationCandidate({hostId:fixture.hostId,desired:fixture.desired,
      providerConfigRoot:fixture.providerMcp.providerConfigRoot,providerRepoRoot:fixture.providerMcp.checkoutRoot,
      daemonCheckout:fixture.launchAgent.workingDirectory,bunPath:'/bin/bun',serverEntry:'server.ts',daemonEntry:'bin/state-daemon.ts',
      databaseLocatorRef:'env:DATABASE_URL',databaseCredentialRef:'env:DATABASE_URL'} as any)).toThrow('CONFIGURATION_CURRENT_RUNTIME_UNAVAILABLE')
  })
  test('renders twice to byte-identical envelopes and digests', () => {
    const first = buildAunConfigurationCandidate(input())
    const second = buildAunConfigurationCandidate(input())
    expect(candidateByteEquality(first, second)).toBe(true)
    expect(first.candidateDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.rollbackArtifactDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects a mixed DB endpoint before any adapter effect', () => {
    const fixture = input()
    fixture.launchAgent = { ...fixture.launchAgent, databaseLocatorRef: 'env:OTHER_DATABASE_URL' }
    expect(() => buildAunConfigurationCandidate(fixture)).toThrow('MIXED_DATABASE_ENDPOINT_CANDIDATE')
    const wrongHome = input()
    wrongHome.providerMcp = { ...wrongHome.providerMcp, providerHome: '/Users/another-agent' }
    expect(() => buildAunConfigurationCandidate(wrongHome)).toThrow('PROVIDER_HOME_MISMATCH')
  })

  test('rejects release/control drift and raw secrets', () => {
    const releaseDrift = input()
    releaseDrift.externalRoot = { ...releaseDrift.externalRoot, releaseTree: '1'.repeat(40) }
    expect(() => buildAunConfigurationCandidate(releaseDrift)).toThrow('EXTERNAL_RELEASE_REF_MISMATCH')
    const secret = input()
    secret.providerMcp = {
      ...secret.providerMcp,
      environmentRefs: { ...secret.providerMcp.environmentRefs, TOKEN: 'sk-abcdefghijklmnop' },
    }
    expect(() => buildAunConfigurationCandidate(secret)).toThrow('RAW_SECRET_FORBIDDEN')
  })

  test('binds the runtime supervisor to the exact LaunchAgent label', () => {
    const mismatch = input()
    mismatch.launchAgent = { ...mismatch.launchAgent, label: 'com.agent-comms.other-daemon' }
    expect(() => buildAunConfigurationCandidate(mismatch)).toThrow('SUPERVISOR_PROJECTION_MISMATCH')
  })

  test('binds provider and runtime enablement to DB enrollment state', () => {
    const disabled = input()
    disabled.desired = {
      ...disabled.desired,
      profileEnabled: false,
      desiredDigest: '',
    }
    disabled.desired.desiredDigest = computeDesiredDigest(disabled.desired)
    disabled.providerMcp = { ...disabled.providerMcp, enabled: false }
    disabled.runtimeRegistration = { ...disabled.runtimeRegistration, enabled: false }
    expect(buildAunConfigurationCandidate(disabled).providerMcp.enabled).toBe(false)

    const mismatch = structuredClone(disabled)
    mismatch.providerMcp.enabled = true
    expect(() => buildAunConfigurationCandidate(mismatch)).toThrow('ENROLLMENT_PROJECTION_MISMATCH')
  })

  test('projects every governed provider identity field into the immutable provider contract', () => {
    const firstInput = input()
    const first = buildAunConfigurationCandidate(firstInput)
    const secondInput = input()
    secondInput.desired = {
      ...secondInput.desired,
      expectedProviderIdentityRef: 'agent-profile:misell:expected-provider-identity:def',
      providerTokenSourceRef: 'secret-ref:provider/misell-v2',
      desiredDigest: '',
    }
    secondInput.desired.desiredDigest = computeDesiredDigest(secondInput.desired)
    secondInput.providerMcp = {
      ...secondInput.providerMcp,
      expectedProviderIdentityRef: secondInput.desired.expectedProviderIdentityRef,
      providerTokenSourceRef: secondInput.desired.providerTokenSourceRef,
      environmentRefs: {
        ...secondInput.providerMcp.environmentRefs,
        AGENT_COM_EXPECTED_PROVIDER_IDENTITY_REF: secondInput.desired.expectedProviderIdentityRef,
        AGENT_COM_PROVIDER_TOKEN_SOURCE_REF: secondInput.desired.providerTokenSourceRef!,
      },
    }
    const second = buildAunConfigurationCandidate(secondInput)
    expect(second.providerMcp).not.toEqual(first.providerMcp)
    expect(second.candidateDigest).not.toBe(first.candidateDigest)

    const omitted = input()
    omitted.desired = secondInput.desired
    expect(() => buildAunConfigurationCandidate(omitted)).toThrow('PROVIDER_IDENTITY_CONTRACT_MISMATCH')

    const nativeOmitted = input()
    delete nativeOmitted.providerMcp.environmentRefs.AGENT_COM_PROVIDER_TOKEN_SOURCE_REF
    expect(() => buildAunConfigurationCandidate(nativeOmitted)).toThrow('PROVIDER_IDENTITY_NATIVE_PROJECTION_MISMATCH')
  })

  test('ordinary restore command deterministically carries the DB reconciler startup flag', () => {
    const result = Bun.spawnSync([
      process.execPath, 'scripts/state-daemon-launchagent.ts', 'restore', '--commit', COMMIT,
      '--bootstrap-safe-defaults', '--configuration-reconciler-enabled',
      '--database-url', 'postgresql:///fixture',
    ], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    const plan = JSON.parse(result.stdout.toString())
    expect(plan.extraEnv.STATE_DAEMON_CONFIGURATION_RECONCILER_ENABLED).toBe('1')
  })
})
