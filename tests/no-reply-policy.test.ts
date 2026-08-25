import { describe, expect, test } from 'bun:test'
import {
  buildTerminalBaton,
  detectNoReplyIntent,
  existingNoReplyBaton,
  parseQueuePayload,
  withTerminalBaton,
} from '../core/no-reply-policy'

const QUEUE_127801_BLOCKING_AUDIT_REQUEST = `schema_version: shirube-v3/audit_request/v1
audit_request_id: AUDIT-CELL-KUSABI-PR252-RL-RECON-512A458-20260715
control_source: https://github.com/watchout/agent-memory/issues/180
control_handoff: https://github.com/watchout/agent-memory/pull/252#issuecomment-4977616868
correction_gate_result: https://github.com/watchout/agent-memory/pull/252#issuecomment-4977871304
cell: {id: CELL-KUSABI-PR252-RAPID-LITE-ROUTE-RECONCILIATION-001}
execution_context:
  from: {agent_id: kusabi, active_function: implementation_executor}
  to: {agent_id: codex-audit, active_function: evidence_audit_gate}
subject:
  repository: watchout/agent-memory
  pull_request: 252
  exact_base: 3b3200ecbe83fbeec4a349f1ce1e0c705493436f
  prior_blocked_head: 5aff61d2bbc905526a6a67950a3eda1179147ed7
  exact_head: 512a458c4f4d68d681e9f7cbe9eff34a5b09a4e6
  implementation_evidence: https://github.com/watchout/agent-memory/pull/252#issuecomment-4977920274
trusted_github_provenance:
  required_comment_author_login: iyasaka-ai
  required_author_association: [MEMBER, COLLABORATOR]
  reviewer_actor: codex-audit
  execution_context_agent_id: codex-audit
  marker: shirube-v3:evidence-audit-gate-result:PR252-512A458
  posting_note: Use the configured iyasaka-ai GitHub credential without printing its token; after posting, read back user.login and author_association from GitHub API.
required_response:
  destination: PR 252 top-level comment
  fenced_yaml_schema: shirube-structured-audit/v1
  audit_checklist_id: AUDIT-CHECKLIST-KUSABI-PR252-RL-RECON-001
  implementation_actor: kusabi
  target:
    repository: watchout/agent-memory
    pull_request: 252
    cell_id: CELL-KUSABI-PR252-RAPID-LITE-ROUTE-RECONCILIATION-001
    control_handoff: https://github.com/watchout/agent-memory/pull/252#issuecomment-4977616868
    exact_head: 512a458c4f4d68d681e9f7cbe9eff34a5b09a4e6
  items_rule: KRL-001 through KRL-012 exactly once, each PASS or BLOCK
  aggregate_rule: PASS only if all items PASS; passing next_action must be none
audit_focus:
  KRL-009: Verify watchout/OWNER self-authored audit is rejected and iyasaka-ai/COLLABORATOR audit provenance is accepted only with exact marker and execution-context actor.
  KRL-010: Verify WRONG-CHECKLIST-ID is rejected and exact canonical checklist is required; rerun all negative cases.
  all_items: Revalidate KRL-001 through KRL-012, not only the prior blockers.
evidence_refs:
  - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977616868
  - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977871304
  - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977920274
  - https://github.com/watchout/agent-memory/actions/runs/29396888522
  - https://github.com/watchout/agent-memory/actions/runs/29396888951
  - https://github.com/watchout/agent-memory/actions/runs/29397036854
forbidden_operations: [edit_or_fix, owner_approval, merge, deploy, publish, release, protected_state_mutation, product_doc_edit, shirube_edit]
lifecycle_state: AUDIT_REQUESTED
next_action:
  blocking: true
  owner_agent: codex-audit
  owner_function: evidence_audit_gate
  action: Independently audit the exact head and publish terminal PASS or BLOCK.
  handoff_method: Post one top-level PR 252 comment, verify GitHub author metadata, then return its exact URL through AUN.
  input_refs:
    - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977616868
    - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977871304
    - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977920274
    - https://github.com/watchout/agent-memory/actions/runs/29397036854
  scope: read-only exact-head audit; no implementation or owner authority
  deliverable: terminal PASS or BLOCK, KRL-001..012 exactly once
  completion_evidence: provenance-bound PR audit URL plus AUN return
  stop_reason: FRESH_INDEPENDENT_AUDIT_REQUIRED`

describe('deterministic no-reply policy', () => {
  test('queue 127801 blocking audit request outranks PASS acknowledgement prose and a stale no-reply baton', () => {
    const decision = detectNoReplyIntent({
      payload: {
        content: QUEUE_127801_BLOCKING_AUDIT_REQUEST,
        message_type: 'instruction',
        terminal_baton: {
          no_reply_required: true,
          reason: 'pass_acknowledgement_recorded',
          set_by: 'state_daemon',
          set_at: '2026-07-15T07:21:44.249Z',
          source: 'deterministic_no_reply_policy',
        },
      },
    })

    expect(decision).toEqual({
      no_reply_required: false,
      reason: 'structured_blocking_request_requires_reply',
      matched: 'content.next_action.blocking',
    })
  })

  test('structured payload conflict fails closed as actionable', () => {
    const decision = detectNoReplyIntent({
      payload: {
        schema_version: 'shirube-v3/control_handoff/v1',
        next_action: { blocking: true },
        no_reply_required: true,
        content: 'ACK: PASS received and recorded.',
      },
    })

    expect(decision).toEqual({
      no_reply_required: false,
      reason: 'structured_blocking_request_requires_reply',
      matched: 'payload.next_action.blocking',
    })
  })

  test('JSON and YAML-shaped canonical blocking requests share the actionable disposition', () => {
    const json = JSON.stringify({
      schema_version: 'shirube-v3/audit_request/v1',
      lifecycle_state: 'AUDIT_REQUESTED',
      aggregate_rule: 'PASS only if all items PASS',
      next_action: { blocking: true },
    })
    const yaml = `schema_version: "shirube-v3/audit_request/v1"
lifecycle_state: AUDIT_REQUESTED
aggregate_rule: PASS only if all items PASS
next_action: {blocking: true}`

    for (const content of [json, yaml]) {
      expect(detectNoReplyIntent({ payload: { content } })).toMatchObject({
        no_reply_required: false,
        reason: 'structured_blocking_request_requires_reply',
        matched: 'content.next_action.blocking',
      })
    }
  })

  test('nested blocking metadata does not masquerade as next_action.blocking', () => {
    const content = `schema_version: shirube-v3/gate_result/v1
next_action:
  scope:
    blocking: true
  action: Record a nonblocking result.
no_reply_required: true`

    expect(detectNoReplyIntent({ payload: { content, no_reply_required: true } })).toEqual({
      no_reply_required: true,
      reason: 'payload_no_reply_required',
      matched: 'payload.no_reply_required',
    })
  })

  test('explicit no-reply text wins even when acknowledgement contains PASS', () => {
    const decision = detectNoReplyIntent({
      payload: {
        content: 'ACK: L2 audit PASS received and recorded. No reply required.',
        message_type: 'chat',
      },
    })

    expect(decision).toMatchObject({
      no_reply_required: true,
      reason: 'explicit_no_reply_required',
    })
  })

  test('structured no-reply payload is terminal without relying on prose', () => {
    const decision = detectNoReplyIntent({
      payload: {
        content: 'NORM-060 synthetic probe',
        no_reply_required: true,
      },
    })

    expect(decision).toMatchObject({
      no_reply_required: true,
      reason: 'payload_no_reply_required',
      matched: 'payload.no_reply_required',
    })
  })

  test('structured no-reply YAML inside an instruction controls only the response', () => {
    const decision = detectNoReplyIntent({
      payload: {
        content: 'Complete CHECK and ADJUST first.\nno_reply_required: true',
        message_type: 'instruction',
      },
    })

    expect(decision).toMatchObject({
      no_reply_required: true,
      reason: 'explicit_no_reply_required',
    })
  })

  test('no-further-action acknowledgement is terminal without gate-classifier ambiguity', () => {
    const decision = detectNoReplyIntent({
      payload: {
        content: 'Recorded. No further action on this acknowledgement.',
      },
    })

    expect(decision.no_reply_required).toBe(true)
    expect(decision.reason).toBe('explicit_no_further_action_acknowledgement')
  })

  test('Discord direct-mention smoke still requires a conversational reply unless explicitly no-reply', () => {
    const decision = detectNoReplyIntent({
      payload: {
        content: '<@1508976231901565028> 疎通テスト',
        message_type: 'chat',
      },
    })

    expect(decision).toEqual({
      no_reply_required: false,
      reason: null,
      matched: null,
    })
  })

  test('substantive test requests are not no-reply smoke', () => {
    const decision = detectNoReplyIntent({
      payload: {
        content: '<@1508976231901565028> test the deployment workflow',
        message_type: 'chat',
      },
    })

    expect(decision.no_reply_required).toBe(false)
  })

  test('terminal_baton round-trips through queue payload JSON', () => {
    const baton = buildTerminalBaton({
      reason: 'unit_test',
      setBy: 'codex-aun',
      source: 'record_no_reply_command',
      now: () => new Date('2026-05-30T00:00:00.000Z'),
    })
    const payload = withTerminalBaton({ content: 'ack' }, baton)
    const parsed = parseQueuePayload(JSON.stringify(payload))

    expect(existingNoReplyBaton(parsed)).toMatchObject({
      no_reply_required: true,
      reason: 'unit_test',
      set_by: 'codex-aun',
      source: 'record_no_reply_command',
    })
  })

  test('withTerminalBaton preserves an existing no-reply baton exactly', () => {
    const existing = {
      no_reply_required: true,
      reason: 'operator_recorded',
      set_by: 'aun',
      set_at: '2026-05-30T03:00:00.000Z',
      source: 'record_no_reply_command',
      audit_note: 'keep-me',
    }
    const replacement = buildTerminalBaton({
      reason: 'deterministic_no_reply_policy',
      setBy: 'codex-aun',
      source: 'deterministic_no_reply_policy',
      now: () => new Date('2026-05-30T04:00:00.000Z'),
    })

    const payload = withTerminalBaton({ content: 'ack', terminal_baton: existing }, replacement)

    expect(payload.terminal_baton).toEqual(existing)
  })
})
