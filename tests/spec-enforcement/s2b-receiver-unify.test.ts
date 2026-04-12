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
  test('handleInboundMessage is invoked from exactly one callsite', () => {
    // handleInboundMessage (message_queue INSERT + routing) must be called
    // from only one onMessage handler — the stdio-mode adapter.
    const invocations = SERVER_SRC.match(/handleInboundMessage\(\{/g) ?? []
    expect(invocations.length).toBe(1)
  })

  test('the handleInboundMessage callsite is inside the stdio-mode branch', () => {
    const stdioBranchIdx = SERVER_SRC.indexOf("TRANSPORT_MODE !== 'daemon'")
    expect(stdioBranchIdx).toBeGreaterThan(-1)
    const callsite = SERVER_SRC.indexOf('handleInboundMessage({')
    expect(callsite).toBeGreaterThan(stdioBranchIdx)
  })

  test('daemon block does NOT invoke handleInboundMessage', () => {
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    expect(daemonIdx).toBeGreaterThan(-1)
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    expect(daemonSection).not.toContain('handleInboundMessage({')
  })

  test('daemon block does NOT bind per-bot Discord onMessage', () => {
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    expect(daemonSection).not.toContain('botDiscord.onMessage(')
  })

  test('daemon shared onMessage (if present) only emits sendHumanWarning', () => {
    // daemon retains a shared-client onMessage for §2.2 Pattern A only.
    // It must NOT call handleInboundMessage nor write to message_queue.
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    const sharedIdx = daemonSection.indexOf('discord.onMessage(')
    if (sharedIdx >= 0) {
      const handlerBody = daemonSection.slice(sharedIdx, sharedIdx + 2000)
      expect(handlerBody).toContain('sendHumanWarning')
      expect(handlerBody).not.toContain('handleInboundMessage')
      expect(handlerBody).not.toContain('message_queue')
    }
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
