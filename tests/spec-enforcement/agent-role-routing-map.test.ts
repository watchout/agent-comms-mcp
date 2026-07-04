import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')

type RoleEntry = {
  agentId: string
  authority?: string
  activeFunction?: string
  scope?: string
  controlSource?: string
  delegationPolicyRef?: string
  bindingIssue?: string
  functionBindingsRef?: string
  delegationSourceRequired?: string
  mayPostOwnerExactHeadDecision?: boolean
  mayMerge?: boolean
  mayRuntimeActivate?: boolean
  mayMutateProtectedRuntimeSurface?: boolean
  dualRoleCollapseWith?: string[]
  dualRoleCollapseScope?: string
  requiredPrerequisites?: string[]
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
    expect(roleMap.roles.repo_owner_exact_head_decision.agentId).toBe('codex-cto')
  })

  test('D7 suite-lead rebinding is coordination-only and separated from AUN implementation', () => {
    const suiteLead = roleMap.roles.suite_lead
    expect(suiteLead).toMatchObject({
      agentId: 'agent-com-dev',
      activeFunction: 'coordination_recorder',
      controlSource: 'https://github.com/watchout/iyasaka-arc/issues/23',
      bindingIssue: 'https://github.com/watchout/agent-comms-mcp/issues/837',
      functionBindingsRef: 'watchout/iyasaka-arc#21:docs/shirube/function-bindings.yaml',
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
      oldAunImplementationAssignment: 'cleared',
      aunImplementationOwner: 'codex-aun',
      transportAdapterOwnershipUnchanged: true,
    })
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

  test('repo owner exact-head decision is delegated to codex-cto with fail-closed boundaries', () => {
    const owner = roleMap.roles.repo_owner_exact_head_decision
    expect(owner).toMatchObject({
      agentId: 'codex-cto',
      authority: 'delegated_repo_owner_exact_head_decision',
      activeFunction: 'protected_surface_gate',
      controlSource: 'https://github.com/watchout/agent-comms-mcp/issues/794#issuecomment-4880967837',
      delegationPolicyRef: 'https://github.com/watchout/agent-comms-mcp/issues/794#issuecomment-4880983284',
      delegationSourceRequired: 'owner_or_ceo_policy_or_decision_record',
      mayPostOwnerExactHeadDecision: true,
      mayMerge: false,
      mayRuntimeActivate: false,
      mayMutateProtectedRuntimeSurface: false,
      dualRoleCollapseScope: 'exact_head_owner_decision_only',
    })
    expect(owner.dualRoleCollapseWith).toEqual(['cto_review'])
    expect(owner.requiredPrerequisites).toEqual(expect.arrayContaining([
      'implementation_actor_not_codex_cto',
      'independent_audit_complete_exact_head_matched_clean',
      'technical_owner_review_complete_exact_head_matched_clean',
      'cto_review_complete_exact_head_matched_clean',
      'additional_review_completion_complete_no_mismatch',
      'owner_decision_required_is_only_remaining_gate',
    ]))
    expect(owner.forbiddenActions).toEqual(expect.arrayContaining([
      'merge',
      'ready_handling',
      'runtime_activation',
      'launchd_apply_or_restart',
      'checkout_materialization',
      'queue_db_fifo_mutation',
      'secret_credential_deployment_mutation',
      'branch_protection_ruleset_required_check_mutation',
      'github_repository_permission_change',
    ]))
    expect(owner.agentId).toBe(roleMap.roles.pr_approval_l3.agentId)
    expect(owner.agentId).not.toBe(roleMap.roles.suite_lead.agentId)
    expect(owner.agentId).not.toBe(roleMap.roles.aun_development_lead.agentId)
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
