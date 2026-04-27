import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'

// Cycle 4 — install smoke test (lead-ama PR #243 cycle 4 dispatch §4
// merge gate). The placement bug that triggered cycle 4 was exactly
// this: cycle 3 placed `server.ts` standalone, the runtime hit
// MODULE_NOT_FOUND on `./core/db` / `./adapters/*` and the MCP
// server crashed on startup (webb-dev pilot 04-27 14:20 JST).
// The 4 conditions:
//   1. empty install dir (beforeAll rm -rf ~/.claude/plugins/aun/)
//   2. `aun init` hermetic mode (skipClaudeMcpAdd + skipVersionCheck)
//   3. bundled entry spawns without startup error
//   4. no MODULE_NOT_FOUND / ENOENT on relative imports
//
// Heavy real spawn — gated by TEST_AUN_INSTALL_SMOKE=1 (lead-ama §4
// "重い real spawn を避けたい場合は opt-in gate も §5 で可"; default
// runs cover (1)-(2) cheaply and skip (3)-(4)).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SMOKE_OPT_IN = process.env.TEST_AUN_INSTALL_SMOKE === '1'

describe('test_aun_install_smoke — cycle 4 plugin install dir bundle works at runtime', () => {
  let home: string
  let claudeHome: string
  let pluginDir: string
  let bundlePath: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-install-smoke-'))
    claudeHome = join(home, '.claude')
    pluginDir = join(claudeHome, 'plugins', 'aun')
    bundlePath = join(pluginDir, 'server.bundled.js')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(join(claudeHome, 'settings.json'), '{}\n')
    // (1) empty install dir guarantee — no leftover from a prior test.
    rmSync(pluginDir, { recursive: true, force: true })
    expect(existsSync(pluginDir)).toBe(false)
  })

  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('(1)+(2) `aun init` hermetic places bundled entry in empty dir', () => {
    const res = init({
      home,
      claudeHome,
      repoRoot: REPO_ROOT,
      env: { HOME: home, DISCORD_BOT_TOKEN: 'smoke-token' },
      skipVersionCheck: true,
      skipExecutableBitCheck: true,
      skipClaudeMcpAdd: true,
    })
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    expect(existsSync(bundlePath)).toBe(true)
  })

  test.if(SMOKE_OPT_IN)(
    '(3)+(4) bundled entry spawns without MODULE_NOT_FOUND or ENOENT (real spawn, opt-in)',
    async () => {  // 10s budget = 5s observe + 5s teardown/spawn overhead
      // Hermetic env: no DB so the server can't connect, no Discord
      // token so the adapter is disabled, distinct port so we don't
      // collide with a running dev instance. We don't need it to
      // come fully online — we only need to confirm imports resolve
      // and the runtime doesn't bail with MODULE_NOT_FOUND.
      const child = spawn('bun', [bundlePath], {
        env: {
          ...process.env,
          HOME: home,
          AGENT_ID: 'smoke-test-' + process.pid,
          AUN_HOME: join(home, '.aun'),
          WEBHOOK_PORT: '0',                         // ephemeral port
          DATABASE_URL: '',                          // intentionally absent
          DISCORD_BOT_TOKEN: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })

      // Watch ~5s — long enough to surface a startup MODULE_NOT_FOUND,
      // short enough that the test stays under the 10s spec ceiling.
      const exited: Promise<number | null> = new Promise((resolveExit) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 500)
          resolveExit(null)
        }, 5_000)
        child.on('exit', (code) => { clearTimeout(timer); resolveExit(code) })
      })
      const code = await exited

      const combined = stdout + '\n' + stderr
      // (4) — relative import resolution: bundle is self-contained,
      // so any MODULE_NOT_FOUND would be a placement-bug regression.
      expect(combined).not.toMatch(/Cannot find module/i)
      expect(combined).not.toMatch(/MODULE_NOT_FOUND/i)
      expect(combined).not.toMatch(/ERR_MODULE_NOT_FOUND/i)
      // (3) — no top-level startup throw before our SIGTERM. A
      // graceful-ish exit code is fine; what's not fine is a thrown
      // error stack that mentions an unresolved relative path.
      expect(combined).not.toMatch(/Error: Cannot resolve/i)
      expect(combined).not.toMatch(/at .* \(.*\.\/(core|adapters)\//)
      // We expect the server to either still be running (we killed
      // it) or to have exited; both are acceptable here. Code -15
      // (SIGTERM) on Linux maps to null on Bun; allow either.
      expect(code === null || code === 0 || code === 143).toBe(true)
    },
    10_000,
  )

  // Cycle 5 axis 3 — bundle build failure must abort before Step 5a
  // (`claude mcp add`). Otherwise `~/.claude.json` would be mutated
  // to point at a path that doesn't exist, leaving the user to
  // manually clean up after a failed install. We force the failure
  // path by handing init a repoRoot that lacks `server.ts`.
  test('(5) bundle failure aborts init before claude mcp add (no ~/.claude.json mutation)', () => {
    const failHome = mkdtempSync(join(tmpdir(), 'aun-bundle-fail-'))
    const failClaudeHome = join(failHome, '.claude')
    const failClaudeJson = join(failHome, '.claude.json')
    const fakeRepoRoot = mkdtempSync(join(tmpdir(), 'aun-fake-repo-'))
    try {
      mkdirSync(failClaudeHome, { recursive: true })
      writeFileSync(join(failClaudeHome, 'settings.json'), '{}\n')
      // Pre-condition: ~/.claude.json absent so we can prove init
      // didn't write it.
      expect(existsSync(failClaudeJson)).toBe(false)

      const res = init({
        home: failHome,
        claudeHome: failClaudeHome,
        repoRoot: fakeRepoRoot,           // no server.ts here
        env: { HOME: failHome, DISCORD_BOT_TOKEN: 'abort-token' },
        skipVersionCheck: true,
        skipExecutableBitCheck: true,
        // skipClaudeMcpAdd intentionally NOT set — we want to prove
        // that the abort prevents Step 5a from running, not that
        // we asked it to be skipped.
      })

      expect(res.ok).toBe(false)
      expect(res.errors.some((e) => /plugin source missing|plugin bundle failed/.test(e))).toBe(true)
      // Step 5a was never reached — ~/.claude.json must not exist.
      expect(existsSync(failClaudeJson)).toBe(false)
      // settings.json untouched (no patch applied).
      expect(res.settingsChanged).toBe(false)
    } finally {
      rmSync(failHome, { recursive: true, force: true })
      rmSync(fakeRepoRoot, { recursive: true, force: true })
    }
  })
})
