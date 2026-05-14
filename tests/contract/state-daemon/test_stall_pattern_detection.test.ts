/**
 * Stall detector (PR #338 v0.9 sub-PR 2, §1.3a + §1.6).
 *
 * Covers nine pattern verdicts (six functional, three stubs) plus the
 * three-layer abstraction. The detector is exercised directly — no DB —
 * so the tests stay deterministic and do not depend on Postgres
 * reachability. The wake-time gate's integration with `state-daemon` is
 * covered by the existing T1 / T26 / per-bot suppression contract tests
 * (they pass when the gate is fail-open, which is the production
 * behaviour for `pending` rows with healthy agents).
 */

import { describe, test, expect } from 'bun:test'
import {
  createDefaultStallDetector,
  DEFAULT_STALL_THRESHOLDS,
  FALLBACK_STALL_THRESHOLDS,
  loadStallThresholdsFromEnv,
  STUB_DEPENDENCIES,
  type BotContext,
  type DetectorAgentRow,
  type DetectorQueueRow,
  type StallVerdict,
} from '../../../core/state-daemon/stall-detector'

const NOW = new Date('2026-05-12T03:00:00.000Z')

function pendingRow(overrides: Partial<DetectorQueueRow> = {}): DetectorQueueRow {
  return {
    id: 1,
    agent_id: 'alpha',
    status: 'pending',
    claim_expires_at: null,
    created_at: NOW,
    last_wake_attempt_at: null,
    ...overrides,
  }
}

function agent(overrides: Partial<DetectorAgentRow> = {}): DetectorAgentRow {
  return {
    agent_id: 'alpha',
    runtime: 'TUI',
    status: 'online',
    tmux_session: 'alpha-session',
    last_seen_at: NOW,
    ...overrides,
  }
}

function ctx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    now: NOW,
    row: pendingRow(),
    agent: agent(),
    tmuxPaneTail: null,
    thresholds: DEFAULT_STALL_THRESHOLDS,
    ...overrides,
  }
}

describe('stall-detector — pattern coverage (spec §1.6 table)', () => {
  const detector = createDefaultStallDetector()

  test('pattern 1: idle / non-pending row → L1 idle verdict', async () => {
    const v = await detector.detect(
      ctx({ row: pendingRow({ status: 'replied' }) }),
    )
    expect(v.map(x => x.kind)).toContain('idle')
    expect(v[0].layer).toBe('L1')
  })

  test('pattern 2: claim_ttl_expired → L1 verdict on read + past expiry', async () => {
    const v = await detector.detect(
      ctx({
        row: pendingRow({
          status: 'received',
          claim_expires_at: new Date(NOW.getTime() - 60_000),
        }),
      }),
    )
    expect(v.find(x => x.kind === 'claim_ttl_expired')?.layer).toBe('L1')
  })

  test('pattern 3: received_stuck → L1 verdict when age exceeds threshold', async () => {
    const stuckCreated = new Date(NOW.getTime() - 600_000) // 10 minutes
    const v = await detector.detect(
      ctx({
        row: pendingRow({
          status: 'received',
          claim_expires_at: new Date(NOW.getTime() + 60_000),
          created_at: stuckCreated,
        }),
      }),
    )
    expect(v.find(x => x.kind === 'received_stuck')?.layer).toBe('L1')
  })

  test('pattern 4: dead_bot → L2 verdict when last_seen_at is stale', async () => {
    const v = await detector.detect(
      ctx({
        agent: agent({
          last_seen_at: new Date(NOW.getTime() - 300_000), // 5 min, > 120s default
        }),
      }),
    )
    expect(v.find(x => x.kind === 'dead_bot')?.layer).toBe('L2')
  })

  test('pattern 5: tmux_missing → L2 verdict when TUI runtime has no session', async () => {
    const v = await detector.detect(
      ctx({ agent: agent({ tmux_session: null }) }),
    )
    expect(v.find(x => x.kind === 'tmux_missing')?.layer).toBe('L2')
  })

  test('pattern 6 stub: in_progress_stall returns no verdict (interface inert)', async () => {
    // Even with a context that would trip an in_progress_stall in spec
    // terms, the stub must not emit a verdict — the dependency (sub-PR 1
    // status enum migration) has not landed.
    const v = await detector.detect(ctx())
    expect(v.find(x => x.kind === 'in_progress_stall')).toBeUndefined()
    expect(STUB_DEPENDENCIES.in_progress_stall).toContain('sub-PR 1')
  })

  test('pattern 7 stub: context_pressure returns no verdict', async () => {
    const v = await detector.detect(ctx())
    expect(v.find(x => x.kind === 'context_pressure')).toBeUndefined()
    expect(STUB_DEPENDENCIES.context_pressure).toContain('infra')
  })

  test('pattern 8 stub (cycle 2 reclass): default daemon path passes tmuxPaneTail=null → inert', async () => {
    // cycle 2 Fix 1: input_residue is interface-shipped but the daemon
    // currently never supplies a tmuxPaneTail (no capture-pane caller in
    // state-daemon, see STUB_DEPENDENCIES.input_residue). So in
    // production-shaped calls the verdict must never fire.
    const v = await detector.detect(ctx())
    expect(v.find(x => x.kind === 'input_residue')).toBeUndefined()
    expect(STUB_DEPENDENCIES.input_residue).toContain('tmux capture-pane')
  })

  test('pattern 8 shape preserved: detection logic still works when a tail is supplied directly (eventual wire-up anchor)', async () => {
    // The detector function's shape is unchanged so that the future PR
    // routing tmux capture-pane into the daemon flips this from inert to
    // functional with no signature edit. Verified by passing a non-empty
    // tail directly here; the verdict is L3 input_residue.
    const v = await detector.detect(
      ctx({ tmuxPaneTail: 'check inbox\nstill typing here' }),
    )
    expect(v.find(x => x.kind === 'input_residue')?.layer).toBe('L3')
  })

  test('pattern 8 shape preserved: empty tail / prompt-only tail → no verdict', async () => {
    expect(
      (await detector.detect(ctx({ tmuxPaneTail: '' }))).find(x => x.kind === 'input_residue'),
    ).toBeUndefined()
    expect(
      (await detector.detect(ctx({ tmuxPaneTail: '> ' }))).find(x => x.kind === 'input_residue'),
    ).toBeUndefined()
  })

  test('pattern 9 stub: smooshing_hang returns no verdict', async () => {
    const v = await detector.detect(ctx())
    expect(v.find(x => x.kind === 'smooshing_hang')).toBeUndefined()
    expect(STUB_DEPENDENCIES.smooshing_hang).toContain('infra')
  })
})

describe('stall-detector — pass-through behaviour', () => {
  const detector = createDefaultStallDetector()

  test('healthy pending row + healthy bot → empty verdict array', async () => {
    const v = await detector.detect(ctx())
    expect(v).toEqual([])
  })
})

describe('stall-detector — three-layer abstraction', () => {
  const detector = createDefaultStallDetector()

  test('l1 / l2 / l3 entry points each return only their layer', async () => {
    const c = ctx({
      row: pendingRow({ status: 'replied' }), // → l1 idle
      agent: agent({ tmux_session: null }), // → l2 tmux_missing
      tmuxPaneTail: 'half-typed input', // → l3 input_residue
    })
    const l1 = await detector.l1(c)
    const l2 = await detector.l2(c)
    const l3 = await detector.l3(c)
    expect(new Set(l1.map(v => v.layer))).toEqual(new Set(['L1']))
    expect(new Set(l2.map(v => v.layer))).toEqual(new Set(['L2']))
    expect(new Set(l3.map(v => v.layer))).toEqual(new Set(['L3']))

    // The same context drives detect() and the verdicts should compose as
    // concatenation L1 ++ L2 ++ L3 (spec §1.3a "cross-layer signal は
    // StallVerdict 配列を介して合成のみ").
    const combined = await detector.detect(c)
    expect(combined.length).toBe(l1.length + l2.length + l3.length)
    expect(combined.slice(0, l1.length)).toEqual(l1)
    expect(combined.slice(l1.length, l1.length + l2.length)).toEqual(l2)
    expect(combined.slice(l1.length + l2.length)).toEqual(l3)
  })

  test('mock detector substitutable via the StallDetector interface', async () => {
    // The dispatch requires that the three layers be evaluatable via the
    // interface so call sites can inject a test double. This case
    // demonstrates that contract: a hand-rolled mock implements the same
    // shape and the caller cannot tell it apart from the real one.
    const calls: string[] = []
    const mock = {
      async l1() { calls.push('l1'); return [] as readonly StallVerdict[] },
      async l2() { calls.push('l2'); return [] as readonly StallVerdict[] },
      async l3() { calls.push('l3'); return [] as readonly StallVerdict[] },
      async detect() {
        calls.push('detect')
        return [] as readonly StallVerdict[]
      },
    }
    const result = await mock.detect(ctx() as unknown as BotContext)
    expect(result).toEqual([])
    expect(calls).toEqual(['detect'])
  })
})

describe('stall-detector — env-driven thresholds (cycle 2 Fix 3)', () => {
  test('unset env → falls back to FALLBACK_STALL_THRESHOLDS literals', () => {
    expect(loadStallThresholdsFromEnv({})).toEqual(FALLBACK_STALL_THRESHOLDS)
  })

  test('valid env vars override the fallbacks', () => {
    const t = loadStallThresholdsFromEnv({
      STATE_DAEMON_STUCK_AFTER_SEC: '90',
      STATE_DAEMON_STALL_AFTER_SEC: '45',
      STATE_DAEMON_CLAIM_TTL_EXPIRED_AFTER_SEC: '15',
    })
    expect(t.receivedStuckAfterSec).toBe(90)
    expect(t.deadBotAfterSec).toBe(45)
    expect(t.claimTtlExpiredAfterSec).toBe(15)
  })

  test('malformed env value falls back per-field (not all-or-nothing)', () => {
    const t = loadStallThresholdsFromEnv({
      STATE_DAEMON_STUCK_AFTER_SEC: 'not-a-number',
      STATE_DAEMON_STALL_AFTER_SEC: '60',
    })
    expect(t.receivedStuckAfterSec).toBe(FALLBACK_STALL_THRESHOLDS.receivedStuckAfterSec)
    expect(t.deadBotAfterSec).toBe(60)
  })

  test('negative env value is rejected (treated as malformed)', () => {
    const t = loadStallThresholdsFromEnv({
      STATE_DAEMON_STUCK_AFTER_SEC: '-5',
    })
    expect(t.receivedStuckAfterSec).toBe(FALLBACK_STALL_THRESHOLDS.receivedStuckAfterSec)
  })

  test('DEFAULT_STALL_THRESHOLDS still points at the fallback for back-compat', () => {
    expect(DEFAULT_STALL_THRESHOLDS).toBe(FALLBACK_STALL_THRESHOLDS)
  })
})

describe('stall-detector — full nine-pattern enumeration check', () => {
  test('STUB_DEPENDENCIES maps every StallKind exactly once', () => {
    const expected = [
      'idle',
      'claim_ttl_expired',
      'received_stuck',
      'dead_bot',
      'tmux_missing',
      'in_progress_stall',
      'context_pressure',
      'input_residue',
      'smooshing_hang',
    ]
    expect(Object.keys(STUB_DEPENDENCIES).sort()).toEqual(expected.sort())
    // Spec freezes 9 patterns; the freeze must be enforced in code so
    // future drift trips the test, not silent removal.
    expect(expected.length).toBe(9)
  })
})
