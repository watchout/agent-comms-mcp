import { describe, expect, test } from 'bun:test'
import {
  PROVIDER_EFFECTS_ZERO_ALLOW_EMPTY_ENV,
  PROVIDER_EFFECTS_ZERO_PREFLIGHT_ENV,
  parseBunServerProcessInventory,
  runProviderEffectsZeroActivationPreflight,
  validateProviderEffectsZeroActivationConfig,
} from '../core/provider-effects-activation-preflight'
import { PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV } from '../core/provider-effects-consumer-attestation'
import {
  PROVIDER_EFFECTS_CONTROL_FILE_ENV,
  PROVIDER_EFFECTS_CONTROL_SCHEMA,
  parseProviderEffectsControl,
} from '../core/provider-effects-control'

const NOW = Date.parse('2026-08-15T03:00:00.000Z')
const ROOT = '10000000-0000-4000-8000-000000000001'
const CREATED_AFTER = '2026-08-15T02:59:00.000Z'
const FENCE_EXPIRES = '2026-08-16T00:00:00.000Z'
const CONTROL_PATH = '/tmp/provider-effects-control.json'
const ATTESTATION_DIR = '/tmp/provider-effects-consumers'

function decision(epoch = 'a1-provider-zero') {
  return parseProviderEffectsControl(JSON.stringify({
    schema_version: PROVIDER_EFFECTS_CONTROL_SCHEMA,
    epoch,
    provider_effects: 'forbidden',
    expires_at: '2026-08-17T00:00:00.000Z',
  }), CONTROL_PATH, NOW)
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    [PROVIDER_EFFECTS_ZERO_PREFLIGHT_ENV]: '1',
    [PROVIDER_EFFECTS_CONTROL_FILE_ENV]: CONTROL_PATH,
    [PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]: ATTESTATION_DIR,
    STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
    STATE_DAEMON_QUEUE_WORK_FLEET_MODE: '0',
    STATE_DAEMON_AGENT_ALLOWLIST: 'aun',
    STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS: '161800',
    STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: ROOT,
    STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER: CREATED_AFTER,
    OUTBOUND_QUEUE_EXACT_FENCE: JSON.stringify({
      schema_version: 'agent-comms/outbound-exact-correlation-fence/v2',
      root_message_ids: [ROOT],
      created_after: CREATED_AFTER,
      expires_at: FENCE_EXPIRES,
    }),
  }
}

function ps(...pids: number[]): string {
  return [
    ...pids.map((pid, index) => index % 2 === 0
      ? `${pid} /Users/yuji/.bun /Users/yuji/.bun/bin/bun run server.ts`
      : `${pid} bun /Users/yuji/.bun/bin/bun server.ts`),
    '303 /opt/homebrew/bin/codex /opt/homebrew/bin/codex audit server.ts in prompt',
    '404 /bin/bash /bin/bash /tmp/run-aun-mcp.sh server.ts',
    '505 node node /opt/homebrew/bin/codex implement server.ts',
  ].join('\n')
}

function record(pid: number, epochDecision = decision()) {
  return {
    schema_version: 'agent-comms/provider-effects-consumer-attestation/v1' as const,
    agent_id: `agent-${pid}`,
    pid,
    observed_at: new Date(NOW).toISOString(),
    provider_effects_mode: 'forbidden' as const,
    provider_control_reason: 'control_forbidden' as const,
    provider_control_epoch: epochDecision.epoch,
    provider_control_expires_at: epochDecision.expiresAt,
    provider_control_source_path: epochDecision.sourcePath!,
    provider_control_content_sha256: epochDecision.contentSha256,
    provider_control_attestation: epochDecision.attestation,
  }
}

describe('provider-effects zero activation static contract', () => {
  test('unrequested configurations preserve legacy behavior', () => {
    expect(validateProviderEffectsZeroActivationConfig({}, { nowMs: NOW })).toEqual({
      requested: false,
      ok: true,
      issues: [],
      decision: null,
      rootMessageId: null,
      createdAfter: null,
    })
  })

  test('accepts exact forbidden/AUN-only/fleet-off/queue+outbound-v2 identity', () => {
    const result = validateProviderEffectsZeroActivationConfig(validEnv(), {
      nowMs: NOW,
      readControl: () => decision(),
    })
    expect(result.ok).toBe(true)
    expect(result.rootMessageId).toBe(ROOT)
    expect(result.createdAfter).toBe(CREATED_AFTER)
  })

  test('fails closed on provider, fleet, target, queue, message, time, and outbound mismatches', () => {
    const fixtures: Array<[string, NodeJS.ProcessEnv, string]> = [
      ['invalid provider', validEnv(), 'provider_effects_zero_requires_valid_forbidden_control'],
      ['fleet', { ...validEnv(), STATE_DAEMON_QUEUE_WORK_FLEET_MODE: '1' }, 'provider_effects_zero_requires_fleet_off'],
      ['malformed fleet', { ...validEnv(), STATE_DAEMON_QUEUE_WORK_FLEET_MODE: 'false' }, 'provider_effects_zero_requires_fleet_off'],
      ['wrong target', { ...validEnv(), STATE_DAEMON_AGENT_ALLOWLIST: 'adf-lead' }, 'provider_effects_zero_requires_aun_only'],
      ['multiple queues', { ...validEnv(), STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS: '1,2' }, 'provider_effects_zero_requires_single_queue'],
      ['bad message', { ...validEnv(), STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'not-uuid' }, 'provider_effects_zero_requires_single_message'],
      ['bad time', { ...validEnv(), STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER: '2026-08-15' }, 'provider_effects_zero_created_after_invalid'],
      ['wrong root', {
        ...validEnv(),
        OUTBOUND_QUEUE_EXACT_FENCE: JSON.stringify({
          schema_version: 'agent-comms/outbound-exact-correlation-fence/v2',
          root_message_ids: ['20000000-0000-4000-8000-000000000002'],
          created_after: CREATED_AFTER,
          expires_at: FENCE_EXPIRES,
        }),
      }, 'provider_effects_zero_outbound_root_mismatch'],
    ]
    for (const [name, env, code] of fixtures) {
      const result = validateProviderEffectsZeroActivationConfig(env, {
        nowMs: NOW,
        readControl: () => name === 'invalid provider'
          ? parseProviderEffectsControl('{', CONTROL_PATH, NOW)
          : decision(),
      })
      expect(result.ok, name).toBe(false)
      expect(result.issues.map(issue => issue.code), name).toContain(code)
    }
  })
})

describe('provider consumer process inventory', () => {
  test('matches only Bun server.ts execution tokens, not prompts or shell arguments', () => {
    const inventory = ps(101, 202) + '\n' + [
      '606 bun /Users/yuji/.bun/bin/bun run --cwd /srv/agent-comms server.ts',
      '707 bun /Users/yuji/.bun/bin/bun run --watch server.ts',
      '808 bun /Users/yuji/.bun/bin/bun -e server.ts',
      '809 bun /Users/yuji/.bun/bin/bun --preload server.ts app.ts',
      '810 bun /Users/yuji/.bun/bin/bun run -F workspace server.ts',
      '811 bun /Users/yuji/.bun/bin/bun --preload setup.ts server.ts',
    ].join('\n')
    expect(parseBunServerProcessInventory(inventory)).toEqual([
      { pid: 101, command: '/Users/yuji/.bun/bin/bun run server.ts' },
      { pid: 202, command: '/Users/yuji/.bun/bin/bun server.ts' },
      { pid: 606, command: '/Users/yuji/.bun/bin/bun run --cwd /srv/agent-comms server.ts' },
      { pid: 707, command: '/Users/yuji/.bun/bin/bun run --watch server.ts' },
      { pid: 810, command: '/Users/yuji/.bun/bin/bun run -F workspace server.ts' },
      { pid: 811, command: '/Users/yuji/.bun/bin/bun --preload setup.ts server.ts' },
    ])
  })
})

describe('provider-effects zero host-wide attestation gate', () => {
  test('passes two stable samples only when every PID attests the exact fresh forbidden epoch', async () => {
    const expected = decision()
    let samples = 0
    const result = await runProviderEffectsZeroActivationPreflight(validEnv(), {
      now: () => NOW,
      readControl: () => expected,
      sampleProcesses: () => {
        samples++
        return ps(101, 202)
      },
      readAttestation: (path, options) => {
        const pid = Number(path.match(/consumer-(\d+)\.json$/)?.[1])
        const value = record(pid, expected)
        expect(options.expectedPid).toBe(pid)
        expect(options.expectedControlAttestation).toBe(expected.attestation)
        return { ok: true, path, record: value }
      },
    })
    expect(samples).toBe(2)
    expect(result.ok).toBe(true)
    expect(result.consumerPids).toEqual([101, 202])
    expect(result.attestations).toHaveLength(2)
  })

  test('fails closed for missing/stale attestation and an unstable PID set', async () => {
    let sample = 0
    const result = await runProviderEffectsZeroActivationPreflight(validEnv(), {
      now: () => NOW,
      readControl: () => decision(),
      sampleProcesses: () => ++sample === 1 ? ps(101) : ps(101, 202),
      readAttestation: (path) => ({ ok: false, path, reason: 'stale_observation' }),
    })
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'provider_effects_consumer_inventory_unstable',
      'provider_effects_consumer_attestation_invalid',
    ]))
  })

  test('rejects an attestation whose reported expiry differs from the exact control identity', async () => {
    const expected = decision()
    const result = await runProviderEffectsZeroActivationPreflight(validEnv(), {
      now: () => NOW,
      readControl: () => expected,
      sampleProcesses: () => ps(101),
      readAttestation: (path) => ({
        ok: true,
        path,
        record: {
          ...record(101, expected),
          provider_control_expires_at: '2026-08-16T23:59:59.000Z',
        },
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain(
      'provider_effects_consumer_attestation_identity_mismatch',
    )
  })

  test('empty inventory needs an explicit assertion and still uses two exact samples', async () => {
    const base = {
      now: () => NOW,
      readControl: () => decision(),
      sampleProcesses: () => ps(),
    }
    expect((await runProviderEffectsZeroActivationPreflight(validEnv(), base)).issues.map(issue => issue.code))
      .toContain('provider_effects_consumer_inventory_empty')
    const allowed = await runProviderEffectsZeroActivationPreflight({
      ...validEnv(),
      [PROVIDER_EFFECTS_ZERO_ALLOW_EMPTY_ENV]: '1',
    }, base)
    expect(allowed.ok).toBe(true)
    expect(allowed.consumerPids).toEqual([])
  })
})
