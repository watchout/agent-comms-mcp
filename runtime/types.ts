export type AunRuntimeName = 'claude-aun' | 'codex-aun'

export type AunToolName =
  | 'notify'
  | 'send'
  | 'inbox'
  | 'next'
  | 'processing'
  | 'done'
  | 'status'

export interface AunRuntimeAdapter {
  readonly name: AunRuntimeName
  readonly agentId: string
  readonly mcpServerName: string
  readonly tools: readonly AunToolName[]
}

export interface AunRuntimeMcpProfile {
  readonly agentId: string
  readonly serverName: string
  readonly toolPrefix: string
  readonly requiredTools: readonly AunToolName[]
}

