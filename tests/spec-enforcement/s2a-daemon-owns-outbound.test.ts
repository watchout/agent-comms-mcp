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
      // Cycle-4 rigor: the env assignment must be the shell *prefix* of
      // the command, not just present somewhere. A mid-line match would
      // silently accept regressions like `claude ... AGENT_COM_RUNTIME=daemon`
      // (treating it as a stray argument, which does NOT propagate to the
      // process env the way a prefix assignment does).
      expect(command.trimStart()).toMatch(/^AGENT_COM_RUNTIME=daemon\s+/)
    }
  })

  test('9. restart-bot.sh DEFAULT_CMD carries AGENT_COM_RUNTIME=daemon as prefix', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'restart-bot.sh'), 'utf-8')
    const line = script.split('\n').find(l => l.trimStart().startsWith('DEFAULT_CMD='))
    expect(line).toBeDefined()
    // Cycle-4 rigor: env assignment is the first token inside the quotes,
    // not a substring elsewhere in the fallback command.
    expect(line!).toMatch(/^\s*DEFAULT_CMD\s*=\s*["']AGENT_COM_RUNTIME=daemon\s+/)
  })

  test('10. watchdog.sh DEFAULT_CMD carries AGENT_COM_RUNTIME=daemon as prefix', () => {
    // Auditor cycle-3 CONDITIONAL: watchdog is the autonomous restart
    // path; its fallback DEFAULT_CMD is the last line of defense when a
    // registry row is malformed or missing. Must not revert to no-env.
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'watchdog.sh'), 'utf-8')
    const line = script.split('\n').find(l => l.trimStart().startsWith('DEFAULT_CMD='))
    expect(line).toBeDefined()
    // Cycle-4 rigor: position-pinned env prefix.
    expect(line!).toMatch(/^\s*DEFAULT_CMD\s*=\s*["']AGENT_COM_RUNTIME=daemon\s+/)
  })

  test('12. stdio postConnect registers AGENT_ID → shared discord in discordClients Map', () => {
    // Hotfix regression guard: PR #164 removed the `?? discord` fallback
    // in consumeOneOutboundRow, but the per-bot `discordClients` populate
    // path is gated on TRANSPORT_MODE === 'daemon'. Fleet bots run with
    // AGENT_COM_RUNTIME=daemon + TRANSPORT_MODE=stdio (default), so the
    // Map stayed empty and every outbound row failed with
    // 'no_discord_client_for_agent' (85% → 1% drop, 2026-04-13).
    //
    // In stdio/channel-plugin mode each process is a single-bot daemon
    // whose shared `discord` adapter is connected with that bot's own
    // DISCORD_BOT_TOKEN. Registering it under AGENT_ID is the only
    // populate path in that mode; lose this line and outbound dies again.
    const callIdx = SERVER_SRC.indexOf('await discord.connect({')
    expect(callIdx).toBeGreaterThan(-1)
    // Look only at the code that runs after the shared adapter finishes
    // connecting — a `discordClients.set(AGENT_ID, ...)` earlier in the
    // file (e.g. the daemon SSE handler) does not satisfy the stdio path.
    const afterConnect = SERVER_SRC.slice(callIdx, callIdx + 2000)
    expect(afterConnect).toMatch(/discordClients\.set\(\s*AGENT_ID\s*,\s*discord\s*\)/)
  })

  test('11. server.ts DEFAULT_CLAUDE_CMD (restart_bot MCP tool fallback) carries AGENT_COM_RUNTIME=daemon as prefix', () => {
    // Auditor cycle-3 CONDITIONAL: restart_bot MCP tool falls back to
    // DEFAULT_CLAUDE_CMD when a registry row parses with an empty
    // COMMAND field. That fallback must also carry the env.
    // Cycle-4 rigor: pin position — env assignment is the first token
    // inside the string literal, not somewhere in the argument tail.
    const line = SERVER_SRC
      .split('\n')
      .find(l => l.trimStart().startsWith('const DEFAULT_CLAUDE_CMD'))
    expect(line).toBeDefined()
    expect(line!).toMatch(/^\s*const\s+DEFAULT_CLAUDE_CMD\s*=\s*["']AGENT_COM_RUNTIME=daemon\s+/)
  })

  test('13. consumeOneOutboundRow force-releases the re-entrancy guard after OUTBOUND_TICK_TIMEOUT_MS', () => {
    // Regression class: the 2026-04-13 CTO wedged-consumer incident. An
    // awaited call (Discord REST or `pg` query) never settled, so the
    // try/finally never ran and `outboundConsumerInFlight` stayed true
    // for ~2 hours while rows piled up at `pending, attempts=0`. The
    // tick must therefore arm a setTimeout that releases the guard
    // independently of the awaited work, and must clearTimeout when the
    // normal path completes so the guard is not double-released into a
    // later unrelated tick.
    const fn = sliceFn(SERVER_SRC, 'consumeOneOutboundRow')
    // The budget constant is defined at module scope (not inside the fn)
    // but the fn must reference it to schedule the release.
    expect(fn).toContain('OUTBOUND_TICK_TIMEOUT_MS')
    // setTimeout arms the watchdog, its callback clears the guard.
    expect(fn).toMatch(
      /setTimeout\([\s\S]{0,400}?outboundConsumerInFlight\s*=\s*false/,
    )
    // The finally MUST clearTimeout the watchdog handle so a fast-path
    // completion does not leave a stale timer that later clears the
    // guard mid-way through a subsequent (legitimate) tick.
    expect(fn).toMatch(/finally[\s\S]{0,200}?clearTimeout\(/)
    // The module-scope constant itself has a safety floor so a misconfig
    // (e.g. OUTBOUND_TICK_TIMEOUT_MS=0) cannot disable the watchdog.
    expect(SERVER_SRC).toMatch(
      /OUTBOUND_TICK_TIMEOUT_MS\s*=\s*Math\.max\(\s*[\s\S]{0,20}?\d[\d_]*\s*,/,
    )
  })
})
