import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolveOutboundProjectionRoute } from '../../core/outbound-projection'
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

  test('channel primary remains a compatibility fallback', async () => {
    setRoutingConfig({ ch1: { primary: 'agent-com-dev' } })
    const db = {
      query: async () => ({ rows: [{ external_id: 'discord-ch', metadata: '{}' }] }),
    }
    const route = await resolveOutboundProjectionRoute(db, { channelId: 'ch1' })
    expect(route.consumerAgentId).toBe('agent-com-dev')
    expect(route.source).toBe('channel_policy_primary')
  })
})
