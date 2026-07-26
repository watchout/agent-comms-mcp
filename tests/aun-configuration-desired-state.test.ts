import { describe, expect, test } from 'bun:test'
import {
  canonicalConfigurationJson,
  computeDesiredDigest,
  normalizeDesiredStateRow,
  type AunConfigurationDesiredState,
} from '../core/aun-configuration-desired-state'

const COMMIT = 'b09a7bd5deca0e4814d1f6e57455579ba7af2c50'
const TREE = '20fd33be3849089516655238c14fc0af6e746222'

function desired(overrides: Partial<AunConfigurationDesiredState> = {}): AunConfigurationDesiredState {
  const base = {
    agentId: 'misell', profileEnabled: true, runtimeEnginePreference: 'codex',
    canonicalWorkspace: '/srv/misell', canonicalHome: '/Users/misell', channelPort: 8810,
    supervisorIdentity: 'launchd:com.agent-comms.state-daemon',
    expectedProviderIdentityRef: 'agent-profile:misell:expected-provider-identity:abc',
    providerTokenSourceRef: 'env:DISCORD_TOKEN', ordinaryCommunicationEnrollment: true,
    ordinaryProjection: {
      mode: 'native', channels: ['aun', 'misell'],
      provider_repo_root: '/srv/agent-comms', provider_config_root: '/Users/misell/.codex',
      daemon_checkout: '/srv/state-daemon',
    },
    desiredRevision: 7, desiredDigest: '', releaseCommit: COMMIT, releaseTree: TREE,
    controlRefs: ['https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-5082585803'],
    updatedAt: '2026-07-26T00:00:00.000Z', updatedBy: 'fixture',
  } satisfies AunConfigurationDesiredState
  const value = { ...base, ...overrides }
  value.desiredDigest = overrides.desiredDigest ?? computeDesiredDigest(value)
  return value
}

describe('AUN configuration desired-state canonical contract', () => {
  test('is byte deterministic and excludes mutable observation metadata', () => {
    const first = desired({
      controlRefs: ['https://b.example', 'https://a.example', 'https://b.example'],
      ordinaryProjection: {
        z: 1, a: { y: true, x: false },
        provider_repo_root: '/srv/agent-comms', provider_config_root: '/Users/misell/.codex',
        daemon_checkout: '/srv/state-daemon',
      },
    })
    const second = desired({
      desiredRevision: 99, updatedAt: '2099-01-01T00:00:00Z', updatedBy: 'other',
      controlRefs: ['https://a.example', 'https://b.example'],
      ordinaryProjection: {
        a: { x: false, y: true }, z: 1,
        daemon_checkout: '/srv/state-daemon', provider_config_root: '/Users/misell/.codex',
        provider_repo_root: '/srv/agent-comms',
      },
    })
    expect(first.desiredDigest).toBe(second.desiredDigest)
    expect(canonicalConfigurationJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}')
  })

  test('rejects raw secret material while allowing secret references', () => {
    expect(() => desired({ providerTokenSourceRef: 'ghp_abcdefghijklmnopqrstuvwxyz123456' })).toThrow('RAW_SECRET_FORBIDDEN')
    expect(() => desired({
      ordinaryProjection: {
        provider_repo_root: '/srv/agent-comms', provider_config_root: '/Users/misell/.codex',
        daemon_checkout: '/srv/state-daemon',
        token: 'sk-abcdefghijklmnop',
      },
    })).toThrow('RAW_SECRET_FORBIDDEN')
    expect(() => desired({ providerTokenSourceRef: 'env:GITHUB_TOKEN' })).not.toThrow()
  })

  test('normalizes a DB row and proves stored digest byte-for-byte', () => {
    const fixture = desired()
    const normalized = normalizeDesiredStateRow({
      agent_id: fixture.agentId, profile_enabled: fixture.profileEnabled,
      runtime_engine_preference: fixture.runtimeEnginePreference,
      canonical_workspace: fixture.canonicalWorkspace, canonical_home: fixture.canonicalHome,
      channel_port: fixture.channelPort, supervisor_identity: fixture.supervisorIdentity,
      expected_provider_identity_ref: fixture.expectedProviderIdentityRef,
      provider_token_source_ref: fixture.providerTokenSourceRef,
      ordinary_communication_enrollment: fixture.ordinaryCommunicationEnrollment,
      ordinary_projection: fixture.ordinaryProjection, desired_revision: fixture.desiredRevision,
      desired_digest: fixture.desiredDigest, desired_release_commit: fixture.releaseCommit,
      desired_release_tree: fixture.releaseTree, desired_control_refs: fixture.controlRefs,
      desired_updated_at: fixture.updatedAt, desired_updated_by: fixture.updatedBy,
    })
    expect(normalized).toEqual(fixture)
    expect(() => normalizeDesiredStateRow({
      ...{
        agent_id: fixture.agentId, profile_enabled: true, runtime_engine_preference: 'claude',
        canonical_workspace: fixture.canonicalWorkspace, canonical_home: fixture.canonicalHome,
        channel_port: fixture.channelPort, supervisor_identity: fixture.supervisorIdentity,
        expected_provider_identity_ref: fixture.expectedProviderIdentityRef,
        provider_token_source_ref: fixture.providerTokenSourceRef,
        ordinary_communication_enrollment: true, ordinary_projection: fixture.ordinaryProjection,
        desired_revision: fixture.desiredRevision, desired_digest: fixture.desiredDigest,
        desired_release_commit: fixture.releaseCommit, desired_release_tree: fixture.releaseTree,
        desired_control_refs: fixture.controlRefs, desired_updated_at: fixture.updatedAt,
        desired_updated_by: fixture.updatedBy,
      },
    })).toThrow('DESIRED_DIGEST_MISMATCH')
  })
})
