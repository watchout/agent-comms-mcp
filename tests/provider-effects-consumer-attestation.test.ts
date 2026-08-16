import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  consumeOneOutboundRow,
  setDbGetter,
  startOutboundConsumer,
  stopOutboundConsumer,
} from '../adapters/outbound-consumer'
import { discordClients } from '../adapters/discord-client'
import {
  PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV,
  PROVIDER_EFFECTS_CONSUMER_ATTESTATION_SCHEMA,
  parseProviderEffectsConsumerAttestation,
  readProviderEffectsConsumerAttestation,
  refreshProviderEffectsConsumerAttestation,
  removeProviderEffectsConsumerAttestation,
} from '../core/provider-effects-consumer-attestation'
import {
  PROVIDER_EFFECTS_CONTROL_FILE_ENV,
  PROVIDER_EFFECTS_CONTROL_SCHEMA,
  parseProviderEffectsControl,
  readProviderEffectsControl,
} from '../core/provider-effects-control'

const roots: string[] = []
const priorAttestationDir = process.env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]
const priorControlFile = process.env[PROVIDER_EFFECTS_CONTROL_FILE_ENV]

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'provider-effects-consumer-attestation-'))
  roots.push(root)
  return root
}

function control(
  mode: 'allowed' | 'forbidden',
  epoch: string,
  sourcePath = '/tmp/provider-effects-control.json',
) {
  return parseProviderEffectsControl(JSON.stringify({
    schema_version: PROVIDER_EFFECTS_CONTROL_SCHEMA,
    epoch,
    provider_effects: mode,
    expires_at: '2099-01-01T00:00:00.000Z',
  }), sourcePath)
}

function modeBits(path: string): number {
  return statSync(path).mode & 0o777
}

afterEach(() => {
  stopOutboundConsumer()
  discordClients.delete('aun')
  setDbGetter(async () => null, '')
  if (priorAttestationDir === undefined) {
    delete process.env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]
  } else {
    process.env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV] = priorAttestationDir
  }
  if (priorControlFile === undefined) {
    delete process.env[PROVIDER_EFFECTS_CONTROL_FILE_ENV]
  } else {
    process.env[PROVIDER_EFFECTS_CONTROL_FILE_ENV] = priorControlFile
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('provider-effects consumer attestation record', () => {
  test('configured allowed control writes a durable private per-PID record with exact identity', () => {
    const root = temporaryRoot()
    const directory = join(root, 'attestations')
    const nowMs = Date.parse('2026-08-15T01:02:03.000Z')
    const decision = control('allowed', 'epoch-allowed')

    const result = refreshProviderEffectsConsumerAttestation(decision, 'aun', {
      env: { [PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]: directory },
      pid: 41001,
      nowMs,
    })

    expect(result.ok).toBe(true)
    if (!result.ok || !result.required) throw new Error('expected required attestation')
    expect(result.path).toBe(join(directory, 'consumer-41001.json'))
    expect(modeBits(directory)).toBe(0o700)
    expect(modeBits(result.path)).toBe(0o600)
    expect(result.record).toEqual({
      schema_version: PROVIDER_EFFECTS_CONSUMER_ATTESTATION_SCHEMA,
      agent_id: 'aun',
      pid: 41001,
      observed_at: '2026-08-15T01:02:03.000Z',
      provider_effects_mode: 'allowed',
      provider_control_reason: 'control_allowed',
      provider_control_epoch: 'epoch-allowed',
      provider_control_expires_at: '2099-01-01T00:00:00.000Z',
      provider_control_source_path: '/tmp/provider-effects-control.json',
      provider_control_content_sha256: decision.contentSha256,
      provider_control_attestation: decision.attestation,
    })
    expect(readFileSync(result.path, 'utf8')).not.toContain('token')
    expect(readProviderEffectsConsumerAttestation(result.path, {
      nowMs,
      expectedAgentId: 'aun',
      expectedPid: 41001,
      expectedControlAttestation: decision.attestation,
    })).toEqual({ ok: true, path: result.path, record: result.record })
  })

  test('configured control fails closed for missing, relative, and unwritable attestation configuration', () => {
    const decision = control('allowed', 'epoch-config-errors')
    const root = temporaryRoot()
    const notDirectory = join(root, 'not-a-directory')
    writeFileSync(notDirectory, 'occupied', { mode: 0o600 })

    expect(refreshProviderEffectsConsumerAttestation(decision, 'aun', {
      env: {},
      pid: 41002,
    })).toEqual({
      ok: false,
      required: true,
      path: null,
      reason: 'attestation_dir_unconfigured',
    })
    expect(refreshProviderEffectsConsumerAttestation(decision, 'aun', {
      env: { [PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]: 'relative/path' },
      pid: 41002,
    })).toEqual({
      ok: false,
      required: true,
      path: null,
      reason: 'attestation_dir_not_absolute',
    })
    expect(refreshProviderEffectsConsumerAttestation(decision, 'aun', {
      env: { [PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]: notDirectory },
      pid: 41002,
    })).toEqual({
      ok: false,
      required: true,
      path: join(notDirectory, 'consumer-41002.json'),
      reason: 'attestation_write_failed',
    })
  })

  test('deny and epoch changes atomically refresh the same PID record', () => {
    const root = temporaryRoot()
    const directory = join(root, 'attestations')
    const context = {
      env: { [PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]: directory },
      pid: 41003,
      nowMs: Date.parse('2026-08-15T01:02:03.000Z'),
    }
    const first = refreshProviderEffectsConsumerAttestation(control('allowed', 'epoch-before'), 'aun', context)
    expect(first.ok).toBe(true)

    const denied = control('forbidden', 'epoch-after')
    const second = refreshProviderEffectsConsumerAttestation(denied, 'aun', {
      ...context,
      nowMs: context.nowMs + 1_000,
    })
    expect(second.ok).toBe(true)
    if (!second.ok || !second.required) throw new Error('expected refreshed attestation')
    expect(second.record.provider_effects_mode).toBe('forbidden')
    expect(second.record.provider_control_epoch).toBe('epoch-after')
    expect(second.record.provider_control_attestation).toBe(denied.attestation)
    expect(second.record.observed_at).toBe('2026-08-15T01:02:04.000Z')
    expect(existsSync(join(directory, '.consumer-41003.1786755724000.tmp'))).toBe(false)
  })

  test('strict readback rejects malformed, stale, mismatched PID, and mismatched control records', () => {
    const root = temporaryRoot()
    const nowMs = Date.parse('2026-08-15T01:02:03.000Z')
    const decision = control('forbidden', 'epoch-strict')
    const written = refreshProviderEffectsConsumerAttestation(decision, 'aun', {
      env: { [PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]: root },
      pid: 41004,
      nowMs,
    })
    if (!written.ok || !written.required) throw new Error('expected written attestation')
    const record = written.record

    expect(parseProviderEffectsConsumerAttestation('{')).toEqual({ ok: false, reason: 'invalid_json' })
    expect(parseProviderEffectsConsumerAttestation(JSON.stringify({ ...record, extra: true }), { nowMs }))
      .toEqual({ ok: false, reason: 'invalid_shape' })
    expect(parseProviderEffectsConsumerAttestation(JSON.stringify({
      ...record,
      provider_control_epoch: null,
      provider_control_content_sha256: null,
      provider_control_attestation: 'forbidden:none:none',
    }), { nowMs })).toEqual({ ok: false, reason: 'invalid_reason' })
    expect(readProviderEffectsConsumerAttestation(written.path, {
      nowMs: nowMs + 5_001,
    })).toEqual({ ok: false, path: written.path, reason: 'stale_observation' })
    expect(readProviderEffectsConsumerAttestation(written.path, {
      nowMs,
      expectedPid: 99999,
    })).toEqual({ ok: false, path: written.path, reason: 'pid_mismatch' })
    expect(readProviderEffectsConsumerAttestation(written.path, {
      nowMs,
      expectedControlAttestation: 'forbidden:other:hash',
    })).toEqual({ ok: false, path: written.path, reason: 'control_attestation_mismatch' })
  })

  test('cleanup removes only the strict record owned by the expected agent and PID', () => {
    const root = temporaryRoot()
    const written = refreshProviderEffectsConsumerAttestation(control('allowed', 'epoch-cleanup'), 'aun', {
      env: { [PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]: root },
      pid: 41005,
    })
    if (!written.ok || !written.required) throw new Error('expected written attestation')

    expect(removeProviderEffectsConsumerAttestation({
      path: written.path,
      agentId: 'another-agent',
      pid: 41005,
    })).toBe(false)
    expect(existsSync(written.path)).toBe(true)
    expect(removeProviderEffectsConsumerAttestation({
      path: written.path,
      agentId: 'aun',
      pid: 41005,
    })).toBe(true)
    expect(existsSync(written.path)).toBe(false)
  })

  test('unconfigured provider control preserves legacy behavior without an attestation directory', () => {
    const decision = readProviderEffectsControl({})
    expect(decision.configured).toBe(false)
    expect(refreshProviderEffectsConsumerAttestation(decision, 'aun', { env: {}, pid: 41006 }))
      .toEqual({ ok: true, required: false, path: null, record: null })
  })
})

describe('outbound consumer attestation fence', () => {
  test('configured missing attestation config fails before DB claim and provider call', async () => {
    delete process.env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]
    let dbCalls = 0
    let providerCalls = 0
    setDbGetter(async () => ({
      query: async () => {
        dbCalls++
        return { rows: [], rowCount: 0 }
      },
    }), 'aun')
    discordClients.set('aun', {
      isConnected: () => true,
      sendAdapterMessage: async () => {
        providerCalls++
        return { external_message_id: 'must-not-send' }
      },
    } as any)

    await consumeOneOutboundRow({
      readProviderEffectsControl: () => control('allowed', 'epoch-no-attestation-dir'),
    })

    expect(dbCalls).toBe(0)
    expect(providerCalls).toBe(0)
  })

  test('configured successful attestation occurs before the claim query', async () => {
    const root = temporaryRoot()
    process.env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV] = root
    const events: string[] = []
    setDbGetter(async () => ({
      query: async () => {
        events.push('db')
        return { rows: [], rowCount: 0 }
      },
    }), 'aun')

    await consumeOneOutboundRow({
      readProviderEffectsControl: () => {
        events.push('control')
        return control('allowed', 'epoch-before-claim')
      },
      refreshProviderEffectsConsumerAttestation: (decision, agentId) => {
        events.push('attestation')
        return refreshProviderEffectsConsumerAttestation(decision, agentId)
      },
    })

    expect(events).toEqual(['control', 'attestation', 'db'])
    const path = join(root, `consumer-${process.pid}.json`)
    expect(readProviderEffectsConsumerAttestation(path, {
      expectedAgentId: 'aun',
      expectedPid: process.pid,
    }).ok).toBe(true)
  })

  test('epoch deny after claim refreshes evidence, releases claim, and makes zero provider calls', async () => {
    const root = temporaryRoot()
    process.env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV] = root
    const calls: Array<{ sql: string; params?: any[] }> = []
    let reads = 0
    let providerCalls = 0
    setDbGetter(async () => ({
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params })
        if (sql.includes("SET status = 'claimed'")) {
          return {
            rows: [{
              id: 'attestation-race-row',
              message_id: '10000000-0000-4000-8000-000000000101',
              channel_external_id: 'provider-channel',
              content: 'must remain internal',
              mentions_display: null,
              attachments: null,
              reply_to_discord_id: null,
              attempts: 1,
              max_attempts: 5,
              discord_message_id: null,
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 1 }
      },
    }), 'aun')
    discordClients.set('aun', {
      isConnected: () => true,
      sendAdapterMessage: async () => {
        providerCalls++
        return { external_message_id: 'must-not-send' }
      },
    } as any)

    const denied = control('forbidden', 'epoch-after-claim')
    await consumeOneOutboundRow({
      readProviderEffectsControl: () => ++reads === 1
        ? control('allowed', 'epoch-before-claim')
        : denied,
    })

    expect(reads).toBe(2)
    expect(providerCalls).toBe(0)
    expect(calls.some((call) => call.sql.includes('attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END')))
      .toBe(true)
    const readback = readProviderEffectsConsumerAttestation(
      join(root, `consumer-${process.pid}.json`),
      { expectedControlAttestation: denied.attestation },
    )
    expect(readback.ok).toBe(true)
  })

  test('start writes an attestation before scheduling and stop removes its own record', () => {
    const root = temporaryRoot()
    const controlPath = join(root, 'provider-effects-control.json')
    const attestationDirectory = join(root, 'attestations')
    writeFileSync(controlPath, JSON.stringify({
      schema_version: PROVIDER_EFFECTS_CONTROL_SCHEMA,
      epoch: 'epoch-start-stop',
      provider_effects: 'forbidden',
      expires_at: '2099-01-01T00:00:00.000Z',
    }), { mode: 0o600 })
    process.env[PROVIDER_EFFECTS_CONTROL_FILE_ENV] = controlPath
    process.env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV] = attestationDirectory
    setDbGetter(async () => null, 'aun')

    startOutboundConsumer()
    const path = join(attestationDirectory, `consumer-${process.pid}.json`)
    expect(existsSync(path)).toBe(true)
    stopOutboundConsumer()
    expect(existsSync(path)).toBe(false)
  })
})
