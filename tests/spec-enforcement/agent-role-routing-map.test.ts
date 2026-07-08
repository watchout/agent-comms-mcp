import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')

type RoleEntry = {
  agentId: string
  activeFunction?: string
  scope?: string
  controlSource?: string
  bindingIssue?: string
  functionBindingsRef?: string
  operatingProtocolRef?: string
  operatingProtocolCell?: string
  forbiddenActions?: string[]
  requiredEnv?: Record<string, string>
  legacyAgentIds?: string[]
  newWorkAllowedViaLegacyIds?: boolean
  selfSendTo?: string[]
}

type RoleRoutingConfig = {
  version: number
  channelId: string
  d7SuiteLeadRebinding?: {
    controlSource: string
    ownerDecision: string
    bindingIssue: string
    functionBindingsRef: string
    operatingProtocolRef: string
    operatingProtocolCell: string
    activeFunction: string
    agentComRuntimeAgentId: string
    oldAunImplementationAssignment: string
    aunImplementationOwner: string
    transportAdapterOwnershipUnchanged: boolean
  }
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
    expect(roleMap.roles.suite_lead.agentId).toBe('agent-com-dev')
    expect(roleMap.roles.aun_development_lead.agentId).toBe('codex-aun')
    expect(roleMap.roles.pr_audit_l1.agentId).toBe('auditor')
    expect(roleMap.roles.pr_audit_l2.agentId).toBe('codex-audit')
    expect(roleMap.roles.pr_approval_l3.agentId).toBe('codex-cto')
  })

  test('D7 suite-lead rebinding is coordination-only and separated from AUN implementation', () => {
    const suiteLead = roleMap.roles.suite_lead
    expect(suiteLead).toMatchObject({
      agentId: 'agent-com-dev',
      activeFunction: 'coordination_recorder',
      controlSource: 'https://github.com/watchout/iyasaka-arc/issues/23',
      bindingIssue: 'https://github.com/watchout/agent-comms-mcp/issues/837',
      functionBindingsRef: 'watchout/iyasaka-arc#21:docs/shirube/function-bindings.yaml',
      operatingProtocolRef: 'https://github.com/watchout/iyasaka-arc/issues/27',
      operatingProtocolCell: 'SUITE-LEAD-OPERATING-PROTOCOL-001',
    })
    expect(suiteLead.scope).toContain('iyasaka-arc suite')
    expect(suiteLead.forbiddenActions).toEqual(expect.arrayContaining([
      'implementation',
      'audit',
      'merge',
      'runtime_mutation',
    ]))

    expect(roleMap.roles.aun_development_lead.agentId).toBe('codex-aun')
    expect(suiteLead.agentId).not.toBe(roleMap.roles.aun_development_lead.agentId)
    expect(roleMap.d7SuiteLeadRebinding).toMatchObject({
      agentComRuntimeAgentId: 'agent-com-dev',
      activeFunction: 'coordination_recorder',
      functionBindingsRef: 'watchout/iyasaka-arc#21:docs/shirube/function-bindings.yaml',
      operatingProtocolRef: 'https://github.com/watchout/iyasaka-arc/issues/27',
      operatingProtocolCell: 'SUITE-LEAD-OPERATING-PROTOCOL-001',
      oldAunImplementationAssignment: 'cleared',
      aunImplementationOwner: 'codex-aun',
      transportAdapterOwnershipUnchanged: true,
    })
  })

  test('suite lead baseline is pinned to the deterministic tick protocol', () => {
    const suiteLead = roleMap.roles.suite_lead
    expect(suiteLead.operatingProtocolRef).toBe('https://github.com/watchout/iyasaka-arc/issues/27')
    expect(suiteLead.operatingProtocolCell).toBe('SUITE-LEAD-OPERATING-PROTOCOL-001')
    expect(roleMap.d7SuiteLeadRebinding?.operatingProtocolRef).toBe(suiteLead.operatingProtocolRef)
    expect(roleMap.d7SuiteLeadRebinding?.operatingProtocolCell).toBe(suiteLead.operatingProtocolCell)
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
