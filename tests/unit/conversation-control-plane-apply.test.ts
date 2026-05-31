import { describe, expect, test } from 'bun:test'
import { applyConversationControlPlaneAllocation } from '../../core/conversation-control-plane-apply'
import type { DbAdapter } from '../../core/db/adapter'
import type { ConversationRootAllocationInput, ConversationRootAllocationResult } from '../../core/conversation-control-plane'

const fakeDb = {} as DbAdapter

const input: ConversationRootAllocationInput = {
  surface: 'mcp',
  channel_id: 'audit-channel',
  root_request_id: 'request-1',
  owner_agent_id: 'owner-a',
}

function allocator(result: ConversationRootAllocationResult): NonNullable<Parameters<typeof applyConversationControlPlaneAllocation>[3]>['allocator'] {
  return async () => result
}

describe('conversation control-plane apply helper', () => {
  test('off mode skips allocation without touching the allocator', async () => {
    let called = false
    const result = await applyConversationControlPlaneAllocation(fakeDb, 'mcp.send', input, {
      env: {},
      allocator: async () => {
        called = true
        return { ok: false, error: 'ACTIVE_BATON_EXISTS', detail: 'unexpected' }
      },
    })

    expect(called).toBe(false)
    expect(result).toMatchObject({
      ok: true,
      action: 'skipped',
      gate: {
        mode: 'off',
        allocate: false,
        block_on_error: false,
        audit_only: false,
      },
    })
  })

  test('shadow mode reports allocation success without blocking', async () => {
    const result = await applyConversationControlPlaneAllocation(fakeDb, 'cli.send', input, {
      env: { AGENT_COM_CONVERSATION_CONTROL_PLANE: 'shadow' },
      allocator: allocator({
        ok: true,
        conversation_id: 'conversation-1',
        baton_id: 'baton-1',
        conversation_action: 'created',
        baton_action: 'created',
        baton: {
          baton_id: 'baton-1',
          conversation_id: 'conversation-1',
          owner_agent_id: 'owner-a',
          state: 'active',
          source_queue_id: null,
          lease_id: null,
          claim_id: null,
          completion_outcome: null,
        },
      }),
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'allocated',
      allocation: {
        ok: true,
        conversation_id: 'conversation-1',
        baton_id: 'baton-1',
      },
      metadata: {
        conversation_control_plane: {
          mode: 'shadow',
          surface: 'cli.send',
          allocate: true,
          block_on_error: false,
          audit_only: true,
        },
      },
    })
  })

  test('shadow mode converts allocation failure into audit-only success', async () => {
    const result = await applyConversationControlPlaneAllocation(fakeDb, 'receive-runner', input, {
      env: { AGENT_COM_CONVERSATION_CONTROL_PLANE: 'shadow' },
      allocator: allocator({ ok: false, error: 'ACTIVE_BATON_OWNER_MISMATCH', detail: 'baton-1' }),
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'shadow_failed',
      allocation_error: {
        ok: false,
        error: 'ACTIVE_BATON_OWNER_MISMATCH',
        detail: 'baton-1',
      },
    })
  })

  test('enforce mode returns allocation failure as a blocking error', async () => {
    const result = await applyConversationControlPlaneAllocation(fakeDb, 'receive-runner', input, {
      env: { AGENT_COM_CONVERSATION_CONTROL_PLANE: 'enforce' },
      allocator: allocator({ ok: false, error: 'MESSAGE_CONVERSATION_STAMP_NOT_FOUND', detail: 'missing-message' }),
    })

    expect(result).toMatchObject({
      ok: false,
      action: 'enforce_failed',
      allocation_error: {
        ok: false,
        error: 'MESSAGE_CONVERSATION_STAMP_NOT_FOUND',
        detail: 'missing-message',
      },
      metadata: {
        conversation_control_plane: {
          mode: 'enforce',
          block_on_error: true,
          audit_only: false,
        },
      },
    })
  })

  test('invalid rollout mode fails closed before allocation', async () => {
    let called = false
    const result = await applyConversationControlPlaneAllocation(fakeDb, 'mcp.notify', input, {
      env: { AGENT_COM_CONVERSATION_CONTROL_PLANE: 'maybe' },
      allocator: async () => {
        called = true
        return { ok: false, error: 'ACTIVE_BATON_EXISTS', detail: 'unexpected' }
      },
    })

    expect(called).toBe(false)
    expect(result).toEqual({
      ok: false,
      error: 'CONVERSATION_CONTROL_PLANE_MODE_INVALID',
      value: 'maybe',
      surface: 'mcp.notify',
    })
  })
})
