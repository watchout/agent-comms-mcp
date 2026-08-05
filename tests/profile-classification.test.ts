import { describe, expect, test } from 'bun:test'
import {
  authoritativeProfileClassification,
  isTestProfile,
} from '../core/profile-classification'

describe('authoritative profile classification', () => {
  test('an agent id named test is UNCLASSIFIED without a source-bound class', () => {
    const row = { agent_id: 'test-fixture-looking-seat', agent_type: 'test', metadata: {} }
    expect(isTestProfile(row)).toBe(true)
    expect(authoritativeProfileClassification(row)).toBeNull()
  })

  test('a production-named fixture is test when the explicit source entry says test', () => {
    expect(authoritativeProfileClassification({
      agent_id: 'billing-production',
      agent_type: 'dev',
      metadata: {
        profile_class: 'test',
        profile_class_source_ref: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-123',
        profile_class_source_sha256: 'a'.repeat(64),
        profile_class_plan_sha256: 'b'.repeat(64),
      },
    })).toEqual({
      profile_class: 'test',
      source_ref: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-123',
      source_sha256: 'a'.repeat(64),
      plan_sha256: 'b'.repeat(64),
    })
  })

  test('malformed optional digests are never surfaced as verified digests', () => {
    expect(authoritativeProfileClassification({
      agent_id: 'dev-001',
      metadata: {
        profile_class: 'production',
        profile_class_source_ref: 'immutable-ref',
        profile_class_source_sha256: 'wrong',
        profile_class_plan_sha256: 'wrong',
      },
    })).toEqual({
      profile_class: 'production',
      source_ref: 'immutable-ref',
      source_sha256: null,
      plan_sha256: null,
    })
  })
})
