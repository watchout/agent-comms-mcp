import type { AunRuntimeMcpProfile } from '../types'

export const codexAunMcpProfile: AunRuntimeMcpProfile = {
  agentId: 'codex-aun',
  serverName: 'aun',
  toolPrefix: 'aun',
  requiredTools: [
    'notify',
    'send',
    'inbox',
    'processing',
    'done',
    'status',
  ],
}

