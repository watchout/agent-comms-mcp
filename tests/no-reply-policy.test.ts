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

  test('no-further-action acknowledgement is terminal without gate-classifier ambiguity', () => {
    const decision = detectNoReplyIntent({
      payload: {
        content: 'Recorded. No further action on this acknowledgement.',
      },
    })

    expect(decision.no_reply_required).toBe(true)
    expect(decision.reason).toBe('explicit_no_further_action_acknowledgement')
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
})
