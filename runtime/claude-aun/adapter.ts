import type { AunRuntimeAdapter } from '../types'
import { claudeAunMcpProfile } from './mcp-profile'

export const claudeAunAdapter: AunRuntimeAdapter = {
  name: 'claude-aun',
  agentId: claudeAunMcpProfile.agentId,
  mcpServerName: claudeAunMcpProfile.serverName,
  tools: claudeAunMcpProfile.requiredTools,
}

