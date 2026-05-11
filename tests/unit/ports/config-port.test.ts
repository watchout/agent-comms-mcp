import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  DESTRUCTIVE_GATE_ENV,
  RUNTIME_ENV,
  createDefaultConfigPort,
  defaultConfigPort,
} from '../../../core/ports/config-port'

const port = createDefaultConfigPort()

function restoreEnv(prior: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('ConfigPort (spec §4.2 T1-T4, T7c)', () => {
  let prior: Record<string, string | undefined> = {}

  beforeEach(() => {
    prior = {
      [DESTRUCTIVE_GATE_ENV]: process.env[DESTRUCTIVE_GATE_ENV],
      [RUNTIME_ENV]: process.env[RUNTIME_ENV],
    }
    delete process.env[DESTRUCTIVE_GATE_ENV]
    delete process.env[RUNTIME_ENV]
  })

  afterEach(() => restoreEnv(prior))

  test('T1: env unset → allowed=false, rawValue=null', () => {
    expect(port.getDestructiveMigrationFlagState()).toEqual({
      allowed: false,
      rawValue: null,
    })
  })

  test('T2: env="1" → allowed=true', () => {
    process.env[DESTRUCTIVE_GATE_ENV] = '1'
    expect(port.getDestructiveMigrationFlagState()).toEqual({
      allowed: true,
      rawValue: '1',
    })
  })

  test('T3: env="true" → allowed=false (strict "1" only, PR #340 §3.1)', () => {
    process.env[DESTRUCTIVE_GATE_ENV] = 'true'
    expect(port.getDestructiveMigrationFlagState()).toEqual({
      allowed: false,
      rawValue: 'true',
    })
  })

  test('T4: getDefaultRuntime() === "TUI" constant (PR #341 anchor)', () => {
    expect(port.getDefaultRuntime()).toBe('TUI')
    // The exported singleton must agree.
    expect(defaultConfigPort.getDefaultRuntime()).toBe('TUI')
  })

  test('T7c: throw-free contract — unset env returns safe defaults', () => {
    expect(() => port.getDestructiveMigrationFlagState()).not.toThrow()
    expect(() => port.getRuntimeIdentifier()).not.toThrow()
    expect(port.getDestructiveMigrationFlagState()).toEqual({
      allowed: false,
      rawValue: null,
    })
    const runtime = port.getRuntimeIdentifier()
    expect(['TUI', 'claude-code']).toContain(runtime)
  })

  test('getRuntimeIdentifier honours valid env values', () => {
    process.env[RUNTIME_ENV] = 'claude-code'
    expect(port.getRuntimeIdentifier()).toBe('claude-code')
    process.env[RUNTIME_ENV] = 'TUI'
    expect(port.getRuntimeIdentifier()).toBe('TUI')
  })

  test('getRuntimeIdentifier falls back to TUI on unrecognised value', () => {
    process.env[RUNTIME_ENV] = 'gemini'
    expect(port.getRuntimeIdentifier()).toBe('TUI')
  })

  test('singleton observes env mutations (no internal cache)', () => {
    process.env[DESTRUCTIVE_GATE_ENV] = '1'
    expect(defaultConfigPort.getDestructiveMigrationFlagState().allowed).toBe(true)
    delete process.env[DESTRUCTIVE_GATE_ENV]
    expect(defaultConfigPort.getDestructiveMigrationFlagState().allowed).toBe(false)
  })
})
