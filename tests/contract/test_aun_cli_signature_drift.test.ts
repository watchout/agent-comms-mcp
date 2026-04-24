import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureSignatures,
  saveBaseline,
  loadBaseline,
  compareToBaseline,
  type ClaudeCliProbe,
} from '../../bin/aun/lib/cli-signature-verify'

// Spec v6 §2.3 + §3.1 #6 — CLI signature drift detector (PR #236
// cycle 4 reflection). Real CLIs (bun, node) are invoked; no mock
// --help text is used (§3.4 test anti-pattern).
// Instruction: lead-ama PR-aun-install §4.1 (msg id 521b6038).

describe('test_aun_cli_signature_drift — capture baseline, detect drift vs synthetic baseline', () => {
  let tmpDir: string
  let baselinePath: string
  const probes: ClaudeCliProbe[] = [
    { name: 'bun', command: 'bun', args: ['--version'] },
    { name: 'node', command: 'node', args: ['--version'] },
  ]

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aun-drift-'))
    baselinePath = join(tmpDir, 'cli-baselines.json')
  })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test('captureSignatures() invokes real CLIs (bun, node) and returns non-empty', () => {
    const sigs = captureSignatures(probes)
    // At least bun must be present on this workstation.
    expect(sigs.length).toBeGreaterThanOrEqual(1)
    const bun = sigs.find(s => s.name === 'bun')
    expect(bun).toBeDefined()
    // `bun --version` is a short semver string; assert shape.
    expect(bun?.capture).toMatch(/\d+\.\d+\.\d+/)
  })

  test('saveBaseline + loadBaseline round-trip', () => {
    const sigs = captureSignatures(probes)
    saveBaseline(sigs, baselinePath)
    expect(existsSync(baselinePath)).toBe(true)
    const b = loadBaseline(baselinePath)
    expect(b?.version).toBe(1)
    expect(b?.signatures.length).toBe(sigs.length)
  })

  test('compareToBaseline vs same-data baseline: no drift', () => {
    const sigs = captureSignatures(probes)
    saveBaseline(sigs, baselinePath)
    const baseline = loadBaseline(baselinePath)
    const report = compareToBaseline(sigs, baseline)
    expect(report.drifted).toEqual([])
  })

  test('compareToBaseline vs synthetic drifted baseline: drift reported (PR #236 cycle 4 pattern)', () => {
    const sigs = captureSignatures(probes)
    // Synthesize a prior baseline with a deliberately altered capture
    // for `bun` to simulate the PR #236 kind of drift.
    const driftedBaseline = {
      version: 1 as const,
      signatures: sigs.map(s => (
        s.name === 'bun' ? { ...s, capture: '0.0.0 (fake old version)' } : s
      )),
    }
    const report = compareToBaseline(sigs, driftedBaseline)
    expect(report.drifted.length).toBeGreaterThanOrEqual(1)
    const bunDrift = report.drifted.find(d => d.name === 'bun')
    expect(bunDrift).toBeDefined()
    expect(bunDrift?.reason).toBe('changed')
  })

  test('baseline absence → no drift report (first-ever run is never a warning)', () => {
    const sigs = captureSignatures(probes)
    const report = compareToBaseline(sigs, null)
    expect(report.drifted).toEqual([])
  })
})
