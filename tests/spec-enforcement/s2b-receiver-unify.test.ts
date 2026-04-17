#!/usr/bin/env bun
/**
 * Spec-enforcement tests for ADR-041 S2-B (PR#157) + Phase C I3 update:
 * Both stdio and daemon modes are valid inbound entry points.
 * daemon mode now calls handleInboundMessage from its shared Discord adapter.
 * Dedup safety: processedIds (in-process) + uq_mq_agent_message UNIQUE (DB)
 * prevent double processing when both stdio and daemon co-deploy.
 *
 * History:
 *   - PR#157: daemon was outbound-only, stdio was the sole inbound source.
 *   - Phase C I3: daemon is now self-sufficient; onMessage → handleInboundMessage.
 *
 * See:
 *   - docs/agent-com-message-queue-spec.md §2
 *   - ~/Developer/tech-lead/docs/decisions/archive/041-receiver-messagebus-architecture.md
 *   - https://github.com/watchout/agent-comms-mcp/pull/157
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

describe('ADR-041 S2-B + Phase C I3 — inbound receiver entry points', () => {
  test('handleInboundMessage is invoked from exactly two callsites (stdio + daemon)', () => {
    // Phase C I3: both stdio and daemon modes call handleInboundMessage.
    // Dedup: processedIds (in-process) + uq_mq_agent_message UNIQUE (DB).
    const invocations = SERVER_SRC.match(/handleInboundMessage\(\{/g) ?? []
    expect(invocations.length).toBe(2)
  })

  test('the handleInboundMessage callsite is inside the stdio-mode branch', () => {
    const stdioBranchIdx = SERVER_SRC.indexOf("TRANSPORT_MODE !== 'daemon'")
    expect(stdioBranchIdx).toBeGreaterThan(-1)
    const callsite = SERVER_SRC.indexOf('handleInboundMessage({')
    expect(callsite).toBeGreaterThan(stdioBranchIdx)
  })

  test('daemon block DOES invoke handleInboundMessage (Phase C I3)', () => {
    // Phase C I3: daemon shared Discord adapter now calls handleInboundMessage
    // for full inbound routing. Dedup prevents double processing.
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    expect(daemonIdx).toBeGreaterThan(-1)
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    expect(daemonSection).toContain('handleInboundMessage({')
  })

  test('daemon block does NOT bind per-bot Discord onMessage', () => {
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    expect(daemonSection).not.toContain('botDiscord.onMessage(')
  })

  test('daemon shared onMessage calls both handleInboundMessage and sendHumanWarning (Phase C I3)', () => {
    // Phase C I3: daemon shared-client onMessage now calls handleInboundMessage
    // for full inbound routing AND sendHumanWarning for §2.2 Pattern A.
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    const sharedIdx = daemonSection.indexOf('discord.onMessage(')
    expect(sharedIdx).toBeGreaterThan(-1)
    // Extract the handler body: from onMessage( to the matching `})`.
    const open = daemonSection.indexOf('{', sharedIdx)
    let depth = 1
    let i = open + 1
    while (i < daemonSection.length && depth > 0) {
      const c = daemonSection[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      i++
    }
    const handlerBody = daemonSection.slice(sharedIdx, i)
    expect(handlerBody).toContain('handleInboundMessage')
    expect(handlerBody).toContain('sendHumanWarning')
  })

  test('daemon per-bot Discord client is still created for outbound', () => {
    const daemonIdx = SERVER_SRC.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SRC.slice(daemonIdx, daemonIdx + 25000)
    expect(daemonSection).toContain('connectBotDiscord(botId,')
    expect(daemonSection).toContain('discordClients.set(botId')
  })

  test('ADR-041 S2-B is referenced in server comments', () => {
    expect(SERVER_SRC).toMatch(/ADR-041 S2-B/)
    expect(SERVER_SRC).toContain('handleInboundMessage')
  })
})
