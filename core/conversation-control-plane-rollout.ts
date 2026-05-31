export const CONVERSATION_CONTROL_PLANE_MODES = ['off', 'shadow', 'enforce'] as const

export type ConversationControlPlaneMode = (typeof CONVERSATION_CONTROL_PLANE_MODES)[number]

export type ConversationControlPlaneSurface =
  | 'mcp.notify'
  | 'mcp.send'
  | 'cli.notify'
  | 'cli.send'
  | 'receive-runner'
  | 'test'

export type ConversationControlPlaneGateError = 'CONVERSATION_CONTROL_PLANE_MODE_INVALID'

export interface ConversationControlPlaneGate {
  ok: true
  mode: ConversationControlPlaneMode
  surface: ConversationControlPlaneSurface
  allocate: boolean
  block_on_error: boolean
  audit_only: boolean
}

export interface ConversationControlPlaneGateErr {
  ok: false
  error: ConversationControlPlaneGateError
  value: string
  surface: ConversationControlPlaneSurface
}

export type ConversationControlPlaneGateResult =
  | ConversationControlPlaneGate
  | ConversationControlPlaneGateErr

export interface ConversationControlPlaneEnv {
  AGENT_COM_CONVERSATION_CONTROL_PLANE?: string
}

function normalizeMode(value: string | undefined): ConversationControlPlaneMode | null {
  const normalized = (value ?? 'off').trim().toLowerCase()
  if ((CONVERSATION_CONTROL_PLANE_MODES as readonly string[]).includes(normalized)) {
    return normalized as ConversationControlPlaneMode
  }
  return null
}

export function resolveConversationControlPlaneGate(
  surface: ConversationControlPlaneSurface,
  env: ConversationControlPlaneEnv = process.env,
): ConversationControlPlaneGateResult {
  const mode = normalizeMode(env.AGENT_COM_CONVERSATION_CONTROL_PLANE)
  if (!mode) {
    return {
      ok: false,
      error: 'CONVERSATION_CONTROL_PLANE_MODE_INVALID',
      value: String(env.AGENT_COM_CONVERSATION_CONTROL_PLANE ?? ''),
      surface,
    }
  }
  return {
    ok: true,
    mode,
    surface,
    allocate: mode !== 'off',
    block_on_error: mode === 'enforce',
    audit_only: mode === 'shadow',
  }
}

export function conversationControlPlaneMetadata(
  gate: ConversationControlPlaneGate,
): {
  conversation_control_plane: {
    mode: ConversationControlPlaneMode
    surface: ConversationControlPlaneSurface
    allocate: boolean
    block_on_error: boolean
    audit_only: boolean
  }
} {
  return {
    conversation_control_plane: {
      mode: gate.mode,
      surface: gate.surface,
      allocate: gate.allocate,
      block_on_error: gate.block_on_error,
      audit_only: gate.audit_only,
    },
  }
}
