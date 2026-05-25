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
// FEAT-005 CP-2/CP-3 (adapter rewrite 2026-04-14): the outbound
// consumer, PollingDriver, and per-bot Discord lookup moved out of
// server.ts into adapters/outbound-consumer.ts + adapters/discord-
// client.ts. Tests #1-#7, #12, #13 now pin the invariants at their
// new home; tests #8-#11 still target the shell scripts + server.ts
// fallback command. Concat the three source files so a single
// SERVER_SRC fires every substring pin regardless of location.
//
// bot-registry.txt + restart-bot.sh + watchdog.sh are read
// separately inside tests #8-#10 (not concatenated here).
const SERVER_SRC =
  readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(REPO_ROOT, 'adapters', 'outbound-consumer.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(REPO_ROOT, 'adapters', 'discord-client.ts'), 'utf-8')

/**
 * Slice a top-level `(async) function name(...)` body up to (but not
 * including) the next top-level function. S3 auditor finding: bare-regex
 * matches were not scoped to the consumer and would silently accept
 * regressions elsewhere in the file.
 */
function sliceFn(src: string, name: string): string {
  // CP-3: relaxed to match an optional leading `export` because the
  // extracted adapters/*.ts modules export their top-level functions.
  const startRegex = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g')
  const m = startRegex.exec(src)
  if (!m) throw new Error(`sliceFn: ${name} not found`)
  const start = m.index
  const endRegex = /\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/g
  endRegex.lastIndex = start + m[0].length
  const next = endRegex.exec(src)
  return src.slice(start, next ? next.index : src.length)
}

describe('S2-A (FEAT-005) — daemon-owns-outbound', () => {
  test('1. startOutboundConsumer starts unconditionally (only OUTBOUND_QUEUE_CONSUMER=0 kills it)', () => {
    // Phase C I4: dual mode removed. isDaemonRuntime() no longer
    // exists; the consumer starts unconditionally. The only kill
    // switch is OUTBOUND_QUEUE_CONSUMER=0.
    const fn = sliceFn(SERVER_SRC, 'startOutboundConsumer')
    expect(fn).not.toContain('isDaemonRuntime')
    expect(fn).toMatch(/OUTBOUND_QUEUE_CONSUMER\s*===\s*'0'/)
  })

  test('2. consumeOneOutboundRow claim SQL atomically flips to claimed + filters adapter owner', () => {
    // Scope assertions to consumeOneOutboundRow so a future unrelated
    // UPDATE outbound_queue elsewhere cannot accidentally satisfy
    // this test (S3 auditor fix).
    // CP-3 (2026-04-14): vocabulary 'processing' → 'claimed'. Same
    // atomic-flip invariant, renamed to match the claim SQL verb.
    const fn = sliceFn(SERVER_SRC, 'consumeOneOutboundRow')
    const m = fn.match(/UPDATE\s+outbound_queue[\s\S]{0,2000}?RETURNING/)
    expect(m).not.toBeNull()
    const sql = m![0]
    expect(sql).toMatch(/SET[\s\S]*status\s*=\s*'claimed'/)
    expect(sql).toMatch(/WHERE[\s\S]*COALESCE\(consumer_agent_id,\s*agent_id\)\s*=\s*\$\d/)
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

  test('7. PollingDriver.start starts poll timer unconditionally (no isDaemonRuntime gate)', () => {
    // Phase C I4: dual mode removed. PollingDriver starts
    // unconditionally; there is no isDaemonRuntime() gate.
    const classIdx = SERVER_SRC.indexOf('class PollingDriver')
    expect(classIdx).toBeGreaterThan(-1)
    const nextTopLevel = SERVER_SRC.indexOf('\nconst pollingDriver', classIdx)
    const body = SERVER_SRC.slice(classIdx, nextTopLevel === -1 ? undefined : nextTopLevel)
    expect(body).not.toContain('isDaemonRuntime')
    // The pollTimer assignment is unconditional inside start().
    expect(body).toMatch(/this\.pollTimer\s*=\s*setInterval/)
  })

  test('8. bot-registry.txt every non-comment row does NOT carry AGENT_COM_RUNTIME prefix (dual mode removed)', () => {
    // Phase C I4: dual mode removed. AGENT_COM_RUNTIME=daemon env
    // prefix is no longer needed — every process is daemon-mode.
    // Restart-phantom-prompt fix (2026-04-21): `server:agent-comms` was
    // being passed as Claude Code CLI's first positional arg and got
    // interpreted as a user prompt, leaving bots stuck at "what to do?"
    // on restart. New invocation is `claude --mcp-config ...` directly.
    const registry = readFileSync(join(REPO_ROOT, 'scripts', 'bot-registry.txt'), 'utf-8')
    const rows = registry.split('\n').filter(line => line.trim().length > 0 && !line.trim().startsWith('#'))
    expect(rows.length).toBeGreaterThan(0)
    const codexBacked = new Set(['codex-audit', 'discord-cto', 'discord-arc', 'discord-secretary', 'discord-aun'])
    for (const row of rows) {
      const parts = row.split('|')
      expect(parts.length).toBeGreaterThanOrEqual(5)
      const [session, projectDir, agentId, port] = parts
      const command = parts.slice(4).join('|')
      expect(command).not.toContain('AGENT_COM_RUNTIME')
      expect(command).not.toContain('server:agent-comms')
      if (session === 'discord-arc') {
        expect(projectDir).toBe('~/Developer/iyasaka-arc')
      }
      if (codexBacked.has(session)) {
        const trimmed = command.trimStart()
        expect(trimmed).toMatch(/^codex\s+--dangerously-bypass-approvals-and-sandbox/)
        expect(trimmed).toContain("mcp_servers.agent-comms.enabled=false")
        expect(trimmed).toContain(`mcp_servers.aun.env.AGENT_ID="${agentId}"`)
        expect(trimmed).toContain(`mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID="${agentId}"`)
        expect(trimmed).toContain('mcp_servers.aun.env.DATABASE_URL="postgresql:///agent_comms?host=/tmp"')
        expect(trimmed).toContain(`mcp_servers.aun.env.WEBHOOK_PORT="${port}"`)
        expect(trimmed).toContain(`mcp_servers.aun.env.DISCORD_STATE_DIR="/Users/yuji/.claude/channels/${session}"`)
      } else {
        expect(command.trimStart()).toMatch(/^claude\s+--mcp-config/)
      }
    }
  })

  test('9. restart-bot.sh DEFAULT_CMD does NOT carry AGENT_COM_RUNTIME prefix (dual mode removed)', () => {
    // Phase C I4: dual mode removed. Restart-phantom-prompt fix
    // (2026-04-21): `server:agent-comms` removed from DEFAULT_CMD.
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'restart-bot.sh'), 'utf-8')
    const line = script.split('\n').find(l => l.trimStart().startsWith('DEFAULT_CMD='))
    expect(line).toBeDefined()
    expect(line!).not.toContain('AGENT_COM_RUNTIME')
    expect(line!).not.toContain('server:agent-comms')
    expect(line!).toMatch(/^\s*DEFAULT_CMD\s*=\s*["']claude\s+--mcp-config/)
  })

  test('10. restart-bot.sh avoids accepting Codex update prompts during automated restarts', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'restart-bot.sh'), 'utf-8')
    const step5 = script.slice(
      script.indexOf('# Step 5: Wait for TUI prompt and auto-confirm'),
      script.indexOf('echo "[restart-bot] ${SESSION} started'),
    )

    expect(step5).toContain('tmux capture-pane -pt "$SESSION"')
    expect(step5).toContain("grep -qE '(^|[[:space:]])codex([[:space:]]|$)'")
    expect(step5).toContain('grep -q "Update now"')
    expect(step5).toContain('tmux send-keys -t "$SESSION" 2 Enter')
    expect(step5).toContain('tmux send-keys -t "$SESSION" Enter')
  })

  test('10b. sync-mcp-config.sh pins identity, DB socket, and server checkout', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'sync-mcp-config.sh'), 'utf-8')

    expect(script).toContain('AGENT_COM_EXPECTED_AGENT_ID')
    expect(script).toContain('postgresql:///agent_comms?host=/tmp')
    expect(script).toContain('AGENT_COMMS_SERVER_PATH')
    expect(script).toContain('endsWith(\'/server.ts\')')
    expect(script).toContain('DATABASE_URL')
    expect(script).toContain('DATABASE_URL: updated')
    expect(script).not.toContain("oldDb||'(none)'")
  })

  test('10c. restart-bot.sh resolves the DB bot profile before bot-registry fallback', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'restart-bot.sh'), 'utf-8')
    const dbLoadIdx = script.indexOf('load_db_profile || true')
    const registryIdx = script.indexOf('# Try to resolve from registry')

    expect(dbLoadIdx).toBeGreaterThan(-1)
    expect(registryIdx).toBeGreaterThan(-1)
    expect(dbLoadIdx).toBeLessThan(registryIdx)
    expect(script).toContain('FROM agents')
    expect(script).toContain("metadata->>'tmux_session'")
    expect(script).toContain('runtime_engine_preference')
    expect(script).toContain('PROFILE_SOURCE="agents.profile"')
    expect(script).toContain('refusing registry fallback to avoid drift')
    expect(script).toContain('build_profile_command "$AGENT_ID" "$SESSION" "$PORT"')
    expect(script).toContain('AGENT_COMMS_RESTART_DRY_RUN')
  })

  test('11. watchdog.sh DEFAULT_CMD does NOT carry AGENT_COM_RUNTIME prefix (dual mode removed)', () => {
    // Phase C I4: dual mode removed. Restart-phantom-prompt fix
    // (2026-04-21): `server:agent-comms` removed from DEFAULT_CMD.
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'watchdog.sh'), 'utf-8')
    const line = script.split('\n').find(l => l.trimStart().startsWith('DEFAULT_CMD='))
    expect(line).toBeDefined()
    expect(line!).not.toContain('AGENT_COM_RUNTIME')
    expect(line!).not.toContain('server:agent-comms')
    expect(line!).toMatch(/^\s*DEFAULT_CMD\s*=\s*["']claude\s+--mcp-config/)
  })

  test('12. stdio postConnect registers AGENT_ID → shared discord in discordClients Map', () => {
    // Hotfix regression guard: PR #164 removed the `?? discord` fallback
    // in consumeOneOutboundRow, but the per-bot `discordClients` populate
    // path was gated on TRANSPORT_MODE === 'daemon' (removed in Phase C I5).
    // Phase C I5: unified flow always populates discordClients via shared startup, so the
    // Map stayed empty and every outbound row failed with
    // 'no_discord_client_for_agent' (85% → 1% drop, 2026-04-13).
    //
    // Phase C I5: unified flow — the shared `discord` adapter is connected
    // with this bot's DISCORD_BOT_TOKEN. Registering it under AGENT_ID
    // in discordClients is required; lose this line and outbound dies.
    const callIdx = SERVER_SRC.indexOf('await discord.connect({')
    expect(callIdx).toBeGreaterThan(-1)
    // Look only at the code that runs after the shared adapter finishes
    // connecting — a `discordClients.set(AGENT_ID, ...)` earlier in the
    // file (e.g. the daemon SSE handler) does not satisfy the stdio path.
    const afterConnect = SERVER_SRC.slice(callIdx, callIdx + 2000)
    expect(afterConnect).toMatch(/discordClients\.set\(\s*AGENT_ID\s*,\s*discord\s*\)/)
  })

  test('13. server.ts DEFAULT_CLAUDE_CMD does NOT carry AGENT_COM_RUNTIME prefix (dual mode removed)', () => {
    // Phase C I4: dual mode removed. Restart-phantom-prompt fix
    // (2026-04-21): `server:agent-comms` removed from DEFAULT_CLAUDE_CMD.
    const line = SERVER_SRC
      .split('\n')
      .find(l => l.trimStart().startsWith('const DEFAULT_CLAUDE_CMD'))
    expect(line).toBeDefined()
    expect(line!).not.toContain('AGENT_COM_RUNTIME')
    expect(line!).not.toContain('server:agent-comms')
    expect(line!).toMatch(/^\s*const\s+DEFAULT_CLAUDE_CMD\s*=\s*["']claude\s+--mcp-config/)
  })

  test('13b. MCP lifecycle bot inventory reads DB bot profiles before registry compatibility fallback', () => {
    const loader = sliceFn(SERVER_SRC, 'loadBotRegistry')
    expect(loader).toMatch(/SELECT\s+agent_id,\s+home_directory,\s+channel_port/i)
    expect(loader).toContain('metadata')
    expect(loader).toContain('COALESCE(profile_enabled, true)')
    expect(loader).toContain('fileByAgent')
    expect(loader).toContain('fallback?.command')
    expect(SERVER_SRC).toContain('bot-registry.compat')
    expect(SERVER_SRC).toContain('process.env.AGENT_COMMS_DATABASE_URL ?? config.database_url ?? DEFAULT_AUN_DATABASE_URL')

    const handler = SERVER_SRC.slice(SERVER_SRC.indexOf("if (name === 'restart_bot')"), SERVER_SRC.indexOf("if (name === 'cleanup_ports')"))
    expect(handler).toContain('await loadBotRegistry()')
    expect(handler).toContain('bot profile inventory')
  })

  test('14. consumeOneOutboundRow force-releases the re-entrancy guard after OUTBOUND_TICK_TIMEOUT_MS', () => {
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
