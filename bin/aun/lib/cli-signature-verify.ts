/**
 * CLI signature drift detector (spec v6 §2.3 / §3.1 #6).
 *
 * Lesson learned from PR #236 cycle 4 — the `notify` CLI silently
 * gained a required `--channel` flag, and downstream tests that
 * quoted the pre-flag usage spec-verbatim only failed at the final
 * operator pilot. This module keeps a stored baseline of each
 * dependency CLI's `--help` / `--version` output so a later
 * `aun start` run can compare and warn the user (informational only;
 * never block). The baseline lives at
 * `~/.aun/cli-baselines.json` by default (overridable for tests).
 *
 * Scope (what this module is NOT):
 *   - It does not parse semantics. A drift is any textual change to
 *     `--help` that affects the part we captured.
 *   - It is never a merge gate. Drift is a warning, the user decides
 *     whether to rerun `aun init` or ignore.
 *   - It runs real CLIs only (spec §3.4 forbids mocking `--help`
 *     invocations in tests).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ClaudeCliProbe {
  name: string
  command: string
  args: string[]
  /** Optional regex — only the matched substring is compared. If
   *  omitted the full stdout is captured (noisier, drift-prone).
   */
  capture?: RegExp
}

export interface CliSignature {
  name: string
  command: string
  args: string[]
  capturedAt: string
  capture: string
}

export interface BaselineFile {
  version: 1
  signatures: CliSignature[]
}

const DEFAULT_BASELINE_PATH = `${process.env.HOME ?? ''}/.aun/cli-baselines.json`

/**
 * Default probes — the dependency CLIs whose signatures aun cares
 * about. `aun init` captures these on first run and writes the
 * baseline; subsequent `aun start` runs re-capture and compare.
 */
export const DEFAULT_PROBES: ClaudeCliProbe[] = [
  // `bun --version` is stable enough that capturing just the version
  // line is useful — any drift is a real version bump.
  { name: 'bun', command: 'bun', args: ['--version'] },
  { name: 'node', command: 'node', args: ['--version'] },
  // claude's help surface is richer; capture the `Options:` header
  // plus the first ~30 lines so flag additions / renames surface.
  {
    name: 'claude',
    command: 'claude',
    args: ['--help'],
    capture: /Usage[\s\S]{0,2000}/,
  },
]

function runProbe(probe: ClaudeCliProbe): string | null {
  // Short timeout so a hung CLI never blocks the caller.
  const r = spawnSync(probe.command, probe.args, {
    encoding: 'utf-8',
    timeout: 5000,
  })
  if (r.status !== 0 && !r.stdout) return null
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  if (probe.capture) {
    const m = out.match(probe.capture)
    return m ? m[0] : null
  }
  return out
}

export function captureSignatures(probes: ClaudeCliProbe[] = DEFAULT_PROBES): CliSignature[] {
  const now = new Date().toISOString()
  const out: CliSignature[] = []
  for (const probe of probes) {
    const captured = runProbe(probe)
    if (captured === null) continue
    out.push({
      name: probe.name,
      command: probe.command,
      args: probe.args,
      capturedAt: now,
      capture: captured,
    })
  }
  return out
}

export function loadBaseline(path: string = DEFAULT_BASELINE_PATH): BaselineFile | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (raw?.version !== 1 || !Array.isArray(raw.signatures)) return null
    return raw as BaselineFile
  } catch {
    return null
  }
}

export function saveBaseline(signatures: CliSignature[], path: string = DEFAULT_BASELINE_PATH): void {
  const body: BaselineFile = { version: 1, signatures }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n')
}

export interface DriftReport {
  drifted: Array<{ name: string; reason: 'added' | 'removed' | 'changed'; diffSummary: string }>
}

/**
 * Compare current signatures to the stored baseline. Every mismatch
 * is accumulated into `drifted[]`. This function is side-effect
 * free — the caller decides whether to warn, update the baseline,
 * or ignore.
 */
export function compareToBaseline(current: CliSignature[], baseline: BaselineFile | null): DriftReport {
  const drifted: DriftReport['drifted'] = []
  if (!baseline) return { drifted }
  const byName = new Map(baseline.signatures.map(s => [s.name, s]))
  const seen = new Set<string>()
  for (const cur of current) {
    seen.add(cur.name)
    const base = byName.get(cur.name)
    if (!base) {
      drifted.push({ name: cur.name, reason: 'added', diffSummary: `no baseline; capture now: ${preview(cur.capture)}` })
      continue
    }
    if (base.capture !== cur.capture) {
      drifted.push({
        name: cur.name,
        reason: 'changed',
        diffSummary: summarizeChange(base.capture, cur.capture),
      })
    }
  }
  for (const [name, base] of byName) {
    if (!seen.has(name)) {
      drifted.push({ name, reason: 'removed', diffSummary: `CLI no longer available; baseline had: ${preview(base.capture)}` })
    }
  }
  return { drifted }
}

function preview(s: string): string {
  const first = s.split('\n')[0] ?? ''
  return first.length > 100 ? first.slice(0, 97) + '...' : first
}

function summarizeChange(before: string, after: string): string {
  // Super-light line-level summary — enough for a warning but not a
  // real diff. Real diff is out of scope for an informational signal.
  const bl = before.split('\n')
  const al = after.split('\n')
  const minLen = Math.min(bl.length, al.length)
  for (let i = 0; i < minLen; i++) {
    if (bl[i] !== al[i]) {
      return `line ${i + 1} changed: "${preview(bl[i])}" → "${preview(al[i])}"`
    }
  }
  if (al.length !== bl.length) {
    return `line count ${bl.length} → ${al.length}`
  }
  return 'unknown change'
}
