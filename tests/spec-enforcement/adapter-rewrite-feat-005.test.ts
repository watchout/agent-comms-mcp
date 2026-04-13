#!/usr/bin/env bun
/**
 * Spec-enforcement tests for the adapter rewrite PR (FEAT-005 完遂 / Phase C 加速).
 *
 * Pin the structural contracts of the new layout:
 *   - adapters/discord-client.ts     (Discord.js client wrapper, 1 bot = 1 client)
 *   - adapters/outbound-consumer.ts  (outbound_queue claim / retry / orphan reclaim — daemon only)
 *   - adapters/inbound-receiver.ts   (Discord event → message_queue, pg_notify listener)
 *   - adapters/index.ts              (barrel)
 *   - entrypoints/daemon.ts          (owns consumer + listener startup)
 *
 * These tests intentionally start RED. They enforce the invariants that
 * caused the 2026-04-13 outbound consumer outage (19-bot parallel consumers,
 * claim SQL race, shared fallback identity misattribution) and the
 * forthcoming flag removal (--dangerously-load-development-channels).
 *
 * See:
 *   - docs/plans/outbound-forwarder-unification.md (v5)
 *   - docs/agent-com-message-queue-spec.md §1 line 39
 *   - CTO directive 2026-04-14 (adapter rewrite PR)
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

function readIfExists(rel: string): string | null {
  const p = join(REPO_ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf-8') : null
}

/**
 * Slice a top-level `(async) function name(...)` body up to (but not
 * including) the next top-level function. Mirror of the helper in
 * s2a-daemon-owns-outbound.test.ts so assertions are scoped.
 */
function sliceFn(src: string, name: string): string {
  const startRegex = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g')
  const m = startRegex.exec(src)
  if (!m) throw new Error(`sliceFn: ${name} not found`)
  const start = m.index
  const endRegex = /\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/g
  endRegex.lastIndex = start + m[0].length
  const next = endRegex.exec(src)
  return src.slice(start, next ? next.index : src.length)
}

describe('adapter rewrite (FEAT-005 完遂) — structural contracts', () => {
  test('1. claim SQL transitions status pending→claimed atomically (no race)', () => {
    // Regression class: the 2026-04-13 19-bot parallel-consumer incident.
    // Claim SQL must flip status in the same UPDATE that selects the row,
    // so two workers cannot both observe status='pending' and claim it.
    // Plan v5 §3 mandates the pending→claimed transition (not just a
    // claimed_at stamp on a still-pending row).
    const src = readIfExists('adapters/outbound-consumer.ts')
    expect(src).not.toBeNull()
    const fn = sliceFn(src!, 'consumeOneOutboundRow')
    const m = fn.match(/UPDATE\s+outbound_queue[\s\S]{0,2000}?RETURNING/)
    expect(m).not.toBeNull()
    const sql = m![0]
    // status must transition to 'claimed' (the new explicit claimed state).
    expect(sql).toMatch(/SET[\s\S]*status\s*=\s*'claimed'/)
    // The inner SELECT must filter on the prior state 'pending' so a
    // second worker entering the same UPDATE cannot match.
    expect(sql).toMatch(/status\s*=\s*'pending'/)
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/)
    // agent_id filter survives the rewrite.
    expect(sql).toMatch(/agent_id\s*=\s*\$\d/)
    // Backoff window honored.
    expect(sql).toMatch(/next_retry_at\s+IS\s+NULL\s+OR\s+next_retry_at\s*<=\s*now\(\)/i)
  })

  test('2. stdio entrypoint does NOT start the outbound consumer', () => {
    // FEAT-005: daemon owns outbound. stdio-mode processes (MCP plugin)
    // must never bootstrap consumeOneOutboundRow ticks, or the 19-bot
    // race returns. This is enforced at both call-site and runtime gate.
    //
    // server.ts (post-surgery) plays the stdio entrypoint role. Either
    // way: registerAgent() must not call startOutboundConsumer anymore.
    const server = readIfExists('server.ts')
    expect(server).not.toBeNull()
    // registerAgent-scoped slice: no startOutboundConsumer call inside.
    const regIdx = server!.search(/async\s+function\s+registerAgent\s*\(/)
    expect(regIdx).toBeGreaterThan(-1)
    const regSlice = server!.slice(regIdx, regIdx + 5000)
    expect(regSlice).not.toMatch(/startOutboundConsumer\s*\(/)
    // stdio-side module must not import the consumer starter either.
    // (If server.ts is the stdio entrypoint, this guards against the
    // function being re-introduced elsewhere in the file.)
    const stdio = readIfExists('entrypoints/stdio.ts') ?? server!
    expect(stdio).not.toMatch(/\bstartOutboundConsumer\s*\(/)
  })

  test('3. daemon entrypoint starts the outbound consumer exactly once, gated on isDaemonRuntime', () => {
    // A daemon process owns one consumer loop. The entrypoint calls the
    // starter exactly once; the starter itself still gates on
    // isDaemonRuntime() as a defense-in-depth belt-and-braces check.
    const entry = readIfExists('entrypoints/daemon.ts')
    expect(entry).not.toBeNull()
    const calls = entry!.match(/\bstartOutboundConsumer\s*\(/g) ?? []
    expect(calls.length).toBe(1)
    // The consumer module keeps the runtime gate.
    const src = readIfExists('adapters/outbound-consumer.ts')
    expect(src).not.toBeNull()
    const fn = sliceFn(src!, 'startOutboundConsumer')
    expect(fn).toContain('isDaemonRuntime()')
    expect(fn).toMatch(/if\s*\(\s*!\s*isDaemonRuntime\(\)\s*\)/)
  })

  test('4. getDiscordClient(unknownBotId) returns null and logs — no shared fallback', () => {
    // 2026-04-12 incident chain: `?? discord` (shared fallback) caused
    // identity misattribution when claim SQL raced. The rewrite removes
    // the shared fallback entirely. getDiscordClient must return null
    // for an unknown botId (and log an error so operators notice), not
    // silently hand back the shared adapter.
    const src = readIfExists('adapters/discord-client.ts')
    expect(src).not.toBeNull()
    const fn = sliceFn(src!, 'getDiscordClient')
    // No shared-fallback coalescing.
    expect(fn).not.toMatch(/\?\?\s*discord\b/)
    // Return type includes null (unknown bot → no client).
    expect(src!).toMatch(/getDiscordClient\s*\([^)]*\)\s*:\s*[^=]*\bnull\b/)
    // Error log on miss so operators can diagnose.
    expect(fn).toMatch(/console\.(error|warn)\(/)
    // Outbound consumer's own send path must also remain fallback-free.
    const outbound = readIfExists('adapters/outbound-consumer.ts')
    expect(outbound).not.toBeNull()
    const consumer = sliceFn(outbound!, 'consumeOneOutboundRow')
    expect(consumer).not.toMatch(/\?\?\s*discord\b/)
  })

  test('5. orphan reclaim returns claimed rows to pending with backoff after OUTBOUND_ORPHAN_TIMEOUT_SEC', () => {
    // Plan §3.5 (M1): a stuck 'claimed' row (worker died mid-tick) must
    // be returned to 'pending' after the orphan timeout, but with
    // next_retry_at = now() + backoff(attempts) so the claim race
    // doesn't immediately re-fire against the same row.
    const src = readIfExists('adapters/outbound-consumer.ts')
    expect(src).not.toBeNull()
    const fn = sliceFn(src!, 'reclaimOrphanOutboundRows')
    expect(fn).toContain('OUTBOUND_ORPHAN_TIMEOUT_SEC')
    // Status returns to pending (not stays claimed, not jumps to failed).
    expect(fn).toMatch(/SET[\s\S]*status\s*=\s*'pending'/)
    // WHERE clause targets stuck 'claimed' rows specifically.
    expect(fn).toMatch(/WHERE[\s\S]*status\s*=\s*'claimed'/)
    // Backoff — not a thundering herd re-queue.
    expect(fn).toMatch(/next_retry_at\s*=\s*now\(\)\s*\+/)
    expect(fn).toMatch(/power\(2,\s*greatest\(attempts\s*-\s*1/)
  })

  test('6. outbound send enforces nonce so same-nonce duplicates become a single Discord post', () => {
    // The Discord.js adapter already supports { nonce, enforceNonce }
    // (adapters/discord.ts sendMessage). The consumer must pass the
    // outbound row's nonce through so retries of the same row collapse
    // to one Discord post even if the claim races (defense-in-depth for
    // test #1). Nonce origin = outbound_queue row id (stable per row).
    const src = readIfExists('adapters/outbound-consumer.ts')
    expect(src).not.toBeNull()
    const fn = sliceFn(src!, 'consumeOneOutboundRow')
    // sendMessage/sendAdapterMessage call site carries nonce + enforceNonce.
    expect(fn).toMatch(/nonce\s*:/)
    expect(fn).toMatch(/enforceNonce\s*:\s*true/)
  })

  test('7. inbound routing inserts one message_queue row per mention (ON CONFLICT DO NOTHING)', () => {
    // Plan §6.1 / earlier PR #168: handleInboundMessage must insert into
    // message_queue using ON CONFLICT (agent_id, message_id) DO NOTHING
    // so redelivered Discord events don't create duplicate inbox rows.
    const src = readIfExists('adapters/inbound-receiver.ts')
    expect(src).not.toBeNull()
    const fn = sliceFn(src!, 'handleInboundMessage')
    expect(fn).toMatch(/INSERT\s+INTO\s+message_queue[\s\S]{0,600}?ON\s+CONFLICT[\s\S]{0,300}?DO\s+NOTHING/i)
    // The conflict target is (agent_id, message_id) — per the Phase 2
    // partial-unique index.
    expect(fn).toMatch(/ON\s+CONFLICT[\s\S]{0,200}?\(\s*agent_id\s*,\s*message_id\s*\)/i)
  })

  test('8. bot-registry + watchdog/restart scripts drop --dangerously-load-development-channels', () => {
    // Phase C Step 2: the daemon-owns-outbound rewrite removes the
    // channel-plugin dependency, so the development-channels TUI flag
    // is no longer needed for normal bot startup. Keeping it around
    // risks revived stdio-side consumer wiring.
    const files = [
      'scripts/bot-registry.txt',
      'scripts/restart-bot.sh',
      'scripts/watchdog.sh',
    ]
    for (const rel of files) {
      const body = readIfExists(rel)
      expect(body).not.toBeNull()
      expect(body!.includes('--dangerously-load-development-channels')).toBe(false)
    }
    // server.ts restart_bot fallback (DEFAULT_CLAUDE_CMD) also stays clean.
    const server = readIfExists('server.ts')!
    const line = server.split('\n').find(l => l.trimStart().startsWith('const DEFAULT_CLAUDE_CMD'))
    expect(line).toBeDefined()
    expect(line!.includes('--dangerously-load-development-channels')).toBe(false)
  })

  test('9. adapters barrel exposes the three new modules', () => {
    // adapters/index.ts is the single import site the rest of the repo
    // uses. Pin the public surface so renames/moves break the barrel
    // loudly, not silently.
    const src = readIfExists('adapters/index.ts')
    expect(src).not.toBeNull()
    // discord-client exports.
    expect(src!).toMatch(/from\s+['"]\.\/discord-client(?:\.ts)?['"]/)
    expect(src!).toMatch(/getDiscordClient|connectBotDiscord|refreshAgentCache/)
    // outbound-consumer exports.
    expect(src!).toMatch(/from\s+['"]\.\/outbound-consumer(?:\.ts)?['"]/)
    expect(src!).toMatch(/startOutboundConsumer|stopOutboundConsumer/)
    // inbound-receiver exports.
    expect(src!).toMatch(/from\s+['"]\.\/inbound-receiver(?:\.ts)?['"]/)
    expect(src!).toMatch(/startListener|handleInboundMessage/)
  })
})
