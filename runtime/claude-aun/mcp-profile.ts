import type { AunRuntimeMcpProfile } from '../types'

export const claudeAunMcpProfile: AunRuntimeMcpProfile = {
  agentId: 'claude-aun',
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

