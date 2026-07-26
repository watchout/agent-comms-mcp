import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  buildAllAgentCommunicationManifest,
  decideAllAgentCommunicationAdmission,
  evaluateAllAgentCommunicationManifest,
  parseAllAgentCommunicationManifest,
  type AllAgentCommunicationManifestTargetV1,
} from '../core/all-agent-communication-manifest'

const RELEASE = '4ad565b4e789514405e7e5cf1c92058631386cea'
const TREE = '2f8d8d62b686f8fd4d49e223a9ae7c17be9664fe'
const POLICY = 'a'.repeat(64)
const OWNER = 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-owner'

function target(agentId: string, overrides: Partial<AllAgentCommunicationManifestTargetV1> = {}): AllAgentCommunicationManifestTargetV1 {
  return {
    agent_id: agentId,
    target_repository: 'watchout/agent-comms-mcp',
    control_source: 'https://github.com/watchout/agent-comms-mcp/issues/887',
    active_function: 'implementation_executor',
    workspace_id: `workspace-${agentId}`,
    workspace_path: `/tmp/workspaces/${agentId}`,
    runtime_engine: 'codex-exec',
    runtime_profile_ref: `agent-profile://${agentId}/revision/1`,
    provider_identity_ref: `discord-identity://${agentId}/identity-1`,
    communication_auto_receive: true,
    protected_d1: false,
    discord_mode: 'native_verified',
    ...overrides,
  }
}

function manifest(options: { revision?: number; owner?: string; targets?: AllAgentCommunicationManifestTargetV1[] } = {}) {
  return buildAllAgentCommunicationManifest({
    manifest_id: 'acm887-c3',
    revision: options.revision ?? 1,
    issued_at: '2026-07-26T00:00:00Z',
    not_before: '2026-07-26T00:00:00Z',
    expires_at: '2026-07-27T00:00:00Z',
    owner_decision_ref: options.owner ?? OWNER,
    targets: options.targets ?? [target('dev-001'), target('misell', { protected_d1: true })],
    release_commit: RELEASE,
    release_tree: TREE,
    policy_digest: POLICY,
    revoked_or_superseded_refs: [],
  })
}

function trust(value = manifest()) {
  return {
    now: '2026-07-26T12:00:00Z',
    trusted_owner_decision_ref: value.owner_decision_ref,
    trusted_owner_pinned_digest: value.owner_pinned_digest,
  }
}

describe('ordinary all-agent communication manifest', () => {
  test('canonicalizes closed-world targets and binds owner pin to exact canonical bytes', () => {
    const value = manifest({ targets: [target('misell', { protected_d1: true }), target('dev-001')] })
    expect(value.sorted_exact_target_tuples.map(row => row.agent_id)).toEqual(['dev-001', 'misell'])
    expect(value.target_count).toBe(2)
    expect(value.target_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(value.owner_pinned_digest).toBe(value.artifact_digest)
    expect(parseAllAgentCommunicationManifest(JSON.parse(JSON.stringify(value)))).toEqual(value)
  })

  test('requires explicit protected_d1 and never derives it from dev-001 or protected membership', () => {
    const value = manifest()
    expect(value.sorted_exact_target_tuples.find(row => row.agent_id === 'dev-001')?.protected_d1).toBe(false)
    const malformed = JSON.parse(JSON.stringify(value))
    delete malformed.sorted_exact_target_tuples[0].protected_d1
    expect(() => parseAllAgentCommunicationManifest(malformed)).toThrow(/protected_d1|closed-world/)
  })

  test('rejects denominator drift, substitution, duplicates, and unsorted tuples', () => {
    const value = manifest()
    const missing = evaluateAllAgentCommunicationManifest(value, {
      ...trust(value),
      observed_targets: [value.sorted_exact_target_tuples[0]],
    })
    expect(missing).toMatchObject({ ok: false, code: 'TARGET_DRIFT', target_count: 2 })
    expect(missing.drift).toContain('misell:missing_target')

    const substituted = evaluateAllAgentCommunicationManifest(value, {
      ...trust(value),
      observed_targets: value.sorted_exact_target_tuples.map(row => row.agent_id === 'misell'
        ? { ...row, workspace_path: '/tmp/substituted' }
        : row),
    })
    expect(substituted.drift).toContain('misell:target_projection_mismatch')

    const duplicate = JSON.parse(JSON.stringify(value))
    duplicate.sorted_exact_target_tuples[1].agent_id = duplicate.sorted_exact_target_tuples[0].agent_id
    expect(() => parseAllAgentCommunicationManifest(duplicate)).toThrow(/duplicate|canonical|digest/)

    const unsorted = JSON.parse(JSON.stringify(value))
    unsorted.sorted_exact_target_tuples.reverse()
    expect(() => parseAllAgentCommunicationManifest(unsorted)).toThrow(/canonical order/)
  })

  test('fails closed for trust, lifecycle, revision, equivocation, and projection errors', () => {
    const current = manifest()
    expect(evaluateAllAgentCommunicationManifest(current, trust(current))).toMatchObject({ ok: true, code: 'ADMITTED' })
    expect(evaluateAllAgentCommunicationManifest(current, {
      ...trust(current), trusted_owner_pinned_digest: 'f'.repeat(64),
    }).code).toBe('MANIFEST_UNTRUSTED')
    expect(evaluateAllAgentCommunicationManifest(current, {
      ...trust(current), now: '2026-07-27T00:00:00Z',
    }).code).toBe('MANIFEST_EXPIRED')
    expect(evaluateAllAgentCommunicationManifest(current, {
      ...trust(current), revoked_refs: [current.artifact_digest],
    }).code).toBe('MANIFEST_REVOKED')

    const lower = manifest({ revision: 1 })
    expect(evaluateAllAgentCommunicationManifest(lower, {
      ...trust(lower),
      current_projection: { ...lower, revision: 2 },
    }).code).toBe('MANIFEST_ROLLBACK_REJECTED')

    const equivocal = manifest({ targets: [target('dev-001'), target('misell', { workspace_path: '/tmp/other', protected_d1: true })] })
    expect(evaluateAllAgentCommunicationManifest(equivocal, {
      ...trust(equivocal),
      current_projection: {
        manifest_id: current.manifest_id,
        revision: current.revision,
        artifact_digest: current.artifact_digest,
        target_sha256: current.target_sha256,
        owner_decision_ref: current.owner_decision_ref,
      },
    }).code).toBe('MANIFEST_EQUIVOCATION')

    const higherWithoutNewOwner = manifest({ revision: 2 })
    expect(evaluateAllAgentCommunicationManifest(higherWithoutNewOwner, {
      ...trust(higherWithoutNewOwner),
      current_projection: {
        manifest_id: current.manifest_id,
        revision: current.revision,
        artifact_digest: current.artifact_digest,
        target_sha256: current.target_sha256,
        owner_decision_ref: current.owner_decision_ref,
      },
    }).code).toBe('MANIFEST_OWNER_DECISION_REQUIRED')

    expect(evaluateAllAgentCommunicationManifest(current, {
      ...trust(current),
      current_projection: {
        manifest_id: current.manifest_id,
        revision: current.revision,
        artifact_digest: current.artifact_digest,
        target_sha256: 'f'.repeat(64),
        owner_decision_ref: current.owner_decision_ref,
      },
    }).code).toBe('PROJECTION_TRUST_MISMATCH')
  })

  test('returns the same exact decision at preclaim, preinvocation, and preeffect', () => {
    const value = manifest()
    for (const phase of ['preclaim', 'preinvocation', 'preeffect'] as const) {
      expect(decideAllAgentCommunicationAdmission(value, {
        ...trust(value),
        observed_targets: value.sorted_exact_target_tuples,
      }, {
        phase,
        queue_id: 1,
        message_id: 'message-1',
        created_at: '2026-07-26T12:00:00Z',
        agent_id: 'dev-001',
        payload: {},
      })).toEqual({
        outcome: 'admit',
        manifest_id: value.manifest_id,
        revision: value.revision,
        artifact_digest: value.artifact_digest,
        target_sha256: value.target_sha256,
      })
    }
  })

  test('communication_auto_receive is the only ordinary lane flag and false denies', () => {
    const value = manifest({
      targets: [target('dev-001', { communication_auto_receive: false, protected_d1: true })],
    })
    expect(decideAllAgentCommunicationAdmission(value, {
      ...trust(value),
      observed_targets: value.sorted_exact_target_tuples,
    }, {
      phase: 'preclaim',
      queue_id: 1,
      message_id: null,
      created_at: '2026-07-26T12:00:00Z',
      agent_id: 'dev-001',
      payload: {},
    })).toEqual({ outcome: 'deny', code: 'ORDINARY_AUTO_RECEIVE_DISABLED' })
  })

  test('schema is strict and requires every ordinary/D1 isolation field', () => {
    const schema = JSON.parse(readFileSync(new URL('../schemas/all-agent-communication-manifest-v1.schema.json', import.meta.url), 'utf8'))
    expect(schema.additionalProperties).toBe(false)
    expect(schema.$defs.target.additionalProperties).toBe(false)
    expect(schema.$defs.target.required).toContain('protected_d1')
    expect(schema.$defs.target.required).toContain('communication_auto_receive')
    expect(schema.$defs.target.properties.protected_d1.type).toBe('boolean')
  })
})
