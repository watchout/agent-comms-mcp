import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROVIDER_EFFECTS_CONTROL_FILE_ENV,
  PROVIDER_EFFECTS_CONTROL_SCHEMA,
  parseProviderEffectsControl,
  readProviderEffectsControl,
} from '../core/provider-effects-control'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rawControl(
  providerEffects: 'allowed' | 'forbidden',
  epoch = 'a1-sample-b-001',
  expiresAt = '2099-01-01T00:00:00.000Z',
): string {
  return JSON.stringify({
    schema_version: PROVIDER_EFFECTS_CONTROL_SCHEMA,
    epoch,
    provider_effects: providerEffects,
    expires_at: expiresAt,
  })
}

function writeControl(raw: string): string {
  const root = mkdtempSync(join(tmpdir(), 'provider-effects-control-'))
  roots.push(root)
  const path = join(root, 'control.json')
  writeFileSync(path, raw, { mode: 0o600 })
  return path
}

describe('provider-effects host control', () => {
  test('unconfigured processes preserve legacy provider behavior', () => {
    const decision = readProviderEffectsControl({})
    expect(decision).toMatchObject({
      configured: false,
      allowsProviderEffects: true,
      mode: 'allowed',
      reason: 'legacy_unconfigured',
      attestation: 'legacy-unconfigured',
    })
  })

  test('a valid forbidden epoch blocks effects with a stable content attestation', () => {
    const raw = rawControl('forbidden')
    const path = writeControl(raw)
    const decision = readProviderEffectsControl({ [PROVIDER_EFFECTS_CONTROL_FILE_ENV]: path })
    expect(decision).toMatchObject({
      configured: true,
      allowsProviderEffects: false,
      mode: 'forbidden',
      reason: 'control_forbidden',
      epoch: 'a1-sample-b-001',
      sourcePath: path,
    })
    expect(decision.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(decision.attestation).toBe(`forbidden:a1-sample-b-001:${decision.contentSha256}`)
  })

  test('a valid allowed epoch permits effects only until its exact expiry', () => {
    const raw = rawControl('allowed', 'allow-001', '2026-08-15T04:00:00.000Z')
    expect(parseProviderEffectsControl(raw, '/tmp/control.json', Date.parse('2026-08-15T03:59:59.000Z')))
      .toMatchObject({ allowsProviderEffects: true, reason: 'control_allowed', epoch: 'allow-001' })
    expect(parseProviderEffectsControl(raw, '/tmp/control.json', Date.parse('2026-08-15T04:00:00.000Z')))
      .toMatchObject({ allowsProviderEffects: false, reason: 'control_expired', epoch: 'allow-001' })
  })

  test('configured relative, missing, malformed, stale, and extra-field controls fail closed', () => {
    const cases = [
      readProviderEffectsControl({ [PROVIDER_EFFECTS_CONTROL_FILE_ENV]: 'relative.json' }),
      readProviderEffectsControl({ [PROVIDER_EFFECTS_CONTROL_FILE_ENV]: '/definitely/missing/provider-effects.json' }),
      readProviderEffectsControl({ [PROVIDER_EFFECTS_CONTROL_FILE_ENV]: writeControl('{') }),
      readProviderEffectsControl({
        [PROVIDER_EFFECTS_CONTROL_FILE_ENV]: writeControl(rawControl('allowed', 'stale', '2000-01-01T00:00:00.000Z')),
      }),
      readProviderEffectsControl({
        [PROVIDER_EFFECTS_CONTROL_FILE_ENV]: writeControl(JSON.stringify({
          ...JSON.parse(rawControl('allowed')),
          unexpected: true,
        })),
      }),
    ]
    expect(cases.map((decision) => decision.reason)).toEqual([
      'control_path_not_absolute',
      'control_unreadable',
      'control_invalid_json',
      'control_expired',
      'control_invalid_shape',
    ])
    expect(cases.every((decision) => !decision.allowsProviderEffects)).toBe(true)
  })

  test('an epoch or content change produces a different attestation', () => {
    const first = parseProviderEffectsControl(rawControl('allowed', 'epoch-1'), '/tmp/control.json')
    const second = parseProviderEffectsControl(rawControl('allowed', 'epoch-2'), '/tmp/control.json')
    const denied = parseProviderEffectsControl(rawControl('forbidden', 'epoch-2'), '/tmp/control.json')
    expect(new Set([first.attestation, second.attestation, denied.attestation]).size).toBe(3)
  })
})
