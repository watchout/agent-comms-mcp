import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Spec v6 §4.1 — real `npx aun` CLI invocation contract test.
// PR #242 cycle 1 🟡-4 fix (auditor msg e14e10ea): the original test
// suite exercised library functions directly. This file boots the
// `bun bin/aun.ts` CLI as a real subprocess and asserts:
//   - `aun --help` exits 0 with the spec'd usage banner
//   - `aun status` exits 0 against an unconfigured tmp HOME
//   - `aun init --dry-run --token <fake> --skip-version-check
//      --skip-executable-bit-check` runs end-to-end, prints the diff
//     summary, and writes nothing
//
// Real fs + real CLI per §3.4 (mock 禁止). Tests use Node's
// `spawnSync` (already a dep) — Bun's spawn API would also work but
// the dependency-free path keeps this portable.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

function runAun(args: string[], homeOverride: string): ReturnType<typeof spawnSync> {
  return spawnSync('bun', ['run', AUN_CLI, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: homeOverride,
      DISCORD_BOT_TOKEN: '',
    },
    timeout: 20_000,
  })
}

describe('test_aun_cli_real_invocation — npx-style CLI invocation, not library calls', () => {
  let home: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-cli-real-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), '{}\n')
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('aun --help exits 0 and prints the spec usage banner', () => {
    const r = runAun(['--help'], home)
    expect(r.status).toBe(0)
    const out = r.stdout ?? ''
    expect(out).toContain('aun init')
    expect(out).toContain('aun start')
    expect(out).toContain('aun uninstall')
    expect(out).toContain('aun status')
  })

  test('aun status exits 0 on a fresh HOME and reports "missing" / "no" markers', () => {
    const r = runAun(['status'], home)
    expect(r.status).toBe(0)
    const out = r.stdout ?? ''
    expect(out).toContain('aun home')
    expect(out).toContain('hooks registered')
  })

  test('aun init --dry-run runs end-to-end, prints diff JSON, writes nothing', () => {
    const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')
    const r = runAun(
      ['init', '--dry-run', '--token', 'cli-real-token', '--skip-version-check', '--skip-executable-bit-check', '--skip-claude-mcp-add'],
      home,
    )
    expect(r.status).toBe(0)
    const out = r.stdout ?? ''
    // Dry-run prints both the summary line AND the structured JSON diff.
    expect(out).toMatch(/dry-run.*change\(s\) would be applied/)
    expect(out).toContain('--- dry-run diff ---')
    // settings.json untouched.
    const after = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')
    expect(after).toBe(before)
  })

  test('aun init without --token aborts with the spec §1.2 step 6 error message', () => {
    // Token absent on every documented surface (flag, env, .env file).
    const r = runAun(
      ['init', '--skip-version-check', '--skip-claude-mcp-add', '--skip-executable-bit-check'],
      home,
    )
    expect(r.status).toBe(1)
    const err = r.stderr ?? ''
    expect(err).toContain('Discord token')
  })
})
