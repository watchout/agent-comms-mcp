import { describe, expect, test } from 'bun:test'
import {
  canonicalV2NativeStageBindingSha256,
  decodeV2NativeStageBinding,
  deriveV2NativeMeshScopeAndFence,
  stageMembershipSha256,
  verifyV2NativeStageOwnerDecision,
  type V2NativeActivationStageId,
  type V2NativeStageBindingV1,
  type V2NativeStageEnabledRowV1,
  type V2NativeStageOwnerDecisionV1,
} from '../../core/eventlog/v2-native-stage-binding'
import { canonicalJson, sha256Utf8 } from '../../core/eventlog/transport-contract'

const COMMIT = 'a'.repeat(40)
const TREE = 'b'.repeat(40)
const SHA = 'c'.repeat(64)
const DECISION_URL = 'https://github.com/watchout/agent-comms-mcp/issues/794#issuecomment-1234567890'

function timestamp(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString()
}

function database() {
  const identity = {
    engine: 'PostgreSQL' as const,
    server_version: '17.5',
    cluster_fingerprint_sha256: 'd'.repeat(64),
    database_name: 'aun_actexec_fixture_binding',
    database_oid: 16384,
    schema_name: 'public',
  }
  return { ...identity, identity_sha256: sha256Utf8(canonicalJson(identity)) }
}

function rows(): V2NativeStageEnabledRowV1[] {
  return ['alpha', 'beta', 'delta', 'gamma'].map(agentId => ({
    agent_id: agentId,
    enabled: true,
    active_function: 'implementation_executor',
    runtime_instance_id: `runtime-${agentId}`,
    workspace_realpath: `/fixture/workspace/${agentId}`,
    checkout_root_realpath: `/fixture/checkout/${agentId}`,
    checkout_sha: COMMIT,
    checkout_tree: TREE,
    engine: 'codex',
    status: agentId === 'gamma' ? 'stopped' : 'running',
    last_seen_at: timestamp(-1_000),
    runtime_policy_sha256: SHA,
    runtime_build_sha256: SHA,
    config_sha256: SHA,
  }))
}

function stageMembers(stageId: V2NativeActivationStageId): string[] {
  if (stageId === 'S1_TWO_AGENT') return ['alpha', 'beta']
  if (stageId === 'S2_SELECTED_ENABLED') return ['alpha', 'beta', 'delta']
  return ['alpha', 'beta', 'delta', 'gamma']
}

function priorGate(stageId: V2NativeActivationStageId): V2NativeStageBindingV1['prior_gate_ref'] {
  if (stageId === 'S1_TWO_AGENT') return 'K3_POST_MERGE_AND_INDEPENDENT_GATES'
  if (stageId === 'S2_SELECTED_ENABLED') return 'S1_TERMINAL_PASS'
  return 'S2_TERMINAL_PASS'
}

function fixture(stageId: V2NativeActivationStageId = 'S1_TWO_AGENT') {
  const enabledRows = rows()
  const members = stageMembers(stageId)
  const db = database()
  const binding: V2NativeStageBindingV1 = {
    schema_version: 'aun-v2-native-stage-binding/v1',
    run_id: '123e4567-e89b-42d3-a456-426614174000',
    stage_id: stageId,
    exact_implementation_main_sha: COMMIT,
    exact_implementation_main_tree: TREE,
    database: db,
    migration: {
      required: false,
      version: null,
      up_blob_sha256: null,
      down_blob_sha256: null,
      applied_at: null,
      decision_ref: null,
      receipt_ref: null,
    },
    frozen_enabled_snapshot: {
      artifact_url: DECISION_URL,
      canonical_json_sha256: sha256Utf8(canonicalJson(enabledRows)),
      cardinality: enabledRows.length,
      generated_at: timestamp(-2_000),
      query_digest: 'e'.repeat(64),
      rows: enabledRows,
    },
    stage_members: {
      agent_ids: members,
      cardinality: members.length,
      membership_sha256: stageMembershipSha256(members),
    },
    started_at: timestamp(-5_000),
    deadline: timestamp(120_000),
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    pre_run_baselines: {
      event_log_max_seq: 0,
      active_turn_count: 0,
      open_delivery_count: 0,
      V1_message_queue_row_count: 0,
      V1_agent_messages_row_count: 0,
      V1_outbound_queue_row_count: 0,
      provider_attempt_count: 0,
      provider_effect_count: 0,
      external_send_attempt_count: 0,
    },
    supervisor_processes: members.map((agentId, index) => ({
      unit_kind: 'seat',
      agent_id_or_dispatcher_id: agentId,
      runtime_instance_id: `runtime-${agentId}`,
      pid: 1000 + index,
      process_start_time: timestamp(-10_000),
      executable_realpath: '/usr/bin/true',
      executable_sha256: SHA,
      checkout_sha: COMMIT,
      database_identity_sha256: db.identity_sha256,
    })),
    command_catalog: members.map(agentId => ({
      command_id: `seat:${agentId}`,
      exact_argv: ['/usr/bin/true'],
      cwd_realpath: `/fixture/checkout/${agentId}`,
      allowed_env_keys: [],
      env_value_hashes: {},
      timeout_seconds: 120,
      executable_sha256: SHA,
    })),
    approval_ref: {
      owner: 'owner-human',
      durable_url: DECISION_URL,
      body_sha256: '0'.repeat(64),
      exact_stage_id: stageId,
      exact_binding_sha256: '0'.repeat(64),
    },
    prior_gate_ref: priorGate(stageId),
  }
  const bindingSha256 = canonicalV2NativeStageBindingSha256(binding)
  const decision: V2NativeStageOwnerDecisionV1 = {
    schema_version: 'shirube-v3/v2-native-stage-owner-decision/v1',
    decision_id: '123e4567-e89b-42d3-a456-426614174001',
    owner: 'owner-human',
    decision: 'APPROVE_STAGE_ACTIVATION',
    status: 'active',
    exact_stage_id: stageId,
    exact_binding_sha256: bindingSha256,
    issued_at: timestamp(-4_000),
    expires_at: timestamp(110_000),
    superseded_by: null,
    crash_hooks: stageId === 'S1_TWO_AGENT' ? 'disabled' : 'planned_stage_bound',
  }
  const ownerDecisionBody = JSON.stringify(decision)
  const ownerDecisionBodySha256 = sha256Utf8(ownerDecisionBody)
  binding.approval_ref.exact_binding_sha256 = bindingSha256
  binding.approval_ref.body_sha256 = ownerDecisionBodySha256
  return { binding, bindingSha256, decision, ownerDecisionBody, ownerDecisionBodySha256 }
}

function verify(input = fixture()) {
  return verifyV2NativeStageOwnerDecision({
    binding: input.binding,
    exactBindingSha256: input.bindingSha256,
    ownerDecisionBody: input.ownerDecisionBody,
    ownerDecisionUrl: DECISION_URL,
    ownerDecisionBodySha256: input.ownerDecisionBodySha256,
  })
}

describe('AUN V2 native stage binding', () => {
  test('strict-decodes S1, S2 and S3 and derives the exact non-S0 fence', () => {
    for (const stage of ['S1_TWO_AGENT', 'S2_SELECTED_ENABLED', 'S3_ALL_ENABLED'] as const) {
      const input = fixture(stage)
      const decoded = decodeV2NativeStageBinding(input.binding)
      const authority = verify(input)
      const { scope, fence } = deriveV2NativeMeshScopeAndFence(decoded)
      expect(decoded.stage_id).toBe(stage)
      expect(authority.decision.exact_stage_id).toBe(stage)
      expect(scope.stage_id).toBe(stage)
      expect(fence.stage_id).toBe(stage)
      expect(scope.frozen_enabled_set.map(row => row.agent_id)).toEqual(stageMembers(stage))
      expect(canonicalV2NativeStageBindingSha256(decoded)).toBe(input.bindingSha256)
    }
  })

  test('rejects missing, extra, malformed and non-canonical fields before effects', () => {
    let effects = 0
    const missing = structuredClone(fixture().binding) as Record<string, unknown>
    delete missing.deadline
    expect(() => { decodeV2NativeStageBinding(missing); effects++ }).toThrow(/missing=\[deadline\]/)

    const extra = structuredClone(fixture().binding) as Record<string, unknown>
    extra.activate = true
    expect(() => { decodeV2NativeStageBinding(extra); effects++ }).toThrow(/extra=\[activate\]/)

    const malformed = structuredClone(fixture().binding)
    malformed.exact_implementation_main_sha = 'short'
    expect(() => { decodeV2NativeStageBinding(malformed); effects++ }).toThrow(/40-hex/)

    const unordered = structuredClone(fixture().binding)
    ;[unordered.frozen_enabled_snapshot.rows[0], unordered.frozen_enabled_snapshot.rows[1]] = [
      unordered.frozen_enabled_snapshot.rows[1], unordered.frozen_enabled_snapshot.rows[0],
    ]
    unordered.frozen_enabled_snapshot.canonical_json_sha256 = sha256Utf8(canonicalJson(unordered.frozen_enabled_snapshot.rows))
    expect(() => { decodeV2NativeStageBinding(unordered); effects++ }).toThrow(/ascending/)
    expect(effects).toBe(0)
  })

  test('owner authority fails closed for body, URL, stage, binding, stale and superseded drift', () => {
    const valid = fixture()
    expect(() => verify(valid)).not.toThrow()
    expect(() => verifyV2NativeStageOwnerDecision({
      binding: valid.binding,
      exactBindingSha256: valid.bindingSha256,
      ownerDecisionBody: `${valid.ownerDecisionBody}\n`,
      ownerDecisionUrl: DECISION_URL,
      ownerDecisionBodySha256: valid.ownerDecisionBodySha256,
    })).toThrow(/body digest differs/)
    expect(() => verifyV2NativeStageOwnerDecision({
      binding: valid.binding,
      exactBindingSha256: valid.bindingSha256,
      ownerDecisionBody: valid.ownerDecisionBody,
      ownerDecisionUrl: `${DECISION_URL}x`,
      ownerDecisionBodySha256: valid.ownerDecisionBodySha256,
    })).toThrow(/URL differs/)

    const wrongStage = structuredClone(valid.decision)
    wrongStage.exact_stage_id = 'S2_SELECTED_ENABLED'
    const wrongStageBody = JSON.stringify(wrongStage)
    const wrongStageBinding = structuredClone(valid.binding)
    wrongStageBinding.approval_ref.body_sha256 = sha256Utf8(wrongStageBody)
    expect(() => verifyV2NativeStageOwnerDecision({
      binding: wrongStageBinding,
      exactBindingSha256: valid.bindingSha256,
      ownerDecisionBody: wrongStageBody,
      ownerDecisionUrl: DECISION_URL,
      ownerDecisionBodySha256: sha256Utf8(wrongStageBody),
    })).toThrow(/does not bind this stage/)

    const changed = structuredClone(valid.binding)
    changed.frozen_enabled_snapshot.rows[0].active_function = 'gate_executor'
    changed.frozen_enabled_snapshot.canonical_json_sha256 = sha256Utf8(canonicalJson(changed.frozen_enabled_snapshot.rows))
    expect(() => verifyV2NativeStageOwnerDecision({
      binding: changed,
      exactBindingSha256: valid.bindingSha256,
      ownerDecisionBody: valid.ownerDecisionBody,
      ownerDecisionUrl: DECISION_URL,
      ownerDecisionBodySha256: valid.ownerDecisionBodySha256,
    })).toThrow(/binding digest differs/)

    const staleDecision = { ...valid.decision, expires_at: timestamp(-1_000) }
    const staleBody = JSON.stringify(staleDecision)
    const staleBinding = structuredClone(valid.binding)
    staleBinding.approval_ref.body_sha256 = sha256Utf8(staleBody)
    expect(() => verifyV2NativeStageOwnerDecision({
      binding: staleBinding,
      exactBindingSha256: valid.bindingSha256,
      ownerDecisionBody: staleBody,
      ownerDecisionUrl: DECISION_URL,
      ownerDecisionBodySha256: sha256Utf8(staleBody),
    })).toThrow(/stale/)

    const superseded = { ...valid.decision, superseded_by: '123e4567-e89b-42d3-a456-426614174099' }
    const supersededBody = JSON.stringify(superseded)
    const supersededBinding = structuredClone(valid.binding)
    supersededBinding.approval_ref.body_sha256 = sha256Utf8(supersededBody)
    expect(() => verifyV2NativeStageOwnerDecision({
      binding: supersededBinding,
      exactBindingSha256: valid.bindingSha256,
      ownerDecisionBody: supersededBody,
      ownerDecisionUrl: DECISION_URL,
      ownerDecisionBodySha256: sha256Utf8(supersededBody),
    })).toThrow(/unsuperseded/)
  })

  test('enforces exact S1/S2/S3 membership predicates', () => {
    const s1 = structuredClone(fixture('S1_TWO_AGENT').binding)
    s1.stage_members.agent_ids = ['alpha', 'beta', 'delta']
    s1.stage_members.cardinality = 3
    s1.stage_members.membership_sha256 = stageMembershipSha256(s1.stage_members.agent_ids)
    expect(() => decodeV2NativeStageBinding(s1)).toThrow(/S1 requires exactly two/)

    const s2 = structuredClone(fixture('S2_SELECTED_ENABLED').binding)
    s2.stage_members.agent_ids = ['alpha', 'beta']
    s2.stage_members.cardinality = 2
    s2.stage_members.membership_sha256 = stageMembershipSha256(s2.stage_members.agent_ids)
    expect(() => decodeV2NativeStageBinding(s2)).toThrow(/S2 cardinality/)

    const s3 = structuredClone(fixture('S3_ALL_ENABLED').binding)
    s3.stage_members.agent_ids = ['alpha', 'beta', 'delta']
    s3.stage_members.cardinality = 3
    s3.stage_members.membership_sha256 = stageMembershipSha256(s3.stage_members.agent_ids)
    expect(() => decodeV2NativeStageBinding(s3)).toThrow(/S3 must include every enabled row/)

    const duplicate = structuredClone(fixture().binding)
    duplicate.stage_members.agent_ids = ['alpha', 'alpha']
    duplicate.stage_members.membership_sha256 = stageMembershipSha256(duplicate.stage_members.agent_ids)
    expect(() => decodeV2NativeStageBinding(duplicate)).toThrow(/ascending and unique/)

    const foreign = structuredClone(fixture().binding)
    foreign.stage_members.agent_ids = ['alpha', 'foreign']
    foreign.stage_members.membership_sha256 = stageMembershipSha256(foreign.stage_members.agent_ids)
    expect(() => decodeV2NativeStageBinding(foreign)).toThrow(/foreign or disabled/)
  })

  test('schemas keep strict additionalProperties fences', async () => {
    const bindingSchema = await Bun.file(new URL('../../schemas/aun-v2-native-stage-binding-v1.schema.json', import.meta.url)).json()
    const evidenceSchema = await Bun.file(new URL('../../schemas/aun-v2-native-stage-evidence-v1.schema.json', import.meta.url)).json()
    expect(bindingSchema.additionalProperties).toBe(false)
    expect(bindingSchema.$defs.enabledRow.additionalProperties).toBe(false)
    expect(bindingSchema.$defs.command.additionalProperties).toBe(false)
    expect(evidenceSchema.additionalProperties).toBe(false)
    expect(evidenceSchema.$defs.eventIdentity.additionalProperties).toBe(false)
    expect(evidenceSchema.$defs.terminalResult.oneOf).toHaveLength(3)
  })
})
