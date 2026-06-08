import { describe, expect, test } from 'bun:test'
import {
  attachCodexRunnerResultContract,
  buildCodexRunnerTypedResultContract,
  parseCodexRunnerResultContract,
} from '../core/codex-runner-result-contract'

describe('Codex runner typed result contract', () => {
  test('claimed work without terminal completion is needs_human and fail-closed', () => {
    const result = buildCodexRunnerTypedResultContract({
      ok: true,
      retained_count: 1,
      retained: [{ queue_id: '101', message_id: 'msg-101' }],
      completion: {
        outcome: 'open',
        terminal_queue_ids: [],
        applied_count: 0,
      },
    })

    expect(result).toMatchObject({
      contract_version: 1,
      result_status: 'needs_human',
      retained_count: 1,
      queue_ids: ['101'],
      terminal_queue_ids: [],
      applied_count: 0,
      reason_code: 'final_close_required',
      fail_closed: true,
    })
  })

  test('no-reply completion is terminal typed evidence', () => {
    const result = buildCodexRunnerTypedResultContract({
      ok: true,
      retained_count: 1,
      retained: [{ queue_id: '102', message_id: 'msg-102' }],
      completion: {
        outcome: 'completed_no_reply',
        terminal_queue_ids: ['102'],
        applied_count: 1,
        reason: 'direct_mention_smoke_completed_without_substantive_reply',
      },
    })

    expect(result).toMatchObject({
      result_status: 'completed_no_reply',
      queue_ids: ['102'],
      terminal_queue_ids: ['102'],
      applied_count: 1,
      reason_code: 'completed_no_reply',
      reason: 'direct_mention_smoke_completed_without_substantive_reply',
      fail_closed: false,
    })
  })

  test('reply completion preserves reply evidence', () => {
    const result = buildCodexRunnerTypedResultContract({
      ok: true,
      retained_count: 1,
      retained: [{ queue_id: '103', message_id: 'msg-103' }],
      completion: {
        outcome: 'completed_reply',
        terminal_queue_ids: ['103'],
        applied_count: 1,
        reason: 'auto_final_reply_completed',
        reply_message_id: 'reply-103',
      },
    })

    expect(result).toMatchObject({
      result_status: 'completed_reply',
      terminal_queue_ids: ['103'],
      reply_message_id: 'reply-103',
      fail_closed: false,
    })
  })

  test('retry or completion failure is runtime_failed and fail-closed', () => {
    const result = buildCodexRunnerTypedResultContract({
      ok: false,
      retained_count: 1,
      retained: [{ queue_id: '104', message_id: 'msg-104' }],
      completion: {
        outcome: 'completion_failed',
        terminal_queue_ids: [],
        applied_count: 0,
        reason: 'retry_after_runtime_error',
      },
    })

    expect(result).toMatchObject({
      result_status: 'runtime_failed',
      queue_ids: ['104'],
      terminal_queue_ids: [],
      reason_code: 'completion_failed',
      reason: 'retry_after_runtime_error',
      fail_closed: true,
    })
  })

  test('stale or unsupported completion evidence is unsupported_completion', () => {
    const result = buildCodexRunnerTypedResultContract({
      ok: true,
      retained_count: 1,
      retained: [{ queue_id: '105', message_id: 'msg-105' }],
      completion: {
        outcome: 'stale_queue',
        terminal_queue_ids: [],
        applied_count: 0,
      },
    })

    expect(result).toMatchObject({
      result_status: 'unsupported_completion',
      queue_ids: ['105'],
      reason_code: 'unsupported_completion_outcome',
      fail_closed: true,
    })
  })

  test('no actionable rows are explicit non-terminal evidence', () => {
    const wrapped = attachCodexRunnerResultContract({
      ok: true,
      retained_count: 0,
      retained: [],
      completion: {
        outcome: 'none',
        terminal_queue_ids: [],
        applied_count: 0,
      },
    })

    expect(wrapped.runner_result).toMatchObject({
      result_status: 'needs_human',
      retained_count: 0,
      queue_ids: [],
      reason_code: 'no_actionable_work',
      fail_closed: true,
    })

    const parsed = parseCodexRunnerResultContract(JSON.stringify(wrapped))
    expect(parsed.ok).toBe(true)
    expect(parsed.result).toMatchObject({
      result_status: 'needs_human',
      reason_code: 'no_actionable_work',
    })
  })

  test('failed parse fails closed', () => {
    const parsed = parseCodexRunnerResultContract('not-json')

    expect(parsed.ok).toBe(false)
    expect(parsed.result).toMatchObject({
      result_status: 'runtime_failed',
      reason_code: 'stdout_parse_failed',
      fail_closed: true,
    })
  })

  test('missing typed result fails closed', () => {
    const parsed = parseCodexRunnerResultContract(JSON.stringify({
      ok: true,
      retained_count: 1,
      retained: [{ queue_id: '106', message_id: 'msg-106' }],
      completion: {
        outcome: 'completed_reply',
        terminal_queue_ids: ['106'],
        applied_count: 1,
      },
    }))

    expect(parsed.ok).toBe(false)
    expect(parsed.result).toMatchObject({
      result_status: 'unsupported_completion',
      reason_code: 'runner_result_malformed',
      fail_closed: true,
    })
  })

  test('malformed typed identity evidence fails closed', () => {
    const parsed = parseCodexRunnerResultContract(JSON.stringify({
      ok: true,
      retained_count: 1,
      retained: [{ queue_id: '107', message_id: 'msg-107' }],
      completion: {
        outcome: 'open',
        terminal_queue_ids: [],
        applied_count: 0,
      },
      runner_result: {
        contract_version: 1,
        result_status: 'needs_human',
        retained_count: 1,
        queue_ids: [],
        terminal_queue_ids: [],
        applied_count: 0,
        reason_code: 'final_close_required',
        reason: null,
        fail_closed: true,
      },
    }))

    expect(parsed.ok).toBe(false)
    expect(parsed.result).toMatchObject({
      result_status: 'unsupported_completion',
      reason_code: 'runner_result_malformed',
      fail_closed: true,
    })
    expect(parsed.error).toContain('queue_ids')
  })
})
