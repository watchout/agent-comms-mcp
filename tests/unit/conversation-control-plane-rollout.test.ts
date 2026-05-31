import { describe, expect, test } from 'bun:test'
import {
  conversationControlPlaneMetadata,
  resolveConversationControlPlaneGate,
} from '../../core/conversation-control-plane-rollout'

describe('conversation control-plane rollout gate', () => {
  test('defaults to off with no allocation and no blocking', () => {
    expect(resolveConversationControlPlaneGate('mcp.notify', {})).toEqual({
      ok: true,
      mode: 'off',
      surface: 'mcp.notify',
      allocate: false,
      block_on_error: false,
      audit_only: false,
    })
  })

  test('shadow allocates for evidence but does not block callers on allocation errors', () => {
    expect(resolveConversationControlPlaneGate('cli.send', {
      AGENT_COM_CONVERSATION_CONTROL_PLANE: 'shadow',
    })).toEqual({
      ok: true,
      mode: 'shadow',
      surface: 'cli.send',
      allocate: true,
      block_on_error: false,
      audit_only: true,
    })
  })

  test('enforce allocates and blocks callers on allocation errors', () => {
    expect(resolveConversationControlPlaneGate('receive-runner', {
      AGENT_COM_CONVERSATION_CONTROL_PLANE: 'ENFORCE',
    })).toEqual({
      ok: true,
      mode: 'enforce',
      surface: 'receive-runner',
      allocate: true,
      block_on_error: true,
      audit_only: false,
    })
  })

  test('invalid values fail closed with a stable error code', () => {
    expect(resolveConversationControlPlaneGate('mcp.send', {
      AGENT_COM_CONVERSATION_CONTROL_PLANE: 'auto',
    })).toEqual({
      ok: false,
      error: 'CONVERSATION_CONTROL_PLANE_MODE_INVALID',
      value: 'auto',
      surface: 'mcp.send',
    })
  })

  test('metadata carries rollout evidence for later audit logs', () => {
    const gate = resolveConversationControlPlaneGate('test', {
      AGENT_COM_CONVERSATION_CONTROL_PLANE: 'shadow',
    })
    expect(gate.ok).toBe(true)
    if (!gate.ok) return
    expect(conversationControlPlaneMetadata(gate)).toEqual({
      conversation_control_plane: {
        mode: 'shadow',
        surface: 'test',
        allocate: true,
        block_on_error: false,
        audit_only: true,
      },
    })
  })
})
