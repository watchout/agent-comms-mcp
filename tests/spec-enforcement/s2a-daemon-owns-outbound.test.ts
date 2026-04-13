#!/usr/bin/env bun
/**
 * Spec-enforcement tests for S2-A (FEAT-005): daemon-owns-outbound.
 *
 * Regression class: if anyone re-introduces stdio-side consumer/poller
 * boot, the shared Discord fallback, or reverts the atomic claim SQL,
 * the 2026-04-12 duplicate-Discord-post incident returns. This test
 * suite pins the structural invariants at source level (mirror of
 * s2b-receiver-unify.test.ts).
 *
 * See:
 *   - docs/agent-com-message-queue-spec.md §1 line 39 (daemon owns
 *     PollingDriver AND outbound_queue consumer)
 *   - docs/plans/outbound-forwarder-unification.md
 *   - SSOT-1 FEAT-005 (Refactoring)
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

/**
 * Slice a top-level `(async) function name(...)` body up to (but not
 * including) the next top-level function. S3 auditor finding: bare-regex
 * matches were not scoped to the consumer and would silently accept
 * regressions elsewhere in the file.
 */
function sliceFn(src: string, name: string): string {
  const startRegex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g')
  const m = startRegex.exec(src)
  if (!m) throw new Error(`sliceFn: ${name} not found`)
  const start = m.index
  const endRegex = /\n(?:async\s+)?function\s+\w+\s*\(/g
  endRegex.lastIndex = start + m[0].length
  const next = endRegex.exec(src)
  return src.slice(start, next ? next.index : src.length)
}

describe('S2-A (FEAT-005) — daemon-owns-outbound', () => {
  test('1. startOutboundConsumer gates on isDaemonRuntime()', () => {
    const fn = sliceFn(SERVER_SRC, 'startOutboundConsumer')
    expect(fn).toContain('isDaemonRuntime()')
    expect(fn).toMatch(/if\s*\(\s*!\s*isDaemonRuntime\(\)\s*\)/)
  })

  test('2. consumeOneOutboundRow claim SQL atomically flips to processing + filters agent_id', () => {
    // Scope assertions to consumeOneOutboundRow so a future unrelated
    // UPDATE outbound_queue elsewhere in server.ts cannot accidentally
    // satisfy this test (S3 auditor fix).
    const fn = sliceFn(SERVER_SRC, 'consumeOneOutboundRow')
    const m = fn.match(/UPDATE\s+outbound_queue[\s\S]{0,2000}?RETURNING/)
    expect(m).not.toBeNull()
    const sql = m![0]
    expect(sql).toMatch(/SET[\s\S]*status\s*=\s*'processing'/)
    expect(sql).toMatch(/WHERE[\s\S]*agent_id\s*=\s*\$\d/)
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/)
  })

  test('3. claim SQL honors next_retry_at backoff window', () => {
    const fn = sliceFn(SERVER_SRC, 'consumeOneOutboundRow')
    const m = fn.match(/UPDATE\s+outbound_queue[\s\S]{0,2000}?RETURNING/)
    expect(m).not.toBeNull()
    expect(m![0]).toMatch(/next_retry_at\s+IS\s+NULL\s+OR\s+next_retry_at\s*<=\s*now\(\)/i)
  })

  test('4. outbound send path forbids both `?? discord` and getDiscordClient() fallback', () => {
    // 2026-04-12 incident chain:
    //   (a) claim SQL race → multiple bots claim same row
    //   (b) getDiscordClient(row.agent_id) ?? discord → shared-client fallback
    //       posts under wrong bot identity.
    // S2-A consumer must resolve the Discord client strictly from
    // discordClients.get(AGENT_ID). Both fallback shapes are banned here;
    // the getDiscordClient helper can still exist for other callers.
    const fn = sliceFn(SERVER_SRC, 'consumeOneOutboundRow')
    expect(fn).not.toMatch(/\?\?\s*discord\b/)
    expect(fn).not.toMatch(/getDiscordClient\s*\(/)
  })

  test('5. orphan reclaim fn exists, reads OUTBOUND_ORPHAN_TIMEOUT_SEC, applies backoff', () => {
    const fn = sliceFn(SERVER_SRC, 'reclaimOrphanOutboundRows')
    expect(fn).toContain('OUTBOUND_ORPHAN_TIMEOUT_SEC')
    // Plan §3.5 (M1 fix): reschedule with next_retry_at = now() + delay(attempts),
    // not now() (which would thundering-herd back into the claim race).
    expect(fn).toMatch(/next_retry_at\s*=\s*now\(\)\s*\+/)
    expect(fn).toMatch(/power\(2,\s*greatest\(attempts\s*-\s*1/)
  })

  test('6. server.ts cites spec §1 line 39 near the outbound consumer', () => {
    expect(SERVER_SRC).toMatch(/docs\/agent-com-message-queue-spec\.md\s+§1\s+line\s+39/)
  })

  test('7. PollingDriver.start gates its poll timer on isDaemonRuntime()', () => {
    // SSOT §1 line 39 places BOTH PollingDriver and outbound_queue under
    // the daemon runtime. Auditor B2: stdio must not spin the poll timer.
    const classIdx = SERVER_SRC.indexOf('class PollingDriver')
    expect(classIdx).toBeGreaterThan(-1)
    const nextTopLevel = SERVER_SRC.indexOf('\nconst pollingDriver', classIdx)
    const body = SERVER_SRC.slice(classIdx, nextTopLevel === -1 ? undefined : nextTopLevel)
    expect(body).toContain('isDaemonRuntime()')
    // The pollTimer assignment must be behind the gate; heartbeatTimer
    // stays for all runtimes so we only assert the gate wraps pollTimer.
    expect(body).toMatch(/isDaemonRuntime\(\)[\s\S]*?this\.pollTimer\s*=\s*setInterval/)
  })

  test('8. bot-registry.txt every non-comment row carries AGENT_COM_RUNTIME=daemon', () => {
    const registry = readFileSync(join(REPO_ROOT, 'scripts', 'bot-registry.txt'), 'utf-8')
    const rows = registry.split('\n').filter(line => line.trim().length > 0 && !line.trim().startsWith('#'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const parts = row.split('|')
      expect(parts.length).toBeGreaterThanOrEqual(5)
      const command = parts.slice(4).join('|')
      expect(command).toContain('AGENT_COM_RUNTIME=daemon')
    }
  })

  test('9. restart-bot.sh DEFAULT_CMD carries AGENT_COM_RUNTIME=daemon', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'restart-bot.sh'), 'utf-8')
    const line = script.split('\n').find(l => l.trimStart().startsWith('DEFAULT_CMD='))
    expect(line).toBeDefined()
    expect(line!).toContain('AGENT_COM_RUNTIME=daemon')
  })
})
