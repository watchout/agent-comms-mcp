import { describe, expect, test } from 'bun:test'
import { decideQueueRouting } from '../core/routing-decision'

describe('decideQueueRouting - deterministic routing evidence', () => {
  test('actionable message type wakes without LLM classification', () => {
    const evidence = decideQueueRouting({
      target_agent_id: 'codex-aun',
      target_runtime: 'codex-runner',
      message_type: 'instruction',
      source: 'agent-comms',
      author_id: 'codex-cto',
    })

    expect(evidence).toMatchObject({
      routing_decision: 'wake_agent',
      route_reason: 'actionable_message_type',
      message_type: 'instruction',
      target_agent_id: 'codex-aun',
      llm_classification_used: false,
      direct_mention_evidence: {
        matched: false,
        source: null,
        matched_value: null,
      },
    })
  })

  test('Discord direct mention chat wakes through explicit mention evidence without changing message_type', () => {
    const evidence = decideQueueRouting({
      target_agent_id: 'codex-aun',
      target_runtime: 'codex-runner',
      target_discord_id: '999001',
      message_type: 'chat',
      source: 'discord',
      author_id: 'user-123',
      mentions: ['999001'],
      content: '<@999001> please handle this',
    })

    expect(evidence).toMatchObject({
      routing_decision: 'wake_agent',
      route_reason: 'direct_mention',
      message_type: 'chat',
      has_target_discord_binding: true,
      direct_mention_evidence: {
        matched: true,
        source: 'metadata',
        matched_value: '999001',
      },
      author_identity: {
        author_id: 'user-123',
        self_authored: false,
      },
      llm_classification_used: false,
    })
  })

  test('Discord chat cannot wake from agent-id mention when Discord binding is missing', () => {
    const evidence = decideQueueRouting({
      target_agent_id: 'codex-aun',
      target_runtime: 'codex-runner',
      message_type: 'chat',
      source: 'discord',
      author_id: 'user-123',
      mentions: ['codex-aun'],
      content: 'metadata-only agent mention',
    })

    expect(evidence).toMatchObject({
      routing_decision: 'deliver_only',
      route_reason: 'missing_mention_binding',
      message_type: 'chat',
      has_target_discord_binding: false,
      direct_mention_evidence: {
        matched: false,
        source: null,
        matched_value: null,
      },
      llm_classification_used: false,
    })
  })

  test('self-authored mention is blocked before direct mention wake', () => {
    const evidence = decideQueueRouting({
      target_agent_id: 'codex-aun',
      target_runtime: 'codex-runner',
      target_discord_id: '999001',
      message_type: 'chat',
      source: 'discord',
      author_id: '999001',
      mentions: ['999001'],
      content: '<@999001> echo',
    })

    expect(evidence).toMatchObject({
      routing_decision: 'block',
      route_reason: 'author_is_self',
      direct_mention_evidence: {
        matched: true,
        source: 'metadata',
        matched_value: '999001',
      },
      author_identity: {
        author_id: '999001',
        self_authored: true,
      },
      llm_classification_used: false,
    })
  })

  test('notice, projection, and report remain non-actionable even when mentioned', () => {
    for (const messageType of ['notice', 'projection', 'report']) {
      const evidence = decideQueueRouting({
        target_agent_id: 'codex-aun',
        target_runtime: 'codex-runner',
        target_discord_id: '999001',
        message_type: messageType,
        source: 'discord',
        author_id: 'user-123',
        mentions: ['999001'],
        content: `<@999001> ${messageType}`,
      })

      expect(evidence).toMatchObject({
        routing_decision: 'deliver_only',
        route_reason: 'non_actionable_type',
        message_type: messageType,
        direct_mention_evidence: {
          matched: true,
          source: 'metadata',
          matched_value: '999001',
        },
        llm_classification_used: false,
      })
    }
  })

  test('disabled target profile blocks before message type wake', () => {
    const evidence = decideQueueRouting({
      target_agent_id: 'codex-aun',
      target_runtime: 'codex-runner',
      target_profile_enabled: false,
      message_type: 'instruction',
      source: 'agent-comms',
      author_id: 'codex-cto',
    })

    expect(evidence).toMatchObject({
      routing_decision: 'block',
      route_reason: 'disabled_agent',
      target_profile_enabled: false,
      llm_classification_used: false,
    })
  })

  test('direct mention chat blocks when target runtime is unsupported', () => {
    const evidence = decideQueueRouting({
      target_agent_id: 'codex-aun',
      target_runtime: 'SIG',
      target_discord_id: '999001',
      message_type: 'chat',
      source: 'discord',
      author_id: 'user-123',
      mentions: ['999001'],
      content: '<@999001> unsupported runtime',
    })

    expect(evidence).toMatchObject({
      routing_decision: 'block',
      route_reason: 'unsupported_runtime',
      target_runtime: 'SIG',
      direct_mention_evidence: {
        matched: true,
        source: 'metadata',
        matched_value: '999001',
      },
      llm_classification_used: false,
    })
  })
})
