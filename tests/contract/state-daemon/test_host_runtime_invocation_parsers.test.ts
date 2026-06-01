import { describe, expect, test } from 'bun:test'
import {
  parseClaudeStreamJsonRuntimeResult,
  parseCodexJsonlRuntimeResult,
} from '../../../core/state-daemon/host-runtime-invocation'

const baseInput = {
  invocation_id: 'inv-parse-1',
  exit_status: 0,
  started_at: '2026-06-01T05:00:00.000Z',
  finished_at: '2026-06-01T05:00:05.000Z',
}

describe('host runtime invocation structured stream parsers', () => {
  test('Codex JSONL parser records event counts, final result, tool calls, and file changes', () => {
    const result = parseCodexJsonlRuntimeResult({
      ...baseInput,
      stdout: [
        JSON.stringify({ type: 'session_start' }),
        JSON.stringify({ type: 'tool_call', tool: { name: 'Read', status: 'ok', redacted_args_hash: 'sha256:abc' } }),
        JSON.stringify({ type: 'file_change', file_change: { path: 'core/state-daemon/index.ts', action: 'modified' } }),
        JSON.stringify({ type: 'final_result', final_message: 'done', structured_result: { outcome: 'reply' } }),
      ].join('\n'),
    })

    expect(result).toMatchObject({
      invocation_id: 'inv-parse-1',
      runtime: 'codex',
      exit_status: 0,
      final_message: 'done',
      final_structured_result: { outcome: 'reply' },
      schema_valid: true,
      parser_outcome: 'success',
      event_counts: {
        session_start: 1,
        tool_call: 1,
        file_change: 1,
        final_result: 1,
      },
      tool_calls: [
        { name: 'Read', status: 'ok', redacted_args_hash: 'sha256:abc' },
      ],
      file_changes: [
        { path: 'core/state-daemon/index.ts', action: 'modified' },
      ],
      degraded: false,
      degradation_reasons: [],
      timed_out: false,
    })
    expect(result.failure_code).toBeUndefined()
  })

  test('Codex JSONL parser turns malformed JSONL into STREAM_PARSE_ERROR evidence', () => {
    const result = parseCodexJsonlRuntimeResult({
      ...baseInput,
      stdout: [
        JSON.stringify({ type: 'session_start' }),
        '{not-json',
      ].join('\n'),
    })

    expect(result).toMatchObject({
      runtime: 'codex',
      schema_valid: false,
      parser_outcome: 'parse_error',
      failure_code: 'STREAM_PARSE_ERROR',
    })
    expect(result.parse_errors?.[0]).toContain('line 2')
  })

  test('Codex JSONL parser records missing final message as typed evidence', () => {
    const result = parseCodexJsonlRuntimeResult({
      ...baseInput,
      stdout: JSON.stringify({ type: 'result', structured_result: { outcome: 'reply' } }),
    })

    expect(result).toMatchObject({
      schema_valid: false,
      parser_outcome: 'parse_error',
      failure_code: 'FINAL_MESSAGE_MISSING',
    })
  })

  test('Claude stream-json parser records final structured result and tool status', () => {
    const result = parseClaudeStreamJsonRuntimeResult({
      ...baseInput,
      stdout: [
        JSON.stringify({ type: 'assistant', message: { content: 'working' } }),
        JSON.stringify({ type: 'tool_use', tool_name: 'Grep', status: 'ok' }),
        JSON.stringify({ type: 'final', message: 'done', final_structured_result: { outcome: 'handoff' } }),
      ].join('\n'),
    })

    expect(result).toMatchObject({
      runtime: 'claude',
      final_message: 'done',
      final_structured_result: { outcome: 'handoff' },
      schema_valid: true,
      event_counts: {
        assistant: 1,
        tool_use: 1,
        final: 1,
      },
      tool_calls: [
        { name: 'Grep', status: 'ok' },
      ],
    })
  })

  test('parser maps timeout, nonzero exit, and schema mismatch to stable failure codes', () => {
    expect(parseCodexJsonlRuntimeResult({
      ...baseInput,
      stdout: '',
      timed_out: true,
    })).toMatchObject({
      schema_valid: false,
      parser_outcome: 'runtime_error',
      failure_code: 'RUNTIME_TIMEOUT',
      timed_out: true,
    })

    expect(parseClaudeStreamJsonRuntimeResult({
      ...baseInput,
      stdout: JSON.stringify({ type: 'final', message: 'failed' }),
      exit_status: 2,
    })).toMatchObject({
      schema_valid: false,
      parser_outcome: 'runtime_error',
      failure_code: 'RUNTIME_NONZERO_EXIT',
    })

    expect(parseCodexJsonlRuntimeResult({
      ...baseInput,
      stdout: JSON.stringify({ type: 'final_result', final_message: 'done', structured_result: { outcome: 'reply' } }),
      schema_valid: false,
    })).toMatchObject({
      schema_valid: false,
      parser_outcome: 'schema_mismatch',
      failure_code: 'OUTPUT_SCHEMA_MISMATCH',
    })
  })
})
