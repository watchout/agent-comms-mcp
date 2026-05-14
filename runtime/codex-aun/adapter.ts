import type { AunRuntimeAdapter } from '../types'
import { codexAunMcpProfile } from './mcp-profile'

export const codexAunAdapter: AunRuntimeAdapter = {
  name: 'codex-aun',
  agentId: codexAunMcpProfile.agentId,
  mcpServerName: codexAunMcpProfile.serverName,
  tools: codexAunMcpProfile.requiredTools,
}

