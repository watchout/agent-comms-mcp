import { describe, expect, test } from 'bun:test'
import {
  classifyLegacyOutboundCandidate,
  summarizeLegacyOutboundClassifications,
  type LegacyOutboundCandidate,
} from '../../core/legacy-outbound-cleanup'

const baseRow: LegacyOutboundCandidate = {
  id: 11712,
  message_id: '29186a82-3620-4e32-bb79-b8dd7a5186e0',
  agent_id: 'codex-cto',
  consumer_agent_id: null,
  channel_external_id: '1487368919613444156',
  status: 'pending',
  attempts: 0,
  max_attempts: 5,
  last_error: null,
  created_at: '2026-05-16 07:50:37.452905+09',
  content: 'ACK: Discord ingress E2E script-driven smoke PASS received and recorded in #409.',
}

describe('#412 legacy outbound cleanup classifier', () => {
  test('known ACK/status rows are obsolete by default', () => {
    const c = classifyLegacyOutboundCandidate(baseRow, {
      adapterOwner: 'agent-com-dev',
      channelExternalId: '1487368919613444156',
    })
    expect(c.action).toBe('mark_obsolete')
    expect(c.reason).toStartWith('LEGACY_PRE_411_UNPROJECTED_OBSOLETE')
  })

  test('backfill is explicit-message-id only', () => {
    const c = classifyLegacyOutboundCandidate({
      ...baseRow,
      message_id: 'display-worthy',
      content: 'Please show this operator-visible update in Discord.',
    }, {
      adapterOwner: 'agent-com-dev',
      channelExternalId: '1487368919613444156',
      backfillMessageIds: new Set(['display-worthy']),
    })
    expect(c.action).toBe('backfill_consumer')
    expect(c.consumer_agent_id).toBe('agent-com-dev')
  })

  test('unknown rows fail closed to manual review', () => {
    const c = classifyLegacyOutboundCandidate({
      ...baseRow,
      message_id: 'unknown',
      content: 'Unclassified historical content.',
    }, {
      adapterOwner: 'agent-com-dev',
      channelExternalId: '1487368919613444156',
    })
    expect(c.action).toBe('manual_review')
    expect(c.reason).toBe('requires_operator_classification')
  })

  test('out-of-scope rows are not mutated by classifier', () => {
    const c = classifyLegacyOutboundCandidate({
      ...baseRow,
      status: 'sent',
      content: 'ACK: already terminal',
    }, {
      adapterOwner: 'agent-com-dev',
      channelExternalId: '1487368919613444156',
    })
    expect(c.action).toBe('manual_review')
    expect(c.reason).toBe('not_bounded_legacy_candidate')
  })

  test('summary counts proposed actions', () => {
    expect(summarizeLegacyOutboundClassifications([
      { action: 'mark_obsolete', reason: 'x', consumer_agent_id: null },
      { action: 'manual_review', reason: 'y', consumer_agent_id: null },
      { action: 'backfill_consumer', reason: 'z', consumer_agent_id: 'agent-com-dev' },
    ])).toEqual({
      mark_obsolete: 1,
      manual_review: 1,
      backfill_consumer: 1,
    })
  })
})
