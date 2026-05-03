/**
 * Phase 5 §4 — port unit tests + behavioral fixtures (merge gate).
 *
 * Covers §4.1 dedup / §4.2 sender + auto-convert / §4.3 primary routing /
 * §4.4 outbound ACL reject / §4.5 failure modes / §4.6 cc[] body injection.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createInboundResolver,
  createPrimaryFallback,
  createOutboundPolicyValidator,
  createMessageBodyDecorator,
  getChannelPolicy,
  resetChannelPolicyCache,
} from '../../core/routing'

const KNOWN_AGENTS = new Set(['alice', 'bob', 'carol', 'dan', 'agent-com-dev', 'cto', 'lead-ama'])
const isKnown = (id: string) => KNOWN_AGENTS.has(id)

const TMP_CONFIG = `/tmp/phase5-routing-${process.pid}-${Date.now()}.json`

function setRoutingConfig(channels: Record<string, { primary?: string | null; outboundAllowlist?: string[] }>) {
  writeFileSync(TMP_CONFIG, JSON.stringify({ version: 1, channels }), 'utf8')
  process.env.AGENT_COM_BOT_ROUTING_PATH = TMP_CONFIG
  resetChannelPolicyCache()
}

beforeEach(() => {
  // No config = empty channels (legacy compat).
  setRoutingConfig({})
})

afterEach(() => {
  delete process.env.AGENT_COM_BOT_ROUTING_PATH
  resetChannelPolicyCache()
  if (existsSync(TMP_CONFIG)) {
    try { unlinkSync(TMP_CONFIG) } catch {}
  }
})

// ============================================================
// §1.8 channel-policy source
// ============================================================
describe('channel-policy (§1.8)', () => {
  test('absent channel → null primary + null outboundAllowlist (legacy compat)', () => {
    const p = getChannelPolicy('unknown-channel')
    expect(p.primary).toBeNull()
    expect(p.outboundAllowlist).toBeNull()
  })

  test('present channel returns configured primary + allowlist', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice', outboundAllowlist: ['alice', 'bob'] } })
    const p = getChannelPolicy('ch1')
    expect(p.primary).toBe('alice')
    expect(p.outboundAllowlist).toEqual(['alice', 'bob'])
  })

  test('§3.7 / §1.8 reload is restart-only — file mutations after first read are ignored', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice' } })
    expect(getChannelPolicy('ch1').primary).toBe('alice')
    // Mutate file directly, do NOT reset cache.
    writeFileSync(TMP_CONFIG, JSON.stringify({ version: 1, channels: { ch1: { primary: 'bob' } } }), 'utf8')
    expect(getChannelPolicy('ch1').primary).toBe('alice') // cache wins
  })
})

// ============================================================
// §1.7 Port A — InboundResolver + §2.1 dedup + §2.2 auto-convert + §1.6 validation
// ============================================================
describe('InboundResolver (§1.7 Port A) — §2.1 dedup', () => {
  const primaryFallback = createPrimaryFallback()
  const resolver = createInboundResolver({ isKnownAgent: isKnown, primaryFallback })

  test('§4.1 same mention twice → 1 enqueue', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mention: 'alice', cc: ['alice'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.enqueue).toEqual(['alice'])
      expect(r.cc).toEqual(['alice'])
    }
  })

  test('§4.1 different mentions → distinct enqueue', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mention: 'alice', cc: ['bob'] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.enqueue.sort()).toEqual(['alice', 'bob'])
  })
})

describe('InboundResolver — §2.2 sender 制限 + auto-convert', () => {
  const primaryFallback = createPrimaryFallback()
  const resolver = createInboundResolver({ isKnownAgent: isKnown, primaryFallback })

  test('§4.2 legacy mentions[] → mention=mentions[0], rest → cc + warning', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mentions: ['alice', 'bob', 'carol'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.enqueue).toContain('alice')
      expect(r.cc.sort()).toEqual(['bob', 'carol'])
      expect(r.warnings.some((w) => w.includes('auto-converted'))).toBe(true)
    }
  })

  test('§4.5 mention+mentions both supplied → mention wins + warning', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mention: 'alice', mentions: ['bob'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.enqueue).toContain('alice')
      expect(r.warnings.some((w) => w.includes('mention+mentions'))).toBe(true)
    }
  })
})

describe('InboundResolver — §2.3 primary routing fallback', () => {
  test('§4.3 no mention + channel.primary → primary enqueue', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice' } })
    const resolver = createInboundResolver({
      isKnownAgent: isKnown,
      primaryFallback: createPrimaryFallback(),
    })
    const r = resolver.resolve({ channel_id: 'ch1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.enqueue).toEqual(['alice'])
  })

  test('§4.3 no mention + no primary → skip + warning (no enqueue)', () => {
    const resolver = createInboundResolver({
      isKnownAgent: isKnown,
      primaryFallback: createPrimaryFallback(),
    })
    const r = resolver.resolve({ channel_id: 'unknown-ch' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.enqueue).toEqual([])
      expect(r.warnings.some((w) => w.includes('no mention and no channel.primary'))).toBe(true)
    }
  })

  test('§4.3 mention 指定時は primary を ignore (mention 優先)', () => {
    setRoutingConfig({ 'ch1': { primary: 'bob' } })
    const resolver = createInboundResolver({
      isKnownAgent: isKnown,
      primaryFallback: createPrimaryFallback(),
    })
    const r = resolver.resolve({ channel_id: 'ch1', mention: 'alice' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.enqueue).toEqual(['alice'])
  })
})

describe('InboundResolver — §1.6 / §4.5 mention/cc validation (failure modes)', () => {
  const primaryFallback = createPrimaryFallback()
  const resolver = createInboundResolver({ isKnownAgent: isKnown, primaryFallback })

  test('empty mention string → INVALID_MENTION', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mention: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('INVALID_MENTION')
  })

  test('unknown mention agent → UNKNOWN_AGENT + agent_id surfaced', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mention: 'nobody' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('UNKNOWN_AGENT')
      expect(r.agent_id).toBe('nobody')
    }
  })

  test('unknown cc agent → strip + warning (degradation safe, not reject)', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mention: 'alice', cc: ['bob', 'nobody'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cc).toEqual(['bob']) // nobody stripped
      expect(r.warnings.some((w) => w.includes('cc agent "nobody" unknown'))).toBe(true)
    }
  })
})

// ============================================================
// §1.7 Port C — OutboundPolicyValidator + §2.4 reject 一本化
// ============================================================
describe('OutboundPolicyValidator (§1.7 Port C) — §2.4 reject 一本化', () => {
  test('§4.4 absent allowlist → all senders permitted (legacy compat)', () => {
    const v = createOutboundPolicyValidator()
    const r = v.validate('alice', 'unknown-ch', ['bob'])
    expect(r.ok).toBe(true)
  })

  test('§4.4 sender in allowlist + recipient in allowlist → ok', () => {
    setRoutingConfig({ 'ch1': { outboundAllowlist: ['alice', 'bob'] } })
    const v = createOutboundPolicyValidator()
    const r = v.validate('alice', 'ch1', ['bob'])
    expect(r.ok).toBe(true)
  })

  test('§4.4 sender violates allowlist → reject', () => {
    setRoutingConfig({ 'ch1': { outboundAllowlist: ['bob'] } })
    const v = createOutboundPolicyValidator()
    const r = v.validate('alice', 'ch1', ['bob'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations).toContain('alice')
  })

  test('§4.4 recipient violates allowlist → reject (cc[] strip 削除、reject 一本化)', () => {
    setRoutingConfig({ 'ch1': { outboundAllowlist: ['alice'] } })
    const v = createOutboundPolicyValidator()
    const r = v.validate('alice', 'ch1', ['bob'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations).toContain('bob')
  })

  // PR-routing-acl-extend: pin the channel `1487368919613444156` (#agent-com)
  // outboundAllowlist after lead-sus + hotel-dev were added to unblock the
  // routing drops observed at 2026-05-03 07:01 (lead-sus) and 10:03
  // (hotel-dev) JST. The full allowed sender set is the merge gate; any
  // future addition / removal must update this fixture.
  test('§4.4 channel 1487368919613444156 — full 8-bot allowlist (lead-sus + hotel-dev included)', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(new URL('../..', import.meta.url).pathname, 'config/bot-routing.json'),
        'utf-8',
      ),
    )
    const allowed = cfg.channels['1487368919613444156']?.outboundAllowlist
    expect(Array.isArray(allowed)).toBe(true)
    for (const a of [
      'agent-com-dev',
      'lead-ama',
      'cto',
      'ceo',
      'auditor',
      'arc',
      'lead-sus',
      'hotel-dev',
    ]) {
      expect(allowed).toContain(a)
    }
  })

  test('§4.4 channel 1487368919613444156 — lead-sus / hotel-dev sender + recipient ok, unknown denied', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(new URL('../..', import.meta.url).pathname, 'config/bot-routing.json'),
        'utf-8',
      ),
    )
    setRoutingConfig({
      '1487368919613444156': {
        primary: cfg.channels['1487368919613444156']?.primary ?? 'agent-com-dev',
        outboundAllowlist: cfg.channels['1487368919613444156'].outboundAllowlist,
      },
    })
    const v = createOutboundPolicyValidator()
    // lead-sus → lead-ama: ok
    expect(v.validate('lead-sus', '1487368919613444156', ['lead-ama']).ok).toBe(true)
    // hotel-dev → cto: ok
    expect(v.validate('hotel-dev', '1487368919613444156', ['cto']).ok).toBe(true)
    // unknown sender (regression case for routing drop): deny
    const r = v.validate('nonexistent-foo', '1487368919613444156', ['lead-ama'])
    expect(r.ok).toBe(false)
  })
})

// ============================================================
// §1.7 Port D — MessageBodyDecorator + §1.5 / §4.6 cc[] body injection
// ============================================================
describe('MessageBodyDecorator (§1.7 Port D) — §4.6 cc[] body injection', () => {
  test('§4.6 cc[] empty → content unchanged', () => {
    const d = createMessageBodyDecorator()
    expect(d.decorate('hello', [])).toBe('hello')
  })

  test('§4.6 cc[] non-empty → suffix `[CC: <@id1>, <@id2>]` appended at end', () => {
    const d = createMessageBodyDecorator()
    const out = d.decorate('hello', ['alice', 'bob'])
    expect(out).toBe('hello\n\n[CC: <@alice>, <@bob>]')
  })

  test('§4.6 cc[] suffix is a literal text marker, not metadata field', () => {
    const d = createMessageBodyDecorator()
    expect(d.decorate('msg', ['alice'])).toContain('[CC: <@alice>]')
  })
})

// ============================================================
// §3 Forbidden — anti-pattern source-pin
// ============================================================
describe('Phase 5 §3 anti-pattern source-pin', () => {
  const repoRoot = new URL('../..', import.meta.url).pathname
  const readRepo = async (rel: string) => {
    const { readFileSync } = await import('node:fs')
    return readFileSync(join(repoRoot, rel), 'utf8')
  }

  test('§3.7 file watch reload — core/channel-policy.ts does not import fs.watch / chokidar', async () => {
    const text = await readRepo('core/channel-policy.ts')
    expect(text).not.toMatch(/fs\.watch|chokidar/)
    // Positive pin: comment notes restart-only reload semantics.
    expect(text).toContain('restart-only')
  })

  test('§3.6 group mention — InboundResolver does not implement @arc-team virtual fanout', async () => {
    const text = await readRepo('core/routing/ports/inbound-resolver.ts')
    expect(text).not.toMatch(/@arc-team|virtual.*group|expandGroup/)
  })

  test('§3.2 silent auto-convert — auto-convert path emits a deprecation warning', async () => {
    const text = await readRepo('core/routing/ports/inbound-resolver.ts')
    expect(text).toContain('auto-converted')
    expect(text).toMatch(/deprecated|please migrate/)
  })
})
