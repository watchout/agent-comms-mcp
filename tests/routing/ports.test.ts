/**
 * Phase 5 §4 — port unit tests + behavioral fixtures (merge gate).
 *
 * Covers §4.1 dedup / §4.2 sender + multi-mention normalization / §4.3 missing target /
 * §4.4 outbound ACL reject / §4.5 failure modes / §4.6 cc[] body injection.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, unlinkSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  createInboundResolver,
  createPrimaryFallback,
  createOutboundPolicyValidator,
  createMessageBodyDecorator,
  getChannelPolicy,
  refreshChannelPolicyDbSnapshot,
  resetChannelPolicyCache,
} from '../../core/routing'

const KNOWN_AGENTS = new Set(['alice', 'bob', 'carol', 'dan', 'agent-com-dev', 'cto', 'codex-cto', 'lead-ama'])
const isKnown = (id: string) => KNOWN_AGENTS.has(id)

const TMP_CONFIG = `/tmp/phase5-routing-${process.pid}-${Date.now()}.json`

function setRoutingConfig(channels: Record<string, { primary?: string | null; adapterOwner?: string | null; outboundAllowlist?: string[] }>) {
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
    expect(p.policySource).toBe('config/bot-routing.json')
  })

  test('production without DB policy does not read bot-routing and fails closed', async () => {
    delete process.env.AGENT_COM_BOT_ROUTING_PATH
    delete process.env.AGENT_COM_ENABLE_BOT_ROUTING_FILE_FALLBACK
    resetChannelPolicyCache()

    const loaded = await refreshChannelPolicyDbSnapshot({
      async query() {
        return { rows: [] }
      },
    })

    expect(loaded).toEqual({ loaded: true, count: 0 })
    const p = getChannelPolicy('1487368919613444156')
    expect(p.primary).toBeNull()
    expect(p.adapterOwner).toBeNull()
    expect(p.outboundAllowlist).toEqual([])
    expect(p.policySource).toBe('none')

    const validator = createOutboundPolicyValidator()
    expect(validator.validate('agent-com-dev', '1487368919613444156', ['codex-cto'])).toEqual({
      ok: false,
      violations: ['agent-com-dev', 'codex-cto'],
    })
  })

  test('present channel returns configured primary + allowlist', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice', adapterOwner: 'bob', outboundAllowlist: ['alice', 'bob'] } })
    const p = getChannelPolicy('ch1')
    expect(p.primary).toBe('alice')
    expect(p.adapterOwner).toBe('bob')
    expect(p.outboundAllowlist).toEqual(['alice', 'bob'])
  })

  test('§1.8 reloads file mutations in a long-lived process', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice' } })
    expect(getChannelPolicy('ch1').primary).toBe('alice')
    // Mutate file directly, do NOT reset cache. Long-lived MCP servers must
    // pick this up so ACL fixes do not require a client/session restart.
    writeFileSync(TMP_CONFIG, JSON.stringify({ version: 1, channels: { ch1: { primary: 'bob', outboundAllowlist: ['bob'] } } }), 'utf8')
    const p = getChannelPolicy('ch1')
    expect(p.primary).toBe('bob')
    expect(p.outboundAllowlist).toEqual(['bob'])
  })

  test('invalid reload keeps the last known valid config instead of relaxing ACL', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice', outboundAllowlist: ['alice'] } })
    expect(getChannelPolicy('ch1').outboundAllowlist).toEqual(['alice'])
    writeFileSync(TMP_CONFIG, '{invalid-json', 'utf8')
    const p = getChannelPolicy('ch1')
    expect(p.primary).toBe('alice')
    expect(p.outboundAllowlist).toEqual(['alice'])
  })

  test('schema-invalid reload keeps the last known valid config instead of crashing or relaxing ACL', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice', outboundAllowlist: ['alice'] } })
    expect(getChannelPolicy('ch1').outboundAllowlist).toEqual(['alice'])
    writeFileSync(TMP_CONFIG, JSON.stringify({ version: 1, channels: null }), 'utf8')
    const p = getChannelPolicy('ch1')
    expect(p.primary).toBe('alice')
    expect(p.outboundAllowlist).toEqual(['alice'])
  })

  test('missing-file reload keeps the last known valid config instead of relaxing ACL', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice', outboundAllowlist: ['alice'] } })
    expect(getChannelPolicy('ch1').outboundAllowlist).toEqual(['alice'])
    rmSync(TMP_CONFIG, { force: true })
    const p = getChannelPolicy('ch1')
    expect(p.primary).toBe('alice')
    expect(p.outboundAllowlist).toEqual(['alice'])
  })

  test('DB channel_routing_policy snapshot overrides JSON and falls back by channel', async () => {
    setRoutingConfig({
      ch1: { primary: 'json-primary', adapterOwner: 'json-owner', outboundAllowlist: ['json-primary'] },
      ch2: { primary: 'json-only', outboundAllowlist: ['json-only'] },
    })
    const loaded = await refreshChannelPolicyDbSnapshot({
      async query() {
        return {
          rows: [
            {
              channel_id: 'ch1',
              primary_agent_id: 'db-primary',
              adapter_owner_agent_id: 'db-owner',
              outbound_allowlist: '["db-primary","db-owner"]',
              native_role_outbound_owners: '{"codex-cto":"codex-cto"}',
              native_projection_identities: '{}',
            },
          ],
        }
      },
    })

    expect(loaded).toEqual({ loaded: true, count: 1 })
    expect(getChannelPolicy('ch1').primary).toBe('db-primary')
    expect(getChannelPolicy('ch1').adapterOwner).toBe('db-owner')
    expect(getChannelPolicy('ch1').outboundAllowlist).toEqual(['db-primary', 'db-owner'])
    expect(getChannelPolicy('ch1').policySource).toBe('db')
    expect(getChannelPolicy('ch1').nativeRoleOutboundOwners['codex-cto']).toBe('codex-cto')
    expect(getChannelPolicy('ch2').primary).toBe('json-only')
  })

  test('DB policy table missing keeps JSON fallback active', async () => {
    setRoutingConfig({ ch1: { primary: 'json-primary' } })
    const loaded = await refreshChannelPolicyDbSnapshot({
      async query() {
        throw new Error('relation "channel_routing_policy" does not exist')
      },
    })

    expect(loaded).toEqual({ loaded: false, count: 0 })
    expect(getChannelPolicy('ch1').primary).toBe('json-primary')
  })
})

// ============================================================
// §1.7 Port A — InboundResolver + §2.1 dedup + §2.2 normalization + §1.6 validation
// ============================================================
describe('InboundResolver (§1.7 Port A) — §2.1 dedup', () => {
  const primaryFallback = createPrimaryFallback()
  const resolver = createInboundResolver({ isKnownAgent: isKnown, primaryFallback })

  // PR #315 follow-up — cc[] non-enqueue invariant (§1.5).
  // enqueue MUST contain only the primary mention; cc[] are surfaced via
  // body suffix (MessageBodyDecorator), never via queue rows.
  test('§1.5 cc duplicates mention → enqueue=[mention], cc preserved for body', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mention: 'alice', cc: ['alice'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.enqueue).toEqual(['alice'])
      expect(r.cc).toEqual(['alice'])
    }
  })

  test('§1.5 mention + distinct cc → enqueue=[mention] only (cc NOT enqueued)', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mention: 'alice', cc: ['bob'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.enqueue).toEqual(['alice'])
      expect(r.cc).toEqual(['bob'])
    }
  })

  test('§2.2 mentions[] is normalized, deduped, and enqueued without cc[] fanout', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mentions: ['alice', 'bob', 'alice'], cc: ['carol'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.enqueue).toEqual(['alice', 'bob'])
      expect(r.cc).toEqual(['carol'])
    }
  })

  test('§2.2 native role alias cto normalizes to canonical codex-cto', () => {
    const r = resolver.resolve({ channel_id: 'ch1', mentions: ['cto', 'lead-ama'] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.enqueue).toEqual(['codex-cto', 'lead-ama'])
  })
})

// CEO directive 2026-05-27 — missing mention target rejects instead of
// falling back to channel.primary. The adapter/router sends the human alert.
describe('InboundResolver — §2.3 missing mention target', () => {
  test('§4.3 no mention + channel.primary → INVALID_MENTION', () => {
    setRoutingConfig({ 'ch1': { primary: 'alice' } })
    const resolver = createInboundResolver({
      isKnownAgent: isKnown,
      primaryFallback: createPrimaryFallback(),
    })
    const r = resolver.resolve({ channel_id: 'ch1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('INVALID_MENTION')
  })

  test('§4.3 no mention + no primary → INVALID_MENTION', () => {
    const resolver = createInboundResolver({
      isKnownAgent: isKnown,
      primaryFallback: createPrimaryFallback(),
    })
    const r = resolver.resolve({ channel_id: 'unknown-ch' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('INVALID_MENTION')
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
  // (hotel-dev) JST.
  //
  // cycle 2 rigor (auditor BLOCK 3 axes解消): use `toEqual` exact match so
  // length / order / forbidden additions are all gated by a single
  // assertion (cycle 1 `toContain` only verified inclusion, missed
  // contamination + reorder regressions).
  test('§4.4 channel 1487368919613444156 — repaired allowlist + adapter owner', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(new URL('../..', import.meta.url).pathname, 'config/bot-routing.json'),
        'utf-8',
      ),
    )
    const allowed = cfg.channels['1487368919613444156']?.outboundAllowlist
    expect(cfg.channels['1487368919613444156']?.adapterOwner).toBe('agent-com-dev')
    expect(allowed).toEqual([
      'agent-com-dev',
      'cto',
      'codex-cto',
      'codex-aun',
      'codex-audit',
      'ceo',
      'auditor',
      'arc',
      'lead-sus',
      'hotel-dev',
      'dev-001',
    ])
  })

  test('§4.4 channel 1487368919613444156 — CTO direct routes + codex-aun / hotel-dev / dev-001 ok, unknown sender → violations contains it', () => {
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
    // #456 regression: CTO must be able to route direct work to codex-aun
    // without lead-ama relay fallback. L2 audit routing also needs codex-audit.
    expect(v.validate('codex-cto', '1487368919613444156', ['codex-aun']).ok).toBe(true)
    expect(v.validate('codex-cto', '1487368919613444156', ['codex-audit']).ok).toBe(true)
    // lead-sus → codex-aun: ok after lead-ama retirement.
    expect(v.validate('lead-sus', '1487368919613444156', ['codex-aun']).ok).toBe(true)
    // hotel-dev → cto: ok
    expect(v.validate('hotel-dev', '1487368919613444156', ['cto']).ok).toBe(true)
    // #592 repaired owner handoff route: codex-cto/agent-com-dev can enqueue dev-001 directly.
    expect(v.validate('codex-cto', '1487368919613444156', ['dev-001']).ok).toBe(true)
    expect(v.validate('agent-com-dev', '1487368919613444156', ['dev-001']).ok).toBe(true)
    // cycle 2 rigor: unknown sender must reject AND surface the offender in
    // `violations` (the OutboundPolicyValidator's violation kind field).
    // The integration layer maps this to the `OUTBOUND_ACL_VIOLATION` error
    // class (core/routing/server-integration.ts:92), so pinning `violations`
    // here is equivalent to pinning the violation kind at this port.
    const r = v.validate('nonexistent-foo', '1487368919613444156', ['codex-aun'])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations).toContain('nonexistent-foo')
    }
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
    // Positive pin: reload is synchronous metadata revalidation, not a watcher.
    expect(text).toContain('revalidated on access')
  })

  test('§3.6 group mention — InboundResolver does not implement @arc-team virtual fanout', async () => {
    const text = await readRepo('core/routing/ports/inbound-resolver.ts')
    expect(text).not.toMatch(/@arc-team|virtual.*group|expandGroup/)
  })

  test('§3.2 mention/mentions normalization is centralized', async () => {
    const text = await readRepo('core/routing/ports/inbound-resolver.ts')
    expect(text).toMatch(/normalizeAgentMentions/)
    expect(text).toMatch(/mentions:\s*input\.mentions/)
    expect(text).not.toMatch(/channel\.primary/)
    expect(text).not.toMatch(/primaryFallback\.resolve/)
  })
})
