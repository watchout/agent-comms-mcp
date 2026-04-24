import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

// Spec v5 §2.2 / §3.1 — Codex/Gemini bot fallback. Bots that run under
// a runtime without claude/channel support (Codex CLI, Gemini CLI, any
// non-Claude-Code session) must continue to receive messages via the
// existing wake-daemon polling + pull-based `next` tool. The claude/
// channel push is purely additive and its absence must not degrade the
// pre-existing delivery path.
// Instruction: lead-ama PR-A §4.2 (msg id fa219381) / Issue #39 ref.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('test_10_codex_gemini_fallback — wake-daemon + `next` remain the Codex/Gemini path', () => {
  test('wake-daemon is still shipped and is NOT deleted by PR-A (Forbidden §3.1 #4)', () => {
    // PR-A must not delete wake-daemon code; the file is required for
    // non-Claude-Code runtimes. The daemon watches message_queue INSERTs
    // (NOTIFY or polling) and drives the tmux wake — the downstream
    // `next` tool call is what actually reads 'pending' rows.
    const daemon = readFileSync(join(REPO_ROOT, 'bin', 'wake-daemon.ts'), 'utf-8')
    expect(daemon).toContain('message_queue')
    expect(daemon).toMatch(/LISTEN|SELECT/)
  })

  test('`next` MCP tool remains registered in server.ts (pull-based fallback)', () => {
    const src = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
    // §1.5 existing tools unchanged — name:'next' registration stays.
    expect(src).toMatch(/name:\s*['"]next['"]/)
    // Description must still advertise pull-based pop; the Codex/Gemini
    // bot relies on this prompt text to invoke the tool.
    expect(src).toMatch(/Pop the next pending message/i)
  })

  test('InboundReceiverDeps.mcpPush is optional — undefined is a legal Codex/Gemini config', () => {
    const src = readFileSync(join(REPO_ROOT, 'adapters', 'inbound-receiver.ts'), 'utf-8')
    // The `?` after mcpPush in the Deps interface means a Codex/Gemini
    // server can simply skip wiring it and the listener will take the
    // pull-only path (observability signal + wake-daemon fallback).
    expect(src).toMatch(/mcpPush\?:/)
    // The listener body guards every push with `if (d.mcpPush)`.
    expect(src).toMatch(/if \(d\.mcpPush\)/)
  })

  test('push failure handler documents wake-daemon fallback intent (future-reader guard)', () => {
    const src = readFileSync(join(REPO_ROOT, 'adapters', 'inbound-receiver.ts'), 'utf-8')
    // The stderr on push failure explicitly names "wake-daemon fallback"
    // so any refactor that removes this branch fails this invariant.
    expect(src).toContain('wake-daemon fallback')
  })
})
