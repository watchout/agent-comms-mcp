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

  test('missing source provenance is unclassified even with an explicit class', () => {
    expect(authoritativeProfileClassification({
      agent_id: 'dev-001',
      metadata: { profile_class: 'production' },
    })).toBeNull()
  })

  test('mutable source refs or malformed digests fail closed as unclassified', () => {
    expect(authoritativeProfileClassification({
      agent_id: 'dev-001',
      metadata: {
        profile_class: 'production',
        profile_class_source_ref: 'mutable-ref',
        profile_class_source_sha256: 'wrong',
        profile_class_plan_sha256: 'wrong',
      },
    })).toBeNull()
  })

  test('noncanonical digests and malformed AUN message refs remain unclassified', () => {
    const base = {
      profile_class: 'production',
      profile_class_source_ref: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-123',
      profile_class_source_sha256: 'a'.repeat(64),
      profile_class_plan_sha256: 'b'.repeat(64),
    }
    for (const metadata of [
      { ...base, profile_class_source_sha256: 'A'.repeat(64) },
      { ...base, profile_class_plan_sha256: 'B'.repeat(64) },
      { ...base, profile_class_source_ref: 'aun-message:------------------------------------' },
      { ...base, profile_class_source_ref: ` ${base.profile_class_source_ref}` },
    ]) {
      expect(authoritativeProfileClassification({ agent_id: 'dev-001', metadata })).toBeNull()
    }
  })

  test('a canonical AUN message UUID is an immutable classification source', () => {
    expect(authoritativeProfileClassification({
      agent_id: 'dev-001',
      metadata: {
        profile_class: 'production',
        profile_class_source_ref: 'aun-message:7b0a2ead-050b-455f-b666-1e9d8ed3b36d',
        profile_class_source_sha256: 'a'.repeat(64),
        profile_class_plan_sha256: 'b'.repeat(64),
      },
    })?.source_ref).toBe('aun-message:7b0a2ead-050b-455f-b666-1e9d8ed3b36d')
  })
})
