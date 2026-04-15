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

  test('2. stdio entrypoint only starts the outbound consumer after discordClients.set, gated on AGENT_COM_RUNTIME=daemon (phasing)', () => {
    // FEAT-005 original invariant: daemon owns outbound. stdio-mode
    // processes (MCP plugin) must never bootstrap consumeOneOutboundRow
    // ticks, or the 19-bot race returns. Enforced at both call-site
    // and runtime gate.
    //
    // 2026-04-14 phasing revival (CEO directive Task 1, post-PR-#172,
    // auditor cycle 2 startup-order fix): production launch path is
    // `claude server:agent-comms` → server.ts (stdio MCP) with
    // AGENT_COM_RUNTIME=daemon set in the shell. entrypoints/daemon.ts
    // has no supervise wrapper yet, so server.ts is allowed to *also*
    // call startOutboundConsumer when it observes the daemon flag.
    //
    // Placement matters: the call must sit AFTER
    // `discordClients.set(AGENT_ID, discord)` so the first tick can
    // find a Discord client. Cycle 1 placed it inside registerAgent()
    // and lost the race (discord.connect hadn't resolved yet), flipping
    // every row to `status='failed',
    // last_error='no_discord_client_for_agent'`. registerAgent() now
    // holds NO startOutboundConsumer call.
    //
    // Future: when supervise base for entrypoints/daemon.ts ships,
    // remove the server.ts call and restore the strict daemon-only
    // invariant.
    const server = readIfExists('server.ts')
    expect(server).not.toBeNull()
    // registerAgent holds no startOutboundConsumer call.
    const regIdx = server!.search(/async\s+function\s+registerAgent\s*\(/)
    expect(regIdx).toBeGreaterThan(-1)
    const regEnd = server!.indexOf('\nasync function ', regIdx + 1)
    const regSlice = server!.slice(regIdx, regEnd === -1 ? undefined : regEnd)
    expect(regSlice).not.toMatch(/\bstartOutboundConsumer\s*\(/)
    // Any call in server.ts must appear AFTER
    // `discordClients.set(AGENT_ID, discord)` in source order and sit
    // inside an isDaemonRuntime() guard.
    const calls = [...server!.matchAll(/startOutboundConsumer\s*\(/g)]
    if (calls.length > 0) {
      const setIdx = server!.indexOf('discordClients.set(AGENT_ID, discord)')
      expect(setIdx).toBeGreaterThan(-1)
      for (const m of calls) {
        expect(m.index!).toBeGreaterThan(setIdx)
      }
      expect(server!).toMatch(
        /if\s*\(\s*isDaemonRuntime\(\)\s*\)\s*\{[^}]*startOutboundConsumer\s*\(/,
      )
    }
  })

  test('3. daemon entrypoint starts the outbound consumer exactly once, gated on isDaemonRuntime', () => {
    // A daemon process owns one consumer loop. The entrypoint calls the
    // starter exactly once; the starter itself still gates on
    // isDaemonRuntime() as a defense-in-depth belt-and-braces check.
    //
    // 2026-04-14 phasing note: entrypoints/daemon.ts remains the
    // canonical single-call site. server.ts is allowed to call the
    // starter when AGENT_COM_RUNTIME=daemon (see test #2 phasing
    // note), because a single OS process runs either daemon.ts OR
    // server.ts per agent_id, never both. When the supervise base
    // for daemon.ts ships, server.ts call is removed and this test
    // becomes the sole source of truth again.
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
    // NOTE: outbound consumer's own send path is guarded separately in
    // test #6 (same file) because that module lands in CP3.
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
    // The consumer's Discord-client resolution must not fall back to the
    // shared `discord` adapter — identity misattribution was the root
    // cause of the 2026-04-12 incident (CTO directive 2.4).
    expect(fn).not.toMatch(/\?\?\s*discord\b/)
  })

  test('7. inbound routing inserts one message_queue row per mention (ON CONFLICT DO NOTHING)', () => {
    // Plan §6.1 / earlier PR #168: handleInboundMessage must insert into
    // message_queue using ON CONFLICT (agent_id, message_id) DO NOTHING
    // so redelivered Discord events don't create duplicate inbox rows.
    // Issue #177: the INSERT moved into persistInboundDelivery
    // (core/inbound-delivery.ts) so 7b UPDATE + 7d INSERT can share one
    // BEGIN/COMMIT. The handler still owns the decision to invoke it.
    const handler = readIfExists('adapters/inbound-receiver.ts')
    expect(handler).not.toBeNull()
    const fn = sliceFn(handler!, 'handleInboundMessage')
    // handler delegates to persistInboundDelivery (Issue #177 helper).
    expect(fn).toMatch(/persistInboundDelivery\s*\(/)

    const helper = readIfExists('core/inbound-delivery.ts')
    expect(helper).not.toBeNull()
    // The helper body contains the INSERT + ON CONFLICT DO NOTHING pin.
    expect(helper!).toMatch(/INSERT\s+INTO\s+message_queue[\s\S]{0,600}?ON\s+CONFLICT[\s\S]{0,300}?DO\s+NOTHING/i)
    // The conflict target is (agent_id, message_id) — per the Phase 2
    // partial-unique index.
    expect(helper!).toMatch(/ON\s+CONFLICT[\s\S]{0,200}?\(\s*agent_id\s*,\s*message_id\s*\)/i)
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

  test('10. db/migrate.ts forward migration renames claim vocabulary atomically', () => {
    // CP-3 migration invariants:
    //   - CHECK installs the new vocabulary (pending/claimed/sent/failed)
    //   - UPDATE migrates in-flight rows from the old vocabulary
    //   - Partial-index WHERE predicate follows 'claimed'
    //   - Entire block sits inside BEGIN … COMMIT so DDL + UPDATE land
    //     in a single transaction (no window with a stale CHECK or
    //     orphan rows that violate either vocabulary).
    const src = readIfExists('db/migrate.ts')
    expect(src).not.toBeNull()
    // Locate the last CHECK on outbound_queue.status (the forward-
    // migration one) and assert it does not list 'processing'.
    const checkMatches = src!.match(/CHECK\s*\(\s*status\s+IN[^)]*\)/g) ?? []
    expect(checkMatches.length).toBeGreaterThan(0)
    const forwardCheck = checkMatches[checkMatches.length - 1]!
    expect(forwardCheck).toMatch(/'pending'[\s\S]*'claimed'[\s\S]*'sent'[\s\S]*'failed'/)
    expect(forwardCheck).not.toContain("'processing'")
    // WHERE predicate intentionally relaxed so a future guard like
    //   WHERE status='processing' AND created_at < now() - interval '1 day'
    // does not false-negative this pin (CTO guidance 2026-04-14).
    expect(src!).toMatch(/UPDATE\s+outbound_queue\s+SET\s+status\s*=\s*'claimed'\s+WHERE\s+[^;]*?'processing'/i)
    // Partial-index predicate must follow the new vocabulary.
    expect(src!).toMatch(/idx_outbound_queue_claimed_claimed_at[\s\S]*WHERE\s+status\s*=\s*'claimed'/)
    // Single-transaction invariant: UPDATE sits inside BEGIN/COMMIT.
    expect(src!).toMatch(/BEGIN;[\s\S]*UPDATE\s+outbound_queue[\s\S]*COMMIT;/)
    // Down migration lives at its documented path and is symmetric.
    const down = readIfExists('db/rollback-claim-vocabulary.sql')
    expect(down).not.toBeNull()
    expect(down!).toMatch(/UPDATE\s+outbound_queue\s+SET\s+status\s*=\s*'processing'\s+WHERE\s+[^;]*?'claimed'/i)
    expect(down!).toMatch(/BEGIN;[\s\S]*COMMIT;/)
  })

  test('11. db/migrate.ts only runs migrate() when invoked directly (guardrail 2)', () => {
    // Guardrail 2 (CP-6): top-level migrate() invocation is wrapped in
    // `if (import.meta.main)` so merely importing the module (tools,
    // tests, editor IDE features) does NOT apply the migration. Prior
    // unguarded top-level call caused the 2026-04-14 accidental DB
    // apply during a backtick parse-check.
    const src = readIfExists('db/migrate.ts')
    expect(src).not.toBeNull()
    expect(src!).toMatch(/if\s*\(\s*import\.meta\.main\s*\)\s*\{[\s\S]*?migrate\(\)/)
    // There must be no unguarded top-level migrate() at module scope.
    // Accept the call ONLY inside the import.meta.main block.
    const unguarded = src!.match(/^migrate\(\)/m)
    expect(unguarded).toBeNull()
  })
})
