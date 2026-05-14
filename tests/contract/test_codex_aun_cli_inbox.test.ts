import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')

describe('codex-aun CLI inbox runtime primitives', () => {
  test('CLI exposes inbox, processing, and done commands', () => {
    expect(CLI_SRC).toContain("command === 'inbox'")
    expect(CLI_SRC).toContain("command === 'processing'")
    expect(CLI_SRC).toContain("command === 'done'")
    expect(CLI_SRC).toContain('codex-aun manual inbox')
  })

  test('inbox claims pending rows as received with claim ownership', () => {
    const start = CLI_SRC.indexOf('async function inboxMessage')
    const end = CLI_SRC.indexOf('async function transitionQueueMessage')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const fn = CLI_SRC.slice(start, end)

    expect(fn).toContain("WHERE status = 'pending' AND agent_id = $1")
    expect(fn).toContain('FOR UPDATE SKIP LOCKED')
    expect(fn).toContain("SET status = 'received'")
    expect(fn).toContain('claimed_by = $1')
    expect(fn).toContain('claim_expires_at = $2')
    expect(fn).toContain("status = 'received'")
    expect(fn).toContain('queue_id')
    expect(fn).toContain('message_id')
    expect(fn).toContain('content')
  })

  test('processing and done preserve the v0.9 lifecycle', () => {
    const start = CLI_SRC.indexOf('async function transitionQueueMessage')
    expect(start).toBeGreaterThan(-1)
    const fn = CLI_SRC.slice(start, start + 5000)

    expect(fn).toContain("const fromStatus = command === 'processing' ? 'received' : 'in_progress'")
    expect(fn).toContain("const toStatus = command === 'processing' ? 'in_progress' : 'done'")
    expect(fn).toContain("status = 'done', done_at = now()")
    expect(fn).toContain('AGENT_MISMATCH')
    expect(fn).toContain('INVALID_STATE')
    expect(fn).toContain('already_transitioned')
  })
})
