import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  canonicalV2NativeStageBindingSha256,
  stageMembershipSha256,
  type V2NativeStageBindingV1,
  type V2NativeStageEnabledRowV1,
  type V2NativeStageOwnerDecisionV1,
} from '../../core/eventlog/v2-native-stage-binding'
import { canonicalJson, sha256Utf8 } from '../../core/eventlog/transport-contract'

const ROOT = resolve(import.meta.dir, '../..')
const COMMIT = 'a'.repeat(40)
const TREE = 'b'.repeat(40)
const SHA = 'c'.repeat(64)
const DECISION_URL = 'https://github.com/watchout/agent-comms-mcp/issues/794#issuecomment-1234567892'
const BINDING_URL = 'https://github.com/watchout/agent-comms-mcp/issues/794#issuecomment-1234567894'
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function timestamp(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString()
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aun-stage-cli-')))
  tempDirs.push(dir)
  const trueExe = realpathSync('/usr/bin/true')
  const rows: V2NativeStageEnabledRowV1[] = ['alpha', 'beta'].map(agentId => {
    const workspace = join(dir, 'workspace', agentId)
    const checkout = join(dir, 'checkout', agentId)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(checkout, { recursive: true })
    return {
    agent_id: agentId,
    enabled: true,
    active_function: 'implementation_executor',
    runtime_instance_id: `runtime-${agentId}`,
    workspace_realpath: realpathSync(workspace),
    checkout_root_realpath: realpathSync(checkout),
    checkout_sha: COMMIT,
    checkout_tree: TREE,
    engine: 'codex',
    status: 'running',
    last_seen_at: timestamp(-1_000),
    runtime_policy_sha256: SHA,
    runtime_build_sha256: SHA,
    config_sha256: SHA,
    }
  })
  const dbIdentity = {
    engine: 'PostgreSQL' as const,
    server_version: '17.5',
    cluster_fingerprint_sha256: 'd'.repeat(64),
    database_name: 'aun_actexec_fixture_cli',
    database_oid: 16386,
    schema_name: 'public',
  }
  const database = { ...dbIdentity, identity_sha256: sha256Utf8(canonicalJson(dbIdentity)) }
  const members = rows.map(row => row.agent_id)
  const binding: V2NativeStageBindingV1 = {
    schema_version: 'aun-v2-native-stage-binding/v1',
    run_id: '123e4567-e89b-42d3-a456-426614174010',
    stage_id: 'S1_TWO_AGENT',
    exact_implementation_main_sha: COMMIT,
    exact_implementation_main_tree: TREE,
    database,
    migration: { required: false, version: null, up_blob_sha256: null, down_blob_sha256: null, applied_at: null, decision_ref: null, receipt_ref: null },
    frozen_enabled_snapshot: {
      artifact_url: DECISION_URL,
      canonical_json_sha256: sha256Utf8(canonicalJson(rows)),
      cardinality: rows.length,
      generated_at: timestamp(-2_000),
      query_digest: 'e'.repeat(64),
      rows,
    },
    stage_members: { agent_ids: members, cardinality: 2, membership_sha256: stageMembershipSha256(members) },
    started_at: timestamp(-5_000),
    deadline: timestamp(180_000),
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    pre_run_baselines: {
      event_log_max_seq: 0, active_turn_count: 0, open_delivery_count: 0,
      V1_message_queue_row_count: 0, V1_agent_messages_row_count: 0, V1_outbound_queue_row_count: 0,
      provider_attempt_count: 0, provider_effect_count: 0, external_send_attempt_count: 0,
    },
    supervisor_processes: rows.map((row, index) => ({
      unit_kind: 'seat',
      agent_id_or_dispatcher_id: row.agent_id,
      runtime_instance_id: row.runtime_instance_id,
      pid: 3000 + index,
      process_start_time: timestamp(-10_000),
      executable_realpath: trueExe,
      executable_sha256: SHA,
      checkout_sha: COMMIT,
      database_identity_sha256: database.identity_sha256,
    })),
    command_catalog: rows.map(row => ({
      command_id: `seat:${row.agent_id}`,
      exact_argv: [trueExe],
      cwd_realpath: row.checkout_root_realpath,
      allowed_env_keys: [],
      env_value_hashes: {},
      timeout_seconds: 120,
      executable_sha256: SHA,
    })),
    approval_ref: {
      owner: 'owner-human', durable_url: DECISION_URL, body_sha256: '0'.repeat(64),
      exact_stage_id: 'S1_TWO_AGENT', exact_binding_sha256: '0'.repeat(64),
    },
    prior_gate_ref: 'K3_POST_MERGE_AND_INDEPENDENT_GATES',
  }
  const bindingSha = canonicalV2NativeStageBindingSha256(binding)
  const decision: V2NativeStageOwnerDecisionV1 = {
    schema_version: 'shirube-v3/v2-native-stage-owner-decision/v1',
    decision_id: '123e4567-e89b-42d3-a456-426614174011',
    owner: 'owner-human',
    decision: 'APPROVE_STAGE_ACTIVATION',
    status: 'active',
    exact_stage_id: 'S1_TWO_AGENT',
    exact_binding_sha256: bindingSha,
    issued_at: timestamp(-4_000),
    expires_at: timestamp(170_000),
    superseded_by: null,
    crash_hooks: 'disabled',
  }
  const body = JSON.stringify(decision)
  const bodySha = sha256Utf8(body)
  binding.approval_ref.exact_binding_sha256 = bindingSha
  binding.approval_ref.body_sha256 = bodySha
  const bindingFile = join(dir, 'binding.json')
  const decisionFile = join(dir, 'decision.json')
  writeFileSync(bindingFile, JSON.stringify(binding))
  writeFileSync(decisionFile, body)
  return { bindingFile, decisionFile, bindingSha, bodySha }
}

function argv(mode: string | null, input = fixture()): string[] {
  return [
    'bin/aun.ts', 'v2-native-stage', ...(mode === null ? [] : [mode]),
    '--binding-file', input.bindingFile,
    '--binding-url', BINDING_URL,
    '--binding-sha256', input.bindingSha,
    '--owner-decision-body-file', input.decisionFile,
    '--owner-decision-url', DECISION_URL,
    '--owner-decision-body-sha256', input.bodySha,
    '--exact-implementation-sha', COMMIT,
    '--exact-implementation-tree', TREE,
    '--json',
  ]
}

async function invoke(args: string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv, DATABASE_URL: '', DISCORD_BOT_TOKEN: '' }
  const proc = Bun.spawn(['bun', ...args], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode, body: JSON.parse(stdout) as Record<string, unknown> }
}

function expectZeroEffects(body: Record<string, unknown>) {
  expect(body.mutation_performed).toBe(false)
  expect(body.activation_performed).toBe(false)
  expect(body.model_invocations).toBe(0)
  expect(body.provider_invocations).toBe(0)
  expect(body.external_send_attempts).toBe(0)
  expect(body.V1_invocations).toBe(0)
}

describe('aun v2-native-stage CLI', () => {
  test('requires an explicit mode and every exact hash-bound field', async () => {
    const missingMode = await invoke(argv(null))
    expect(missingMode.exitCode).toBe(2)
    expect(missingMode.body.ok).toBe(false)
    expect(missingMode.body.error).toContain('mode must be explicit')
    expectZeroEffects(missingMode.body)

    const missingBindingHash = argv('preflight')
    missingBindingHash.splice(missingBindingHash.indexOf('--binding-sha256'), 2)
    const missing = await invoke(missingBindingHash)
    expect(missing.exitCode).toBe(2)
    expect(missing.body.error).toContain('--binding-sha256 is required')
    expectZeroEffects(missing.body)
  })

  test('preflight is read-only even when an environment activation flag is present', async () => {
    const result = await invoke(argv('preflight'), { AUN_V2_NATIVE_ACTIVATE: '1' })
    expect(result.exitCode).toBe(0)
    expect(result.body.ok).toBe(true)
    expect(result.body.mode).toBe('PREFLIGHT_READ_ONLY')
    expect(result.body.stage_id).toBe('S1_TWO_AGENT')
    expect(result.body.frozen_agent_ids).toEqual(['alpha', 'beta'])
    expectZeroEffects(result.body)
  })

  test('execute verifies exact authority then fails closed without bound execution ports', async () => {
    const result = await invoke(argv('execute'))
    expect(result.exitCode).toBe(3)
    expect(result.body.ok).toBe(false)
    expect(result.body.binding_verified).toBe(true)
    expect(result.body.owner_decision_verified).toBe(true)
    expect(result.body.stop_reason).toBe('LIVE_ACTIVATION_ATTEMPTED_DURING_IMPLEMENTATION')
    expectZeroEffects(result.body)
  })

  test('hash, head, URL and broad activation flag drift all fail before effects', async () => {
    const badHash = argv('preflight')
    badHash[badHash.indexOf('--binding-sha256') + 1] = 'f'.repeat(64)
    const hashResult = await invoke(badHash)
    expect(hashResult.exitCode).toBe(2)
    expectZeroEffects(hashResult.body)

    const badHead = argv('preflight')
    badHead[badHead.indexOf('--exact-implementation-sha') + 1] = 'f'.repeat(40)
    const headResult = await invoke(badHead)
    expect(headResult.exitCode).toBe(2)
    expect(String(headResult.body.error)).toContain('BASE_OR_TREE_DRIFT')
    expectZeroEffects(headResult.body)

    const badUrl = argv('preflight')
    badUrl[badUrl.indexOf('--owner-decision-url') + 1] = `${DECISION_URL}x`
    const urlResult = await invoke(badUrl)
    expect(urlResult.exitCode).toBe(2)
    expectZeroEffects(urlResult.body)

    const activate = [...argv('preflight'), '--activate']
    const activateResult = await invoke(activate)
    expect(activateResult.exitCode).toBe(2)
    expect(String(activateResult.body.error)).toContain('unknown flags: activate')
    expectZeroEffects(activateResult.body)
  })
})
