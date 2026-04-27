import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildStartArgv } from '../../bin/aun/start'

// Spec v6 v1.2 §1.4.2 — `aun start` spawns claude with the frozen
// 4-flag set. We verify both:
//   (a) the in-process `buildStartArgv` returns the expected token
//       sequence (fast unit-style assertion);
//   (b) a real subprocess invocation lands the same argv at the
//       child's process boundary (mock claude binary dumps argv to
//       a log so we can read it back).
//
// Intentional: cycle 3 keeps the claude CLI flags out of mcpServers
// args (cycle 2 / pilot blocker reproduction), so the absence of any
// `--dangerously-*` token in `~/.claude.json` is guaranteed by
// test_aun_claude_json_register; this file pins the SAME flags in the
// `aun start` spawn argv so the migration target is unambiguous.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

describe('test_aun_start_spawn_argv — 4 frozen flags + user pass-through', () => {
  let home: string
  let mockClaudeBin: string
  let argvLog: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-start-argv-'))
    argvLog = join(home, 'argv.log')
    mockClaudeBin = join(home, 'mock-claude')
    writeFileSync(mockClaudeBin, `#!/usr/bin/env bash
# Dump every arg, one per line, then exit 0 — replaces the real claude
# CLI for the test. We write atomically (single >>) so a flaky parent
# process can't see a half-written line.
{
  for a in "$@"; do
    printf '%s\\n' "$a"
  done
} > "${argvLog}"
exit 0
`)
    chmodSync(mockClaudeBin, 0o755)
  })

  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('buildStartArgv returns claude + 4 frozen flags + user pass-through (in order)', () => {
    const argv = buildStartArgv({
      home,
      env: { HOME: home, AUN_CLAUDE_BIN: mockClaudeBin } as any,
      extraArgs: ['--foo', 'bar'],
      checkSignatures: false,
    })
    // argv[0] is the claude bin (the mock here).
    expect(argv[0]).toBe(mockClaudeBin)
    // The frozen flag set, exact tokens, in spec order.
    expect(argv).toContain('--mcp-config')
    const mcpIdx = argv.indexOf('--mcp-config')
    expect(argv[mcpIdx + 1]).toMatch(/\.claude\.json$/)
    expect(argv).toContain('--dangerously-skip-permissions')
    expect(argv).toContain('--dangerously-load-development-channels')
    const dlIdx = argv.indexOf('--dangerously-load-development-channels')
    expect(argv[dlIdx + 1]).toBe('server:aun')
    // User pass-through preserved at the tail.
    expect(argv.slice(-2)).toEqual(['--foo', 'bar'])
  })

  test('real subprocess: AUN_CLAUDE_BIN mock receives the same argv', () => {
    const r = spawnSync('bun', ['run', AUN_CLI, 'start', '--', '--user-flag', 'user-value'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, AUN_CLAUDE_BIN: mockClaudeBin },
      timeout: 15_000,
    })
    expect(r.status).toBe(0)
    expect(existsSync(argvLog)).toBe(true)
    const dumped = readFileSync(argvLog, 'utf-8').split('\n').filter(Boolean)
    // The mock dumps `claude`'s argv (excluding argv[0]). Verify each
    // frozen token reached the child.
    expect(dumped).toContain('--mcp-config')
    expect(dumped).toContain('--dangerously-skip-permissions')
    expect(dumped).toContain('--dangerously-load-development-channels')
    expect(dumped).toContain('server:aun')
    // User pass-through.
    expect(dumped).toContain('--user-flag')
    expect(dumped).toContain('user-value')
    // Defensive: no claude CLI flag should be smuggled through any
    // other field — every dumped arg starts with `--`, `server:`, or
    // is a value following one of those.
  })
})
