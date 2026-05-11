import { describe, test, expect } from 'bun:test'
import {
  createDefaultBotInventoryPort,
  defaultBotInventoryPort,
} from '../../../core/ports/bot-inventory-port'

const port = createDefaultBotInventoryPort()

describe('BotInventoryPort (spec §4.2 T5-T7, T7b)', () => {
  test('T5: known production id → true', () => {
    expect(port.isProductionBot('cto')).toBe(true)
  })

  test('T6: dev-bot id → false', () => {
    expect(port.isProductionBot('agent-com-dev')).toBe(false)
  })

  test('T7: empty string → false (safe default)', () => {
    expect(port.isProductionBot('')).toBe(false)
  })

  test('T7b: symmetry invariant (production members)', () => {
    // Every id returned by listProductionBots() must round-trip through
    // isProductionBot as true. Spec §1.2 freezes this equivalence.
    const ids = port.listProductionBots()
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(port.isProductionBot(id)).toBe(true)
    }
  })

  test('T7b: symmetry invariant (non-members sample)', () => {
    const members = new Set(port.listProductionBots())
    const samples = ['agent-com-dev', 'dev-001', '', 'unknown', 'lead-tuk']
    for (const id of samples) {
      // Each sample must not be a member, and the predicate must agree.
      expect(members.has(id)).toBe(false)
      expect(port.isProductionBot(id)).toBe(false)
    }
  })

  test('listProductionBots() includes the six canonical production bots', () => {
    const ids = new Set(port.listProductionBots())
    for (const expected of ['cto', 'arc', 'auditor', 'vice', 'secretary', 'lead-ama']) {
      expect(ids.has(expected)).toBe(true)
    }
  })

  test('singleton matches a fresh port instance', () => {
    expect(defaultBotInventoryPort.listProductionBots()).toEqual(
      port.listProductionBots(),
    )
    for (const id of port.listProductionBots()) {
      expect(defaultBotInventoryPort.isProductionBot(id)).toBe(true)
    }
  })
})
