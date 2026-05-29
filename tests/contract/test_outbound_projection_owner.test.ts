import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import {
  OUTBOUND_SKIP_NO_DELIVERY_CONSUMER,
  outboundProjectionSkipReason,
  resolveOutboundProjectionDecision,
  resolveOutboundProjectionRoute,
} from '../../core/outbound-projection'
import { resetChannelPolicyCache } from '../../core/channel-policy'

const TMP_CONFIG = `/tmp/outbound-projection-${process.pid}-${Date.now()}.json`

function setRoutingConfig(channels: Record<string, unknown>) {
  writeFileSync(TMP_CONFIG, JSON.stringify({ version: 1, channels }), 'utf8')
  process.env.AGENT_COM_BOT_ROUTING_PATH = TMP_CONFIG
  resetChannelPolicyCache()
}

function mockAgent(
  agentId: string,
  options: { discordId?: string | null; status?: string; tokenBacked?: boolean } = {},
) {
  const discordId = options.discordId === undefined ? `${agentId}-discord-id` : options.discordId
  return {
    agent_id: agentId,
    status: options.status ?? 'idle',
    provider_token_source_ref: options.tokenBacked === false ? null : `local-env:DISCORD_TOKEN_${agentId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
    discord_token: null,
    metadata: discordId ? { discord_id: discordId } : {},
  }
}

function mockProjectionDb(options: {
  channelAdapterMetadata?: unknown
  channelExternalId?: string
  threadAdapterMetadata?: unknown
  threadExternalId?: string | null
  agents?: Record<string, any>
  eligibleDeliveryAgents?: string[]
  bindingDeliveryAgents?: string[]
  readOnlyDeliveryAgents?: string[]
  mismatchedDeliveryAgents?: string[]
  ambiguousDeliveryAgents?: string[]
  providerAccessByExternalId?: Record<string, string[]>
} = {}) {
  const eligibleAgents = new Set(options.eligibleDeliveryAgents ?? [])
  const bindingAgents = new Set(options.bindingDeliveryAgents ?? [])
  const readOnlyAgents = new Set(options.readOnlyDeliveryAgents ?? [])
  const mismatchedAgents = new Set(options.mismatchedDeliveryAgents ?? [])
  const ambiguousAgents = new Set(options.ambiguousDeliveryAgents ?? [])
  const agentFromConnector = (connectorId: unknown) => {
    if (typeof connectorId !== 'string') return ''
    const match = connectorId.match(/^connector-(.+?)(?:-(?:[0-9]+|credential|access))?$/)
    return match?.[1] ?? ''
  }
  const connectorIdsFor = (agentId: string) => {
    if (ambiguousAgents.has(agentId)) return [`connector-${agentId}-1`, `connector-${agentId}-2`]
    if (mismatchedAgents.has(agentId)) return [`connector-${agentId}-credential`, `connector-${agentId}-access`]
    if (
      eligibleAgents.has(agentId)
      || bindingAgents.has(agentId)
      || readOnlyAgents.has(agentId)
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
        if (options.threadExternalId !== undefined) {
          return {
            rows: [{
              external_id: options.threadExternalId,
              metadata: options.threadAdapterMetadata ?? null,
            }],
          }
        }
        return { rows: [] }
      }
      if (sql.includes('channel_adapters')) {
        return {
          rows: [{
            external_id: options.channelExternalId ?? 'discord-ch',
            metadata: options.channelAdapterMetadata ?? null,
          }],
        }
      }
      if (sql.includes('connector_instances')) {
        const agentId = typeof params?.[1] === 'string' ? params[1] : ''
        return { rows: connectorIdsFor(agentId).map((connector_instance_id) => ({ connector_instance_id })) }
      }
      if (sql.includes('connector_credentials')) {
        const agentId = typeof params?.[1] === 'string' ? params[1] : ''
        const connectorInstanceId = typeof params?.[2] === 'string' ? params[2] : ''
        if (mismatchedAgents.has(agentId)) {
          return {
            rows: connectorInstanceId.endsWith('-credential')
              ? [{ credential_id: `credential-${agentId}` }]
              : [],
          }
        }
        if (connectorIdsFor(agentId).includes(connectorInstanceId)) {
          return { rows: [{ credential_id: `credential-${agentId}` }] }
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
        const providerChannelId = typeof params?.[1] === 'string' ? params[1] : ''
        const connectorInstanceId = typeof params?.[2] === 'string' ? params[2] : ''
        const agentId = agentFromConnector(connectorInstanceId)
        const targetScopedAgents = options.providerAccessByExternalId
          ? new Set(options.providerAccessByExternalId[providerChannelId] ?? [])
          : null
        if (mismatchedAgents.has(agentId)) {
          return {
            rows: connectorInstanceId.endsWith('-access') && (!targetScopedAgents || targetScopedAgents.has(agentId))
              ? [{ provider_channel_access_id: `access-${agentId}`, capabilities: { message_create: true } }]
              : [],
          }
        }
        if ((eligibleAgents.has(agentId) || ambiguousAgents.has(agentId)) && (!targetScopedAgents || targetScopedAgents.has(agentId))) {
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

beforeEach(() => {
  setRoutingConfig({})
})

afterEach(() => {
  delete process.env.AGENT_COM_BOT_ROUTING_PATH
  resetChannelPolicyCache()
  if (existsSync(TMP_CONFIG)) {
    try { unlinkSync(TMP_CONFIG) } catch {}
  }
})

describe('#410 outbound projection owner resolution', () => {
  test('channel adapter metadata owner wins over author identity', async () => {
    const db = mockProjectionDb({
      channelAdapterMetadata: { consumer_agent_id: 'agent-com-dev' },
      eligibleDeliveryAgents: ['agent-com-dev'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
      },
    })
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.channelExternalId).toBe('discord-ch')
    expect(route.consumerAgentId).toBe('agent-com-dev')
    expect(route.source).toBe('channel_adapter_metadata')
  })

  test('bot-routing adapterOwner is the config fallback', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'adapter-agent' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['adapter-agent'],
      agents: { 'adapter-agent': mockAgent('adapter-agent') },
    })
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.channelExternalId).toBe('discord-ch')
    expect(route.consumerAgentId).toBe('adapter-agent')
    expect(route.source).toBe('channel_policy_adapter_owner')
  })

  test('bot-routing adapterOwner without connector evidence is not a Discord delivery consumer', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'adapter-agent' } })
    const db = mockProjectionDb({
      agents: {
        'adapter-agent': mockAgent('adapter-agent', { tokenBacked: false }),
        'primary-agent': mockAgent('primary-agent', { tokenBacked: false }),
      },
    })
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.channelExternalId).toBe('discord-ch')
    expect(route.consumerAgentId).toBeNull()
    expect(route.source).toBe('none')
  })

  test('native-role owner overrides channel adapterOwner only for matching sender', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
        nativeRoleOutboundOwners: { 'codex-cto': 'codex-cto' },
      },
    })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev', 'codex-cto'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto'),
      },
    })
    const codexCto = await resolveOutboundProjectionRoute(db, { channelId: 'ch1', senderAgentId: 'codex-cto' })
    expect(codexCto.consumerAgentId).toBe('codex-cto')
    expect(codexCto.source).toBe('channel_policy_native_role_owner')

    const otherAgent = await resolveOutboundProjectionRoute(db, { channelId: 'ch1', senderAgentId: 'codex-aun' })
    expect(otherAgent.consumerAgentId).toBe('agent-com-dev')
    expect(otherAgent.source).toBe('channel_policy_adapter_owner')
  })

  test('explicit adapter metadata still wins over native-role policy', async () => {
    setRoutingConfig({
      ch1: {
        adapterOwner: 'agent-com-dev',
        nativeRoleOutboundOwners: { 'codex-cto': 'codex-cto' },
      },
    })
    const db = mockProjectionDb({
      channelAdapterMetadata: { consumer_agent_id: 'metadata-owner' },
      eligibleDeliveryAgents: ['metadata-owner'],
      agents: {
        'metadata-owner': mockAgent('metadata-owner'),
        'codex-cto': mockAgent('codex-cto'),
      },
    })
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1', senderAgentId: 'codex-cto' })
    expect(route.consumerAgentId).toBe('metadata-owner')
    expect(route.source).toBe('channel_adapter_metadata')
  })

  test('explicit adapter metadata still wins over recipient-facing projection', async () => {
    const db = mockProjectionDb({
      channelAdapterMetadata: { consumer_agent_id: 'metadata-owner' },
      eligibleDeliveryAgents: ['metadata-owner', 'codex-cto'],
      agents: {
        'metadata-owner': mockAgent('metadata-owner'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const route = await resolveOutboundProjectionRoute(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })
    expect(route.consumerAgentId).toBe('metadata-owner')
    expect(route.source).toBe('channel_adapter_metadata')
  })

  test('single recipient with connector-scoped write evidence becomes direct delivery owner', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['codex-cto'],
      agents: {
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const route = await resolveOutboundProjectionRoute(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })
    expect(route.channelExternalId).toBe('discord-ch')
    expect(route.consumerAgentId).toBe('codex-cto')
    expect(route.source).toBe('recipient_token_evidence')
  })

  test('single recipient with active write binding becomes direct delivery owner', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      bindingDeliveryAgents: ['codex-cto'],
      agents: {
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const route = await resolveOutboundProjectionRoute(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })
    expect(route.consumerAgentId).toBe('codex-cto')
    expect(route.source).toBe('recipient_token_evidence')
  })

  test('thread target requires provider access for the thread external id, not the parent channel', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      channelExternalId: 'discord-parent',
      threadExternalId: 'discord-thread',
      eligibleDeliveryAgents: ['agent-com-dev', 'codex-cto'],
      providerAccessByExternalId: {
        'discord-parent': ['codex-cto'],
        'discord-thread': ['agent-com-dev'],
      },
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const route = await resolveOutboundProjectionRoute(db, {
      channelId: 'ch1',
      threadId: 'thread1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })
    expect(route.channelExternalId).toBe('discord-thread')
    expect(route.consumerAgentId).toBe('agent-com-dev')
    expect(route.source).toBe('channel_policy_adapter_owner')
  })

  test('multiple recipients do not use recipient-facing default projection', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
      },
    })
    const route = await resolveOutboundProjectionRoute(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto', 'ceo'],
    })
    expect(route.consumerAgentId).toBe('agent-com-dev')
    expect(route.source).toBe('channel_policy_adapter_owner')
  })

  test('channel primary remains a compatibility fallback', async () => {
    setRoutingConfig({ ch1: { primary: 'agent-com-dev' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      agents: { 'agent-com-dev': mockAgent('agent-com-dev') },
    })
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.consumerAgentId).toBe('agent-com-dev')
    expect(route.source).toBe('channel_policy_primary')
  })

  test('production agent-com channel projects logical codex-cto through the codex CTO token owner', async () => {
    const cfg = await import('../../config/bot-routing.json')
    setRoutingConfig(cfg.default.channels)
    const db = mockProjectionDb({
      channelExternalId: '1487368919613444156',
      eligibleDeliveryAgents: ['codex-cto'],
      agents: { 'codex-cto': mockAgent('codex-cto') },
    })

    const route = await resolveOutboundProjectionRoute(db, {
      channelId: '1487368919613444156',
      senderAgentId: 'codex-cto',
    })

    expect(route.consumerAgentId).toBe('codex-cto')
    expect(route.source).toBe('channel_policy_native_role_owner')
  })
})

describe('ADR-060 outbound projection identity decision', () => {
  test('recipient-facing projection without delivery evidence does not change the delivery consumer', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })

    expect(decision.channelExternalId).toBe('discord-ch')
    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.consumerSource).toBe('channel_policy_adapter_owner')
    expect(decision.projectionIdentityId).toBe('codex-cto')
    expect(decision.intendedProjectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('recipient_default_projection')
    expect(decision.projectionFallbackReason).toBeNull()
  })

  test('single recipient with connector-scoped delivery evidence becomes the delivery consumer', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev', 'codex-cto'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })

    expect(decision.channelExternalId).toBe('discord-ch')
    expect(decision.consumerAgentId).toBe('codex-cto')
    expect(decision.consumerSource).toBe('recipient_token_evidence')
    expect(decision.projectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('recipient_default_projection')
    expect(decision.projectionFallbackReason).toBeNull()
  })

  test('thread-targeted decision validates delivery ownership against the thread external id', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      channelExternalId: 'discord-parent',
      threadExternalId: 'discord-thread',
      eligibleDeliveryAgents: ['agent-com-dev', 'codex-cto'],
      providerAccessByExternalId: {
        'discord-parent': ['codex-cto'],
        'discord-thread': ['agent-com-dev'],
      },
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      threadId: 'thread1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })

    expect(decision.channelExternalId).toBe('discord-thread')
    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.consumerSource).toBe('channel_policy_adapter_owner')
    expect(decision.projectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('recipient_default_projection')
  })

  test('resolver-none delivery decisions produce an explicit no-consumer enqueue skip', async () => {
    const cases: Array<[string, Parameters<typeof mockProjectionDb>[0]]> = [
      ['no connector evidence', {}],
      ['read-only provider access', { readOnlyDeliveryAgents: ['codex-cto'] }],
      ['mismatched credential and access connectors', { mismatchedDeliveryAgents: ['codex-cto'] }],
      ['multiple eligible connectors', { ambiguousDeliveryAgents: ['codex-cto'] }],
    ]

    for (const [name, dbOptions] of cases) {
      setRoutingConfig({ ch1: {} })
      const db = mockProjectionDb({
        ...dbOptions,
        agents: {
          'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
        },
      })
      const decision = await resolveOutboundProjectionDecision(db, {
        channelId: 'ch1',
        senderAgentId: 'codex-aun',
        recipientAgentIds: ['codex-cto'],
      })

      expect(decision.channelExternalId, name).toBe('discord-ch')
      expect(decision.consumerAgentId, name).toBeNull()
      expect(decision.consumerSource, name).toBe('none')
      expect(outboundProjectionSkipReason(decision), name).toBe(OUTBOUND_SKIP_NO_DELIVERY_CONSUMER)
    }
  })

  test('recipient delivery evidence fails closed when credential and access are not on the same connector', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      mismatchedDeliveryAgents: ['codex-cto'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })

    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.consumerSource).toBe('channel_policy_adapter_owner')
    expect(decision.projectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('recipient_default_projection')
  })

  test('recipient delivery evidence fails closed when provider access is read-only', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      readOnlyDeliveryAgents: ['codex-cto'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })

    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.consumerSource).toBe('channel_policy_adapter_owner')
    expect(decision.projectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('recipient_default_projection')
  })

  test('recipient delivery evidence fails closed when multiple connectors are eligible', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      ambiguousDeliveryAgents: ['codex-cto'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-aun',
      recipientAgentIds: ['codex-cto'],
    })

    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.consumerSource).toBe('channel_policy_adapter_owner')
    expect(decision.projectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('recipient_default_projection')
  })

  test('native projection mapping controls projection identity only', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
        nativeProjectionIdentities: { 'codex-cto': 'codex-cto' },
      },
    })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-cto',
    })

    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.consumerSource).toBe('channel_policy_adapter_owner')
    expect(decision.projectionIdentityId).toBe('codex-cto')
    expect(decision.intendedProjectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('sender_native_projection')
    expect(decision.projectionFallbackReason).toBeNull()
  })

  test('legacy native-role owner is treated as projection intent, not consumer override', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
        nativeRoleOutboundOwners: { 'codex-cto': 'codex-cto' },
      },
    })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id', status: 'offline' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-cto',
    })

    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.consumerSource).toBe('channel_policy_adapter_owner')
    expect(decision.projectionIdentityId).toBe('agent-com-dev')
    expect(decision.intendedProjectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('fallback_adapter_owner')
    expect(decision.projectionFallbackReason).toBe('native_projection_unhealthy')
  })

  test('unregistered native projection falls back to adapter owner with evidence', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
        nativeProjectionIdentities: { 'codex-cto': 'codex-cto' },
      },
    })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-cto',
    })

    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.projectionIdentityId).toBe('agent-com-dev')
    expect(decision.intendedProjectionIdentityId).toBe('codex-cto')
    expect(decision.projectionSource).toBe('fallback_adapter_owner')
    expect(decision.projectionFallbackReason).toBe('native_projection_unregistered')
  })

  test('healthy sender-native projection can win when recipient projection is unhealthy', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
        nativeProjectionIdentities: { 'codex-cto': 'codex-cto-native' },
      },
    })
    const db = mockProjectionDb({
      eligibleDeliveryAgents: ['agent-com-dev'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-aun': mockAgent('codex-aun', { discordId: 'aun-discord-id', status: 'offline' }),
        'codex-cto-native': mockAgent('codex-cto-native', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-cto',
      recipientAgentIds: ['codex-aun'],
    })

    expect(decision.consumerAgentId).toBe('agent-com-dev')
    expect(decision.projectionIdentityId).toBe('codex-cto-native')
    expect(decision.intendedProjectionIdentityId).toBe('codex-cto-native')
    expect(decision.projectionSource).toBe('sender_native_projection')
    expect(decision.projectionFallbackReason).toBeNull()
  })
})
