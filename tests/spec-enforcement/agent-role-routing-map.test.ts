import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')

type RoleEntry = {
  agentId: string
  requiredEnv?: Record<string, string>
  legacyAgentIds?: string[]
  newWorkAllowedViaLegacyIds?: boolean
  selfSendTo?: string[]
}

type RoleRoutingConfig = {
  version: number
  channelId: string
  roles: Record<string, RoleEntry>
  legacyAgentIds: Record<string, {
    canonicalAgentId: string
    newWorkAllowed: boolean
    reason: string
    status: string
  }>
  mcpNamespacePolicy: {
    canonicalRegistration: string
    legacyRegistrations: string[]
    canonicalToolPrefix: string
    legacyToolPrefixes: string[]
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

describe('agent role routing map', () => {
  const roleMap = readJson<RoleRoutingConfig>(join(REPO, 'config', 'agent-role-routing.json'))
  const botRouting = readJson<{
    channels: Record<string, { outboundAllowlist?: string[] }>
  }>(join(REPO, 'config', 'bot-routing.json'))

  test('pins PR governance roles to canonical agent_id values', () => {
    expect(roleMap.version).toBe(1)
    expect(roleMap.channelId).toBe('1487368919613444156')
    expect(roleMap.roles.aun_development_lead.agentId).toBe('codex-aun')
    expect(roleMap.roles.pr_audit_l1.agentId).toBe('auditor')
    expect(roleMap.roles.pr_audit_l2.agentId).toBe('codex-audit')
    expect(roleMap.roles.pr_approval_l3.agentId).toBe('codex-cto')
  })

  test('legacy cto is not a new-work target for any role', () => {
    for (const role of Object.values(roleMap.roles)) {
      expect(role.agentId).not.toBe('cto')
    }
    expect(roleMap.legacyAgentIds.cto).toEqual({
      canonicalAgentId: 'codex-cto',
      status: 'disabled',
      newWorkAllowed: false,
      reason: 'The legacy CTO identity is retained for history only. New L3 approval work targets codex-cto.',
    })
    expect(roleMap.roles.pr_approval_l3.legacyAgentIds).toEqual(['cto'])
    expect(roleMap.roles.pr_approval_l3.newWorkAllowedViaLegacyIds).toBe(false)
  })

  test('AUN lead MCP identity cannot collapse into codex-cto', () => {
    const lead = roleMap.roles.aun_development_lead
    expect(lead.requiredEnv).toEqual({
      AGENT_ID: 'codex-aun',
      AGENT_COM_EXPECTED_AGENT_ID: 'codex-aun',
    })
    expect(lead.selfSendTo).toContain('codex-cto')
    expect(lead.agentId).not.toBe(roleMap.roles.pr_approval_l3.agentId)
  })

  test('role recipients are present in the channel outbound allowlist', () => {
    const allowlist = botRouting.channels[roleMap.channelId]?.outboundAllowlist ?? []
    for (const role of Object.values(roleMap.roles)) {
      expect(allowlist).toContain(role.agentId)
    }
  })

  test('MCP namespace policy keeps aun canonical and agent-comms legacy-only', () => {
    expect(roleMap.mcpNamespacePolicy.canonicalRegistration).toBe('aun')
    expect(roleMap.mcpNamespacePolicy.legacyRegistrations).toContain('agent-comms')
    expect(roleMap.mcpNamespacePolicy.canonicalToolPrefix).toBe('mcp__aun__')
    expect(roleMap.mcpNamespacePolicy.legacyToolPrefixes).toContain('mcp__agent_comms__')
    expect(roleMap.mcpNamespacePolicy.legacyToolPrefixes).toContain('mcp__agent-comms__')
  })
})
