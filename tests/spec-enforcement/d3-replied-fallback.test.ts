import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER_SOURCE = readFileSync(join(__dirname, '..', '..', 'server.ts'), 'utf8')

describe('ADR-048 Phase 0 D3 — status="replied" fallback by reply_to', () => {
  test('send tool UPDATE path contains current_message_id primary branch', () => {
    expect(SERVER_SOURCE).toMatch(
      /UPDATE message_queue SET status = 'replied', replied_at = now\(\), replied_with = \$1 WHERE id = \$2/,
    )
  })

  test('send tool falls back to (agent_id, message_id, status IN pending/read) when current_message_id is NULL', () => {
    expect(SERVER_SOURCE).toMatch(
      /UPDATE message_queue SET status = 'replied', replied_at = now\(\), replied_with = \$1[\s\S]*?WHERE agent_id = \$2 AND message_id = \$3 AND status IN \('pending', 'read'\)/,
    )
  })

  test('fallback is gated on reply_to being present (else if reply_to)', () => {
    expect(SERVER_SOURCE).toMatch(/else if \(reply_to\)/)
  })

  test('fallback failure is non-fatal (caught + stderr log, send response not blocked)', () => {
    expect(SERVER_SOURCE).toMatch(/D3 fallback replied transition failed \(non-fatal\)/)
  })
})
