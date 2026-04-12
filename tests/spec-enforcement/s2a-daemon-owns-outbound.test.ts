#!/usr/bin/env bun
/**
 * Spec-enforcement tests for S2-A (FEAT-005): daemon-owns-outbound.
 *
 * Regression class: if anyone re-introduces stdio-side outbound consumer
 * boot, the shared Discord fallback, or reverts the atomic claim SQL,
 * the 2026-04-12 duplicate-Discord-post incident returns. This test
 * suite pins the 3 structural invariants at source level (mirror of
 * s2b-receiver-unify.test.ts).
 *
 * See:
 *   - docs/agent-com-message-queue-spec.md §1 line 39 (daemon owns outbound)
 *   - docs/plans/outbound-forwarder-unification.md
 *   - SSOT-1 FEAT-005 (Refactoring)
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

describe('S2-A (FEAT-005) — daemon-owns-outbound', () => {
  test('1. startOutboundConsumer gates on isDaemonRuntime()', () => {
    const startIdx = SERVER_SRC.indexOf('function startOutboundConsumer')
    expect(startIdx).toBeGreaterThan(-1)
    const section = SERVER_SRC.slice(startIdx, startIdx + 2000)
    expect(section).toContain('isDaemonRuntime()')
    // The gate must skip (early return) when not daemon.
    expect(section).toMatch(/if\s*\(\s*!\s*isDaemonRuntime\(\)\s*\)/)
  })

  test('2. claim SQL atomically flips status to processing + filters agent_id', () => {
    // Atomic claim must include both SET status='processing' and WHERE agent_id=$
    // in the same UPDATE so rows are never left re-claimable.
    const m = SERVER_SRC.match(/UPDATE\s+outbound_queue[\s\S]{0,2000}?RETURNING/)
    expect(m).not.toBeNull()
    const sql = m![0]
    expect(sql).toMatch(/SET[\s\S]*status\s*=\s*'processing'/)
    expect(sql).toMatch(/WHERE[\s\S]*agent_id\s*=\s*\$\d/)
  })

  test('3. claim SQL honors next_retry_at backoff window', () => {
    const m = SERVER_SRC.match(/UPDATE\s+outbound_queue[\s\S]{0,2000}?RETURNING/)
    expect(m).not.toBeNull()
    expect(m![0]).toMatch(/next_retry_at\s+IS\s+NULL\s+OR\s+next_retry_at\s*<=\s*now\(\)/i)
  })

  test('4. outbound send path does NOT use `?? discord` fallback', () => {
    // Fallback was what allowed identity misattribution (row posted under
    // the wrong bot's client). The outbound consumer must resolve the
    // client strictly by row.agent_id / AGENT_ID, no fallback.
    const consumeIdx = SERVER_SRC.indexOf('async function consumeOneOutboundRow')
    expect(consumeIdx).toBeGreaterThan(-1)
    const endIdx = SERVER_SRC.indexOf('async function reclaimOrphanOutboundRows', consumeIdx)
    expect(endIdx).toBeGreaterThan(consumeIdx)
    const consumeFn = SERVER_SRC.slice(consumeIdx, endIdx)
    expect(consumeFn).not.toMatch(/\?\?\s*discord\b/)
  })

  test('5. orphan reclaim function exists + reads OUTBOUND_ORPHAN_TIMEOUT_SEC', () => {
    expect(SERVER_SRC).toContain('function reclaimOrphanOutboundRows')
    expect(SERVER_SRC).toContain('OUTBOUND_ORPHAN_TIMEOUT_SEC')
  })

  test('6. server.ts cites spec §1 line 39 in the outbound consumer comment', () => {
    expect(SERVER_SRC).toMatch(/docs\/agent-com-message-queue-spec\.md\s+§1\s+line\s+39/)
  })
})
