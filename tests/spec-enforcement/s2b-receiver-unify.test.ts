#!/usr/bin/env bun
/**
 * Spec-enforcement tests for ADR-041 S2-B (PR#157): unify inbound receiver
 * to a single process (stdio mode). daemon mode inbound handlers are removed;
 * daemon retains per-bot Discord clients for outbound + admin only.
 *
 * Regression class: if anyone re-introduces a daemon-side onMessage binding
 * (per-bot OR shared), handleInboundMessage fires 2-3× per Discord message,
 * causing duplicate message_queue INSERTs that this test suite is the last
 * line of defense against.
 *
 * See:
 *   - docs/agent-com-message-queue-spec.md §2 原則 #2 (受信は1プロセス)
 *   - ~/Developer/tech-lead/docs/decisions/archive/041-receiver-messagebus-architecture.md
 *   - https://github.com/watchout/agent-comms-mcp/pull/157
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

describe('ADR-041 S2-B — single inbound receiver entry point', () => {
  test('server.ts binds exactly one Discord onMessage handler', () => {
    const matches = SERVER_SRC.match(/\.onMessage\(\(msg\)\s*=>/g) ?? []
    expect(matches.length).toBe(1)
  })

  test('the sole onMessage handler is inside the stdio-mode branch', () => {
    const stdioBranchIdx = SERVER_SRC.indexOf("TRANSPORT_MODE !== 'daemon'")
    expect(stdioBranchIdx).toBeGreaterThan(-1)
    const firstBinding = SERVER_SRC.indexOf('.onMessage((msg) =>')
    expect(firstBinding).toBeGreaterThan(stdioBranchIdx)
  })

  test('daemon block contains no Discord inbound binding', () => {
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    expect(daemonIdx).toBeGreaterThan(-1)
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    expect(daemonSection).not.toContain('botDiscord.onMessage(')
    expect(daemonSection).not.toContain('discord.onMessage(')
  })

  test('handleInboundMessage is invoked from exactly one onMessage callsite', () => {
    // handleInboundMessage is defined once and called once from an inbound
    // handler. Definition + single call = 2 textual occurrences in server.ts
    // (excluding comments). We assert the invocation count specifically.
    const invocations = SERVER_SRC.match(/handleInboundMessage\(\{/g) ?? []
    expect(invocations.length).toBe(1)
  })

  test('daemon per-bot Discord client is still created for outbound', () => {
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    expect(daemonSection).toContain('connectBotDiscord(botId,')
    expect(daemonSection).toContain('discordClients.set(botId')
  })

  test('spec §2 原則 #2 (受信は1プロセス) is referenced in server comments', () => {
    expect(SERVER_SRC).toMatch(/ADR-041 S2-B/)
    expect(SERVER_SRC).toMatch(/sole inbound source/i)
  })
})
