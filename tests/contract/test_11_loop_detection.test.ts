#!/usr/bin/env bun
/**
 * B8 runaway loop detection contract test.
 *
 * Spec: docs/B8-loop-detection-spec-amendment-v0.md (DRAFT v0.2)
 * Instruction: lead-ama v4 6-section
 *   - §0/§1/§3/§4/§5/route: notify ec7cd6e7 / 8803b6b5 / 348ff72b /
 *     d9295a49 / 202faf58 / 81cb5994 (v2)
 *   - §2 (a)-(f),(h)-(j): notify 47d67c21 / 3ee22d0f (v3 spec ref)
 *   - §2 (g): notify 673e606e (v4 line-grain)
 *
 * The test is a unit test against the helper modules — `bun:test`
 * imports the symmetric pair (`detectLoop` from `scripts/lib/loop-
 * detector.ts` + `appendSendError` from `scripts/lib/send-error-log.ts`)
 * directly. spec §2.5 + auditor A2 say the shell is a thin caller for
 * both, so shelling out is unnecessary; that also keeps the merge
 * gate deterministic across environments (no shell / jq drift).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectLoop, type LoopDetectorEnv, type ReplyChainEntry } from '../../scripts/lib/loop-detector'
import { appendSendError } from '../../scripts/lib/send-error-log'

const DEFAULT_ENV: LoopDetectorEnv = {
  maxReplyChainDepth: 10,
  maxPairBounce: 3,
  maxSelfInChain: 3,
}

// Concise builder so a `chain('A','B','A')` call composes a 3-entry
// reply chain. Empty / undefined entries simulate the parser-couldn't-
// attribute case and exercise the §2 (a)-(b) skip rule.
function chain(...entries: (string | undefined | null | { from?: string })[]): ReplyChainEntry[] {
  return entries.map(e => {
    if (e === undefined || e === null) return {}
    if (typeof e === 'string') return { from: e }
    return e
  })
}

describe('B8 detectLoop — Layer 1 / 2 / 3 detection', () => {
  test('T1 — A↔B 3 round bounce ⇒ pair_bounce', () => {
    // (A,B) pair occurs at indices 0,2,4 = 3 times. With
    // MAX_PAIR_BOUNCE=3 the third occurrence trips L2 immediately.
    const v = detectLoop(chain('A', 'B', 'A', 'B', 'A', 'B'), 'me', DEFAULT_ENV)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.subReason).toBe('pair_bounce')
      expect(v.detail).toMatch(/A,B/)
    }
  })

  test('T2 — A→B→C→A→B→C cycle ⇒ pair_bounce ((A,B) hits 2)', () => {
    // (A,B) pair appears at indices 0 and 3 = 2 times. With
    // MAX_PAIR_BOUNCE=2 we expect L2 to trip exactly there.
    const v = detectLoop(
      chain('A', 'B', 'C', 'A', 'B', 'C'),
      'me',
      { ...DEFAULT_ENV, maxPairBounce: 2 },
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.subReason).toBe('pair_bounce')
  })

  test('T3 — A→A→A→A self consecutive 4 ⇒ self_chain', () => {
    const v = detectLoop(chain('A', 'A', 'A', 'A'), 'me', DEFAULT_ENV)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.subReason).toBe('self_chain')
  })

  test('T4 — linear chain depth 11 ⇒ depth_exceeded', () => {
    const c = chain('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K')
    const v = detectLoop(c, 'me', DEFAULT_ENV)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.subReason).toBe('depth_exceeded')
  })

  test('T5 — incident pattern arc↔adf-lead 5+ bounce ⇒ pair_bounce', () => {
    const c = chain(
      'arc', 'adf-lead', 'arc', 'adf-lead', 'arc', 'adf-lead',
      'arc', 'adf-lead', 'arc', 'adf-lead',
    )
    const v = detectLoop(c, 'arc', DEFAULT_ENV)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      // Either L1 or L2 may trip first depending on threshold ordering;
      // the spec eval order is L1 → L2 → L3, so depth 10 entries means
      // L1 trips first (length 10 >= maxReplyChainDepth 10).
      expect(['depth_exceeded', 'pair_bounce']).toContain(v.subReason)
    }
  })

  test('C5 (CTO Q4) — linear depth 10 ⇒ depth_exceeded (boundary)', () => {
    // 10 entries, all distinct → L2 won't fire (every pair count = 1).
    // L1 trips on length 10 >= maxReplyChainDepth 10.
    const c = chain('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J')
    const v = detectLoop(c, 'me', DEFAULT_ENV)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.subReason).toBe('depth_exceeded')
  })
})

describe('B8 detectLoop — false-positive prevention', () => {
  test('N1 — 4-bot 1-turn discussion (depth 8) ⇒ ok', () => {
    const v = detectLoop(
      chain('arc', 'cto', 'auditor', 'ceo', 'arc', 'cto', 'auditor', 'ceo'),
      'me',
      DEFAULT_ENV,
    )
    // Each ordered pair appears at most twice — under MAX_PAIR_BOUNCE=3.
    // Length 8 < 10 ⇒ L1 does not fire. ⇒ ok.
    expect(v.ok).toBe(true)
  })

  test('N2 — A→B→C→D linear new agents (depth 4) ⇒ ok', () => {
    const v = detectLoop(chain('A', 'B', 'C', 'D'), 'me', DEFAULT_ENV)
    expect(v.ok).toBe(true)
  })

  test('N3 — A↔B 2 bounce (Q→A→follow-up→ack) ⇒ ok', () => {
    // (A,B) pair count = 2 < 3, length 4 < 10 ⇒ ok.
    const v = detectLoop(chain('A', 'B', 'A', 'B'), 'me', DEFAULT_ENV)
    expect(v.ok).toBe(true)
  })

  test('N4 (CTO Q4) — linear depth 9 boundary ⇒ ok', () => {
    const c = chain('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I')
    const v = detectLoop(c, 'me', DEFAULT_ENV)
    expect(v.ok).toBe(true)
  })

  test('N5 — A→A→B→A→A→B (self pairs mixed, ARC v0.1) ⇒ ok', () => {
    // L2 self-pair exclusion ⇒ (A,A) pairs ignored. The non-self pair
    // (A,B) at indices 1→2 and 4→5 hits 2 < 3 ⇒ L2 ok. The longest
    // consecutive A run is 2 < 3 ⇒ L3 ok. Length 6 < 10 ⇒ L1 ok.
    const v = detectLoop(chain('A', 'A', 'B', 'A', 'A', 'B'), 'me', DEFAULT_ENV)
    expect(v.ok).toBe(true)
  })
})

describe('B8 detectLoop — missing-from skip (D1, D2)', () => {
  test('D1 — empty-string from is skipped, valid length used', () => {
    // 11 raw entries but one has from='' ⇒ valid length 10 ⇒ depth_exceeded.
    // The skip is what keeps the count honest; without it a noisy parser
    // could push valid length past the cap and flip the verdict.
    const c: ReplyChainEntry[] = [
      ...chain('A', 'B', 'C', 'D', 'E'),
      { from: '' },
      ...chain('F', 'G', 'H', 'I', 'J'),
    ]
    const v = detectLoop(c, 'me', DEFAULT_ENV)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.subReason).toBe('depth_exceeded')
  })

  test('D2 — entry with no `from` field at all is skipped', () => {
    // Same shape as D1 but the empty-from is replaced with an entry
    // that simply lacks the field. The skip rule applies regardless of
    // whether the parser yielded `''` or no key.
    const c: ReplyChainEntry[] = [
      ...chain('A', 'B', 'C', 'D'),
      {},  // missing field entirely
      ...chain('E', 'F', 'G', 'H'),
    ]
    const v = detectLoop(c, 'me', DEFAULT_ENV)
    // 8 valid entries < 10, no pair >= 3, no consecutive run >= 3 ⇒ ok.
    expect(v.ok).toBe(true)
  })
})

describe('B8 detectLoop — env override (E1, E2)', () => {
  test('E1 — maxReplyChainDepth=4 + chain depth 5 ⇒ depth_exceeded', () => {
    const v = detectLoop(
      chain('A', 'B', 'C', 'D', 'E'),
      'me',
      { ...DEFAULT_ENV, maxReplyChainDepth: 4 },
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.subReason).toBe('depth_exceeded')
  })

  test('E2 — maxPairBounce=2 + Q&A 2 bounce ⇒ pair_bounce (operator emergency tuning)', () => {
    const v = detectLoop(
      chain('A', 'B', 'A', 'B'),
      'me',
      { ...DEFAULT_ENV, maxPairBounce: 2 },
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.subReason).toBe('pair_bounce')
  })
})

describe('B8 appendSendError — observability (L1, L2, L3)', () => {
  let workdir: string

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'b8-send-error-log-'))
  })
  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  test('L1 — 3 calls produce 3 lines, each carrying ISO + attempt + exit + stderr', async () => {
    const logPath = join(workdir, 'l1.log')
    await appendSendError(logPath, 1, 1, 'connection refused')
    await appendSendError(logPath, 2, 2, 'timeout 30s')
    await appendSendError(logPath, 3, 3, 'unknown host')
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines.length).toBe(3)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // ISO 8601 prefix.
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/)
      expect(line).toContain(`[send-attempt ${i + 1}]`)
      expect(line).toContain(`[exit ${i + 1}]`)
    }
    expect(lines[0]).toContain('connection refused')
    expect(lines[1]).toContain('timeout 30s')
    expect(lines[2]).toContain('unknown host')
  })

  test('L2 — log path under a missing parent dir auto-creates and appends', async () => {
    // The parent dir does not yet exist; the helper runs `mkdir -p`
    // before the append (test L2 in spec §6.4 + instruction §4 L2).
    const logPath = join(workdir, 'nested', 'deep', 'l2.log')
    expect(existsSync(logPath)).toBe(false)
    await appendSendError(logPath, 1, 99, 'boom')
    expect(existsSync(logPath)).toBe(true)
    const body = readFileSync(logPath, 'utf8')
    expect(body).toContain('[send-attempt 1]')
    expect(body).toContain('[exit 99]')
    expect(body).toContain('boom')
  })

  test('L3 — unwritable target rejects (caller catches via shell || true)', async () => {
    // Create a read-only directory, then attempt to write below it.
    // The helper resolves the parent dir and calls `mkdir -p`; the
    // mkdir itself will fail under permission denied, which surfaces
    // as a Promise rejection — the spec contract for `appendSendError`.
    const ro = join(workdir, 'readonly')
    writeFileSync(join(workdir, '.placeholder'), '')  // ensure workdir exists
    require('node:fs').mkdirSync(ro, { recursive: true })
    chmodSync(ro, 0o500)
    const logPath = join(ro, 'subdir', 'l3.log')
    let threw = false
    try {
      await appendSendError(logPath, 1, 1, 'should fail')
    } catch {
      threw = true
    } finally {
      // Restore mode so afterAll cleanup works.
      chmodSync(ro, 0o700)
    }
    expect(threw).toBe(true)
  })
})
