import { describe, expect, test } from 'bun:test'
import {
  buildTerminalBaton,
  detectNoReplyIntent,
  existingNoReplyBaton,
  parseQueuePayload,
  withTerminalBaton,
} from '../core/no-reply-policy'

describe('deterministic no-reply policy', () => {
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
