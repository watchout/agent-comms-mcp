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
    const db = {
      query: async (sql: string) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: { consumer_agent_id: 'agent-com-dev' } }] }
        }
        return { rows: [] }
      },
    }
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.channelExternalId).toBe('discord-ch')
    expect(route.consumerAgentId).toBe('agent-com-dev')
    expect(route.source).toBe('channel_adapter_metadata')
  })

  test('bot-routing adapterOwner is the config fallback', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'adapter-agent' } })
    const db = {
      query: async () => ({ rows: [{ external_id: 'discord-ch', metadata: null }] }),
    }
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.channelExternalId).toBe('discord-ch')
    expect(route.consumerAgentId).toBe('adapter-agent')
    expect(route.source).toBe('channel_policy_adapter_owner')
  })

  test('native-role owner overrides channel adapterOwner only for matching sender', async () => {
    setRoutingConfig({
      ch1: {
        primary: 'primary-agent',
        adapterOwner: 'agent-com-dev',
        nativeRoleOutboundOwners: { 'codex-cto': 'codex-cto' },
      },
    })
    const db = {
      query: async () => ({ rows: [{ external_id: 'discord-ch', metadata: null }] }),
    }
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
    const db = {
      query: async () => ({ rows: [{ external_id: 'discord-ch', metadata: { consumer_agent_id: 'metadata-owner' } }] }),
    }
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1', senderAgentId: 'codex-cto' })
    expect(route.consumerAgentId).toBe('metadata-owner')
    expect(route.source).toBe('channel_adapter_metadata')
  })

  test('explicit adapter metadata still wins over recipient-facing projection', async () => {
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: { consumer_agent_id: 'metadata-owner' } }] }
        }
        if (sql.includes('agents') && params?.[0] === 'codex-cto') {
          return { rows: [{ agent_id: 'codex-cto', metadata: { discord_id: 'cto-discord-id' } }] }
        }
        return { rows: [] }
      },
    }
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
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: null }] }
        }
        if (sql.includes('agents') && params?.[0] === 'codex-cto') {
          return { rows: [{ agent_id: 'codex-cto', metadata: { discord_id: 'cto-discord-id' } }] }
        }
        return { rows: [] }
      },
    }
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
    const db = {
      query: async (sql: string) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: null }] }
        }
        if (sql.includes('agents')) {
          throw new Error('agents lookup should not run for multiple recipients')
        }
        return { rows: [] }
      },
    }
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
    const db = {
      query: async () => ({ rows: [{ external_id: 'discord-ch', metadata: '{}' }] }),
    }
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.consumerAgentId).toBe('agent-com-dev')
    expect(route.source).toBe('channel_policy_primary')
  })

  test('production agent-com channel projects logical codex-cto through the codex CTO token owner', async () => {
    const cfg = await import('../../config/bot-routing.json')
    setRoutingConfig(cfg.default.channels)
    const db = {
      query: async () => ({ rows: [{ external_id: '1487368919613444156', metadata: null }] }),
    }

    const route = await resolveOutboundProjectionRoute(db, {
      channelId: '1487368919613444156',
      senderAgentId: 'codex-cto',
    })

    expect(route.consumerAgentId).toBe('codex-cto')
    expect(route.source).toBe('channel_policy_native_role_owner')
  })
})

describe('ADR-060 outbound projection identity decision', () => {
  test('recipient-facing projection no longer changes the delivery consumer', async () => {
    setRoutingConfig({ ch1: { primary: 'primary-agent', adapterOwner: 'agent-com-dev' } })
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: null }] }
        }
        if (sql.includes('agents') && params?.[0] === 'codex-cto') {
          return { rows: [{ agent_id: 'codex-cto', status: 'idle', metadata: { discord_id: 'cto-discord-id' } }] }
        }
        return { rows: [] }
      },
    }
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
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: null }] }
        }
        if (sql.includes('agents') && params?.[0] === 'codex-cto') {
          return { rows: [{ agent_id: 'codex-cto', status: 'idle', metadata: { discord_id: 'cto-discord-id' } }] }
        }
        return { rows: [] }
      },
    }
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
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: null }] }
        }
        if (sql.includes('agents') && params?.[0] === 'codex-cto') {
          return { rows: [{ agent_id: 'codex-cto', status: 'offline', metadata: { discord_id: 'cto-discord-id' } }] }
        }
        return { rows: [] }
      },
    }
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
    const db = {
      query: async (sql: string) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: null }] }
        }
        if (sql.includes('agents')) {
          return { rows: [] }
        }
        return { rows: [] }
      },
    }
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
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('channel_adapters')) {
          return { rows: [{ external_id: 'discord-ch', metadata: null }] }
        }
        if (sql.includes('agents') && params?.[0] === 'codex-aun') {
          return { rows: [{ agent_id: 'codex-aun', status: 'offline', metadata: { discord_id: 'aun-discord-id' } }] }
        }
        if (sql.includes('agents') && params?.[0] === 'codex-cto-native') {
          return { rows: [{ agent_id: 'codex-cto-native', status: 'idle', metadata: { discord_id: 'cto-discord-id' } }] }
        }
        return { rows: [] }
      },
    }
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
