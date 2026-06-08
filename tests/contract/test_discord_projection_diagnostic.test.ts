import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDiscordProjectionDiagnosticReport,
  formatDiscordProjectionDiagnosticText,
} from '../../core/discord-projection-diagnostic'
import { resetChannelPolicyCache } from '../../core/channel-policy'
import type { OutboundProjectionDecision } from '../../core/outbound-projection'

const REPO = join(import.meta.dir, '..', '..')
const TMP_CONFIG = `/tmp/discord-projection-diagnostic-${process.pid}-${Date.now()}.json`

function setRoutingConfig(channels: Record<string, unknown>) {
  writeFileSync(TMP_CONFIG, JSON.stringify({ version: 1, channels }), 'utf8')
  process.env.AGENT_COM_BOT_ROUTING_PATH = TMP_CONFIG
  resetChannelPolicyCache()
}

function mockAgent(
  agentId: string,
  options: { discordId?: string | null; status?: string; agentType?: string } = {},
) {
  const discordId = options.discordId === undefined ? `${agentId}-discord-id` : options.discordId
  return {
    agent_id: agentId,
    agent_type: options.agentType ?? 'dev',
    status: options.status ?? 'idle',
    provider_token_source_ref: `local-env:DISCORD_TOKEN_${agentId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
    discord_token: null,
    metadata: discordId ? { discord_id: discordId } : {},
  }
}

function mockProjectionDb(options: {
  channelExternalId?: string
  agents?: Record<string, any>
  eligibleDeliveryAgents?: string[]
  bindingDeliveryAgents?: string[]
  readOnlyDeliveryAgents?: string[]
  connectorOnlyAgents?: string[]
  credentialMissingAgents?: string[]
  credentialStatusByAgent?: Record<string, string>
} = {}) {
  const eligibleAgents = new Set(options.eligibleDeliveryAgents ?? [])
  const bindingAgents = new Set(options.bindingDeliveryAgents ?? [])
  const readOnlyAgents = new Set(options.readOnlyDeliveryAgents ?? [])
  const connectorOnlyAgents = new Set(options.connectorOnlyAgents ?? [])
  const credentialMissingAgents = new Set(options.credentialMissingAgents ?? [])
  const agentFromConnector = (connectorId: unknown) => {
    if (typeof connectorId !== 'string') return ''
    const match = connectorId.match(/^connector-(.+)$/)
    return match?.[1] ?? ''
  }
  const connectorIdsFor = (agentId: string) => {
    if (
      eligibleAgents.has(agentId)
      || bindingAgents.has(agentId)
      || readOnlyAgents.has(agentId)
      || connectorOnlyAgents.has(agentId)
      || credentialMissingAgents.has(agentId)
    ) {
      return [`connector-${agentId}`]
    }
    return []
  }

  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('channel_routing_policy')) {
        return { rows: [] }
      }
      if (sql.includes('thread_adapters')) {
        return { rows: [] }
      }
      if (sql.includes('channel_adapters')) {
        return {
          rows: [{
            external_id: options.channelExternalId ?? 'discord-ch',
            metadata: null,
          }],
        }
      }
      if (sql.includes('connector_instances')) {
        const agentId = typeof params?.[1] === 'string' ? params[1] : ''
        return { rows: connectorIdsFor(agentId).map((connector_instance_id) => ({ connector_instance_id, status: 'active' })) }
      }
      if (sql.includes('connector_credentials')) {
        const agentId = typeof params?.[1] === 'string' ? params[1] : ''
        const connectorInstanceId = typeof params?.[2] === 'string' ? params[2] : ''
        if (credentialMissingAgents.has(agentId)) {
          return { rows: [] }
        }
        const credential_status = options.credentialStatusByAgent?.[agentId] ?? 'active'
        if (connectorIdsFor(agentId).includes(connectorInstanceId)) {
          return { rows: [{ credential_id: `credential-${agentId}`, credential_status }] }
        }
        return { rows: [] }
      }
      if (sql.includes('channel_connector_bindings')) {
        const connectorInstanceId = typeof params?.[2] === 'string' ? params[2] : ''
        const agentId = agentFromConnector(connectorInstanceId)
        if (bindingAgents.has(agentId)) {
          return { rows: [{ channel_binding_id: `binding-${agentId}` }] }
        }
        return { rows: [] }
      }
      if (sql.includes('provider_channel_access')) {
        const connectorInstanceId = typeof params?.[2] === 'string' ? params[2] : ''
        const agentId = agentFromConnector(connectorInstanceId)
        if (eligibleAgents.has(agentId)) {
          return { rows: [{ provider_channel_access_id: `access-${agentId}`, capabilities: { message_create: true } }] }
        }
        if (readOnlyAgents.has(agentId)) {
          return { rows: [{ provider_channel_access_id: `access-${agentId}`, capabilities: { channel_get: true } }] }
        }
        return { rows: [] }
      }
      if (sql.includes('agent_ui_bindings')) {
        return { rows: [] }
      }
      if (sql.includes('agents')) {
        const agentId = typeof params?.[0] === 'string' ? params[0] : ''
        const row = options.agents?.[agentId]
        return { rows: row ? [row] : [] }
      }
      return { rows: [] }
    },
  }
}

function forcedAunFallbackDecision(): OutboundProjectionDecision {
  return {
    platform: 'discord',
    channelExternalId: 'discord-ch',
    consumerAgentId: 'aun',
    consumerSource: 'channel_policy_adapter_owner',
    consumerEvidence: {
      source_table: 'provider_channel_access',
      provider: 'discord',
      channel_id: 'main',
      provider_channel_id: 'discord-ch',
      agent_id: 'aun',
      connector_instance_id: 'connector-aun',
      credential_id: 'credential-aun',
      credential_status: 'active',
      channel_binding_id: null,
      provider_channel_access_id: 'access-aun',
    },
    projectionIdentityId: 'aun',
    intendedProjectionIdentityId: 'ceo',
    projectionSource: 'fallback_adapter_owner',
    projectionFallbackReason: 'recipient_projection_human',
    deliveryFallbackReason: 'channel_policy_adapter_owner',
    deliveryDiagnostics: [
      {
        agent_id: 'codex-cto',
        connector_instance_id: 'connector-codex-cto',
        source: 'sender_token_evidence',
        code: 'eligible',
        detail: {
          credential_id: 'credential-codex-cto',
          credential_status: 'registered',
          channel_binding_id: 'binding-codex-cto',
          evidence_source: 'channel_connector_bindings',
        },
      },
      {
        agent_id: 'aun',
        connector_instance_id: 'connector-aun',
        source: 'channel_policy_adapter_owner',
        code: 'eligible',
        detail: {
          credential_id: 'credential-aun',
          credential_status: 'active',
          provider_channel_access_id: 'access-aun',
          evidence_source: 'provider_channel_access',
        },
      },
    ],
  }
}

const scope = {
  channelId: 'main',
  senderAgentId: 'codex-cto',
  recipientAgentIds: ['ceo'],
}

beforeEach(() => {
  setRoutingConfig({
    main: {
      primary: 'aun',
      adapterOwner: 'aun',
    },
  })
})

afterEach(() => {
  delete process.env.AGENT_COM_BOT_ROUTING_PATH
  resetChannelPolicyCache()
  if (existsSync(TMP_CONFIG)) {
    try { unlinkSync(TMP_CONFIG) } catch {}
  }
})

describe('#604 Discord projection diagnostic', () => {
  test('sender credential registered and writable yields direct delivery PASS', async () => {
    const db = mockProjectionDb({
      bindingDeliveryAgents: ['codex-cto'],
      eligibleDeliveryAgents: ['aun'],
      credentialStatusByAgent: { 'codex-cto': 'registered', aun: 'active' },
      agents: {
        aun: mockAgent('aun'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
        ceo: mockAgent('ceo', { agentType: 'human', discordId: 'ceo-discord-id' }),
      },
    })

    const report = await buildDiscordProjectionDiagnosticReport(db, scope, {
      now: new Date('2026-06-02T00:00:00.000Z'),
    })

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.mutation_performed).toBe(false)
    expect(report.contract).toMatchObject({
      runtime_login_credential_statuses: ['active', 'registered'],
      delivery_credential_statuses: ['active', 'registered'],
      runtime_delivery_status_contract: 'aligned',
      sender_direct_preferred_over_router: true,
      fallback_requires_explicit_allowance: true,
      selected_delivery_evidence_required: true,
      no_live_discord_write: true,
    })
    expect(report.decision).toMatchObject({
      consumer_agent_id: 'codex-cto',
      projection_identity_id: 'codex-cto',
      delivery_connector_instance_id: 'connector-codex-cto',
      channel_binding_id: 'binding-codex-cto',
      credential_status: 'registered',
      provider_write_capability: 'channel_binding_outbound',
      fallback_allowed: false,
      fallback_reason: 'recipient_direct_unavailable',
      decision_source: 'sender_token_evidence',
    })
    expect(report.effective_delivery_owner).toMatchObject({
      ok: true,
      source: 'sender_direct',
      consumerAgentId: 'codex-cto',
      channelBindingId: 'binding-codex-cto',
    })
    expect(report.blockers).toEqual([])
  })

  test('credential contract is emitted in JSON and text for drift diagnostics', async () => {
    const db = mockProjectionDb({
      bindingDeliveryAgents: ['codex-cto'],
      credentialStatusByAgent: { 'codex-cto': 'registered' },
      agents: {
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
        ceo: mockAgent('ceo', { agentType: 'human', discordId: 'ceo-discord-id' }),
      },
    })

    const report = await buildDiscordProjectionDiagnosticReport(db, scope, {
      now: new Date('2026-06-02T00:00:30.000Z'),
    })
    const text = formatDiscordProjectionDiagnosticText(report)

    expect(report.contract.runtime_delivery_status_contract).toBe('aligned')
    expect(report.contract.runtime_login_credential_statuses).toEqual(['active', 'registered'])
    expect(report.contract.delivery_credential_statuses).toEqual(['active', 'registered'])
    expect(text).toContain('Credential contract: aligned')
    expect(text).toContain('Runtime login statuses: active, registered')
    expect(text).toContain('Delivery statuses: active, registered')
    expect(text).toContain('Effective delivery owner: ok:sender_direct')
  })

  test('usable sender credential falling back to AUN is a blocker', async () => {
    const db = mockProjectionDb()

    const report = await buildDiscordProjectionDiagnosticReport(db, scope, {
      now: new Date('2026-06-02T00:01:00.000Z'),
      resolveDecision: async () => forcedAunFallbackDecision(),
    })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.decision).toMatchObject({
      consumer_agent_id: 'aun',
      decision_source: 'channel_policy_adapter_owner',
      fallback_allowed: false,
      fallback_reason: 'channel_policy_adapter_owner',
      credential_status: 'active',
      provider_write_capability: 'provider_channel_access_write',
    })
    expect(report.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      'DIRECT_DELIVERY_MISMATCH',
      'FALLBACK_NOT_ALLOWED',
      'USABLE_SENDER_FELL_BACK_TO_ROUTER',
    ]))
    expect(report.effective_delivery_owner).toMatchObject({
      ok: false,
      code: 'FALLBACK_POLICY_DENIED',
      evidence: {
        consumerAgentId: 'aun',
        consumerSource: 'channel_policy_adapter_owner',
      },
    })
  })

  test('explicit fallback allowance makes non-direct AUN delivery a warning only when selected evidence is usable', async () => {
    const db = mockProjectionDb({
      readOnlyDeliveryAgents: ['codex-cto'],
      eligibleDeliveryAgents: ['aun'],
      credentialStatusByAgent: { 'codex-cto': 'registered', aun: 'active' },
      agents: {
        aun: mockAgent('aun'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
        ceo: mockAgent('ceo', { agentType: 'human', discordId: 'ceo-discord-id' }),
      },
    })

    const report = await buildDiscordProjectionDiagnosticReport(db, {
      ...scope,
      fallbackAllowed: true,
    }, {
      now: new Date('2026-06-02T00:02:00.000Z'),
    })

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.decision).toMatchObject({
      consumer_agent_id: 'aun',
      decision_source: 'channel_policy_adapter_owner',
      fallback_allowed: true,
      fallback_reason: 'sender_direct_unavailable',
      credential_status: 'active',
      provider_write_capability: 'provider_channel_access_write',
    })
    expect(report.blockers).toEqual([])
    expect(report.warnings.map((item) => item.code)).toEqual(['FALLBACK_ALLOWED'])
    expect(report.effective_delivery_owner).toMatchObject({
      ok: true,
      source: 'legacy_adapter_owner',
      consumerAgentId: 'aun',
    })
  })

  test('fallback allowance does not turn unknown sender credential evidence into success', async () => {
    const db = mockProjectionDb({
      credentialMissingAgents: ['codex-cto'],
      eligibleDeliveryAgents: ['aun'],
      credentialStatusByAgent: { aun: 'active' },
      agents: {
        aun: mockAgent('aun'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
        ceo: mockAgent('ceo', { agentType: 'human', discordId: 'ceo-discord-id' }),
      },
    })

    const report = await buildDiscordProjectionDiagnosticReport(db, {
      ...scope,
      fallbackAllowed: true,
    }, {
      now: new Date('2026-06-02T00:02:30.000Z'),
    })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.blockers.map((item) => item.code)).toContain('SENDER_CREDENTIAL_UNKNOWN')
    expect(report.warnings).toEqual([])
  })

  test.each([
    ['missing outbound binding and provider write evidence', { connectorOnlyAgents: ['codex-cto'] }, 'SENDER_WRITE_EVIDENCE_MISSING'],
    ['unknown sender credential', { credentialMissingAgents: ['codex-cto'] }, 'SENDER_CREDENTIAL_UNKNOWN'],
    ['read-only provider access', { readOnlyDeliveryAgents: ['codex-cto'] }, 'SENDER_WRITE_EVIDENCE_MISSING'],
  ])('%s fails closed', async (_name, options, expectedCode) => {
    const db = mockProjectionDb({
      ...options,
      credentialStatusByAgent: { 'codex-cto': 'registered' },
      agents: {
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
        ceo: mockAgent('ceo', { agentType: 'human', discordId: 'ceo-discord-id' }),
      },
    })

    const report = await buildDiscordProjectionDiagnosticReport(db, scope, {
      now: new Date('2026-06-02T00:03:00.000Z'),
    })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.mutation_performed).toBe(false)
    expect(report.blockers.map((item) => item.code)).toContain(expectedCode)
  })

  test('diagnostic path has no live Discord write, restart, or queue-drain calls', () => {
    const coreSrc = readFileSync(join(REPO, 'core/discord-projection-diagnostic.ts'), 'utf8')
    const cliSrc = readFileSync(join(REPO, 'cli/index.ts'), 'utf8')
    const start = cliSrc.indexOf('async function diagnoseProjection')
    const end = cliSrc.indexOf('async function diagnoseQueue')
    const cliBody = cliSrc.slice(start, end)
    const executablePath = `${coreSrc}\n${cliBody}`

    for (const forbidden of [
      'sendProjectedDiscordMessage',
      'createDiscordClient',
      'launchctl',
      'restartSession',
      'send-keys',
      'handleNext',
      'nextMessage',
      'inbox(',
      'agent-com next',
      'agent-com inbox',
      'FIFO',
    ]) {
      expect(executablePath).not.toContain(forbidden)
    }
    expect(executablePath).toContain('mutation_performed: false')
  })
})
