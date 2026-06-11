import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolveOutboundProjectionDecision, resolveOutboundProjectionRoute } from '../../core/outbound-projection'
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
  agents?: Record<string, any>
  senderTokenAgents?: string[]
} = {}) {
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
            metadata: options.channelAdapterMetadata ?? null,
          }],
        }
      }
      if (sql.includes('channel_connector_bindings')) {
        const agentId = typeof params?.[2] === 'string' ? params[2] : ''
        return { rows: options.senderTokenAgents?.includes(agentId) ? [{ agent_id: agentId }] : [] }
      }
      if (sql.includes('provider_channel_access')) {
        const agentId = typeof params?.[2] === 'string' ? params[2] : ''
        return { rows: options.senderTokenAgents?.includes(agentId) ? [{ agent_id: agentId }] : [] }
      }
      if (sql.includes('connector_instances')) {
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
    const db = mockProjectionDb({ agents: { 'adapter-agent': mockAgent('adapter-agent') } })
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.channelExternalId).toBe('discord-ch')
    expect(route.consumerAgentId).toBe('adapter-agent')
    expect(route.source).toBe('channel_policy_adapter_owner')
  })

  test('bot-routing adapterOwner without token evidence is not a Discord delivery consumer', async () => {
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

  test('sender token evidence overrides channel adapterOwner only for matching sender', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
      },
    })
    const db = mockProjectionDb({
      senderTokenAgents: ['codex-cto'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto'),
      },
    })
    const codexCto = await resolveOutboundProjectionRoute(db, { channelId: 'ch1', senderAgentId: 'codex-cto' })
    expect(codexCto.consumerAgentId).toBe('codex-cto')
    expect(codexCto.source).toBe('sender_token_evidence')

    const otherAgent = await resolveOutboundProjectionRoute(db, { channelId: 'ch1', senderAgentId: 'codex-aun' })
    expect(otherAgent.consumerAgentId).toBe('agent-com-dev')
    expect(otherAgent.source).toBe('channel_policy_adapter_owner')
  })

  test('explicit adapter metadata still wins over sender token evidence', async () => {
    setRoutingConfig({
      ch1: {
        adapterOwner: 'agent-com-dev',
      },
    })
    const db = mockProjectionDb({
      channelAdapterMetadata: { consumer_agent_id: 'metadata-owner' },
      senderTokenAgents: ['codex-cto'],
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

  test('single recipient with Discord identity gets recipient-facing projection', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
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
    expect(route.source).toBe('recipient_default_projection')
  })

  test('multiple recipients do not use recipient-facing default projection', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
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
    const db = mockProjectionDb({ agents: { 'agent-com-dev': mockAgent('agent-com-dev') } })
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.consumerAgentId).toBe('agent-com-dev')
    expect(route.source).toBe('channel_policy_primary')
  })

  test('production agent-com channel projects logical codex-cto through the codex CTO token owner', async () => {
    const cfg = await import('../../config/bot-routing.json')
    setRoutingConfig(cfg.default.channels)
    const db = mockProjectionDb({
      channelExternalId: '1487368919613444156',
      senderTokenAgents: ['codex-cto'],
      agents: { 'codex-cto': mockAgent('codex-cto') },
    })

    const route = await resolveOutboundProjectionRoute(db, {
      channelId: '1487368919613444156',
      senderAgentId: 'codex-cto',
    })

    expect(route.consumerAgentId).toBe('codex-cto')
    expect(route.source).toBe('sender_token_evidence')
  })
})

describe('ADR-060 outbound projection identity decision', () => {
  test('recipient-facing projection no longer changes the delivery consumer', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = mockProjectionDb({
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

  test('native projection mapping controls projection identity only', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
        nativeProjectionIdentities: { 'codex-cto': 'codex-cto' },
      },
    })
    const db = mockProjectionDb({
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

  test('sender token evidence selects the delivery consumer and sender projection identity', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
      },
    })
    const db = mockProjectionDb({
      senderTokenAgents: ['codex-cto'],
      agents: {
        'agent-com-dev': mockAgent('agent-com-dev'),
        'codex-cto': mockAgent('codex-cto', { discordId: 'cto-discord-id' }),
      },
    })
    const decision = await resolveOutboundProjectionDecision(db, {
      channelId: 'ch1',
      senderAgentId: 'codex-cto',
    })

    expect(decision.consumerAgentId).toBe('codex-cto')
    expect(decision.consumerSource).toBe('sender_token_evidence')
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
