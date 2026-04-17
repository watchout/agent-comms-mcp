#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Phase C I5: unified process model.
 *
 * Phase C I5 merged all TRANSPORT_MODE branches (stdio/daemon/sse/receiver)
 * into a single unconditional flow. There is now exactly ONE handleInboundMessage
 * callsite in the shared startup block.
 *
 * History:
 *   - PR#157: daemon was outbound-only, stdio was the sole inbound source.
 *   - Phase C I3: daemon is now self-sufficient; onMessage -> handleInboundMessage.
 *   - Phase C I5: unified flow; single callsite.
 *
 * See:
 *   - docs/agent-com-message-queue-spec.md §2, §5.3
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

describe('Phase C I5 — unified inbound receiver (single callsite)', () => {
  test('handleInboundMessage is invoked from exactly one callsite (unified flow)', () => {
    // Phase C I5: single callsite in the shared startup block.
    const invocations = SERVER_SRC.match(/handleInboundMessage\(\{/g) ?? []
    expect(invocations.length).toBe(1)
  })

  test('TRANSPORT_MODE constant is removed', () => {
    // Phase C I5: no more TRANSPORT_MODE branching.
    expect(SERVER_SRC).not.toContain("const TRANSPORT_MODE = ")
    expect(SERVER_SRC).not.toContain("const IS_RECEIVER_MODE = ")
  })

  test('unified shared startup calls handleInboundMessage', () => {
    // The shared startup block (unconditional async IIFE) calls handleInboundMessage.
    const sharedStartupIdx = SERVER_SRC.indexOf('// --- 2. Shared startup (unconditional) ---')
    expect(sharedStartupIdx).toBeGreaterThan(-1)
    const sharedSection = SERVER_SRC.slice(sharedStartupIdx)
    expect(sharedSection).toContain('handleInboundMessage({')
  })

  test('unified shared startup calls sendHumanWarning', () => {
    const sharedStartupIdx = SERVER_SRC.indexOf('// --- 2. Shared startup (unconditional) ---')
    const sharedSection = SERVER_SRC.slice(sharedStartupIdx)
    expect(sharedSection).toContain('sendHumanWarning')
  })

  test('per-bot Discord client is still created for outbound', () => {
    expect(SERVER_SRC).toContain('connectBotDiscord(botId,')
    expect(SERVER_SRC).toContain('discordClients.set(botId')
  })

  test('per-bot Discord client does NOT bind onMessage (outbound-only)', () => {
    // The per-bot client creation in the SSE handler should not bind onMessage
    expect(SERVER_SRC).not.toContain('botDiscord.onMessage(')
  })

  test('ADR-041 is referenced in server comments', () => {
    expect(SERVER_SRC).toMatch(/ADR-041/)
    expect(SERVER_SRC).toContain('handleInboundMessage')
  })
})
