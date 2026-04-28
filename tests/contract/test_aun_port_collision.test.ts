import { describe, test, expect, afterEach } from 'bun:test'
import { spawn } from 'node:child_process'
import * as net from 'node:net'
import { resolve } from 'node:path'

// Issue #248 — port 8789 default fix.
//
// Before this fix every plugin-form install of agent-comms defaulted
// WEBHOOK_PORT to 8789 (CTO bot's port), so concurrent installs ended
// up fighting over the same socket and triggered the orphan-kill path
// against each other. Result: cascade-disconnect of unrelated MCP
// servers (observed 04-27, CTO directive `ef1f522b`).
//
// New resolution priority (§2 Required, frozen):
//   AUN_WEBHOOK_PORT > WEBHOOK_PORT > free-port detection (8801-8900;
//     8800 reserved for SSE_PORT default since cycle 2)
// Range exhausted → throw mentioning AUN_WEBHOOK_PORT so the operator
// knows the escape hatch.
//
// These are real-spawn tests because the resolution lives at module
// top-level in `server.ts` and §3 freezes that file as the only edit
// site (so we can't extract a unit-testable helper to another module).
// Heavy path is gated behind TEST_AUN_PORT_COLLISION=1 (same opt-in
// pattern as test_aun_install_smoke.test.ts).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SERVER_TS = resolve(REPO_ROOT, 'server.ts')
const OPT_IN = process.env.TEST_AUN_PORT_COLLISION === '1'

type SpawnResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function occupyPort(port: number): Promise<net.Server | null> {
  // Returns null if port is already in use by something we don't own
  // (e.g. a running bot on 8789). The caller treats null as "the port
  // is occupied — by us or by someone else, doesn't matter for the
  // test's purpose, which is to ensure the resolver doesn't pick it".
  return new Promise((res) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', () => res(null))
    srv.once('listening', () => res(srv))
    srv.listen(port, '127.0.0.1')
  })
}

function closeServer(srv: net.Server): Promise<void> {
  return new Promise((res) => srv.close(() => res()))
}

// Resolve `bun` ahead of time so case (8) can override PATH inside the spawn
// without the spawn itself failing to find the bun binary.
const BUN_PATH = (() => {
  try { return require('child_process').execSync('command -v bun', { encoding: 'utf-8' }).trim() } catch {}
  return process.execPath
})()

function spawnServer(env: Record<string, string | undefined>, observeMs: number): Promise<SpawnResult> {
  return new Promise((res) => {
    const child = spawn(BUN_PATH, [SERVER_TS], {
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })

    let done = false
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return
      done = true
      res({ code, signal, stdout, stderr })
    }

    const timer = setTimeout(() => {
      // Server is supposed to keep running once it logs the bind line.
      // Kill it and treat captured output as the result.
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 500)
      finish(null, null)
    }, observeMs)

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      finish(code, signal)
    })
  })
}

const baseEnv = (port?: string): Record<string, string | undefined> => ({
  AGENT_ID: 'port-test-' + process.pid,
  // Disable everything that would force a real DB / Discord / push round-trip.
  DATABASE_URL: '',
  DISCORD_BOT_TOKEN: '',
  DISCORD_TOKEN: '',
  // We let the server crash later when it tries to register with the DB.
  // All we need is the early stderr line: `bound webhook port N (...)`
  // emitted by `resolveWebhookPort()` before any DB work.
  AUN_WEBHOOK_PORT: undefined,
  WEBHOOK_PORT: port,
})

describe('test_aun_port_collision — Issue #248 port resolution', () => {
  const occupied: net.Server[] = []
  afterEach(async () => {
    while (occupied.length) {
      const s = occupied.pop()!
      await closeServer(s).catch(() => {})
    }
  })

  const ensureBlocked = async (port: number) => {
    // First attempt: try to grab the port ourselves.
    let s = await occupyPort(port)
    if (s) { occupied.push(s); return }
    // null can mean (a) external process holds the port (fine — still blocked)
    // or (b) a previous test's afterEach close is still in flight, in which
    // case the port will free up momentarily. Retry briefly so case 7 doesn't
    // race with the preceding test's cleanup.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 50))
      s = await occupyPort(port)
      if (s) { occupied.push(s); return }
    }
    // Still null after retries — assume external owner, port is genuinely held.
  }

  test.if(OPT_IN)(
    '(1) free-port detection — env unset + 8789 occupied → listens in 8801-8900',
    async () => {
      await ensureBlocked(8789)
      const r = await spawnServer({ ...baseEnv(), WEBHOOK_PORT: undefined }, 4_000)
      const m = r.stderr.match(/bound webhook port (\d+) \(free-port detection\)/)
      expect(m).not.toBeNull()
      const picked = parseInt(m![1], 10)
      expect(picked).toBeGreaterThanOrEqual(8801)
      expect(picked).toBeLessThanOrEqual(8900)
    },
    15_000,
  )

  test.if(OPT_IN)(
    '(2) AUN_WEBHOOK_PORT=8810 → listens on 8810',
    async () => {
      const r = await spawnServer({ ...baseEnv(), AUN_WEBHOOK_PORT: '8810' }, 4_000)
      expect(r.stderr).toMatch(/bound webhook port 8810 \(explicit env\)/)
    },
    15_000,
  )

  test.if(OPT_IN)(
    '(3) WEBHOOK_PORT=8850 (compat) — AUN unset → listens on 8850',
    async () => {
      const r = await spawnServer({ ...baseEnv('8850'), AUN_WEBHOOK_PORT: undefined }, 4_000)
      expect(r.stderr).toMatch(/bound webhook port 8850 \(explicit env\)/)
    },
    15_000,
  )

  test.if(OPT_IN)(
    '(4) range 8801-8900 fully occupied + env unset → exits with AUN_WEBHOOK_PORT hint',
    async () => {
      // Holding every port in the 8801-8900 range as a real listener is
      // the only assertion that matches production semantics — both
      // lsof-hint and bind-probe paths must observe each port as busy.
      for (let p = 8801; p <= 8900; p++) await ensureBlocked(p)
      const r = await spawnServer({ ...baseEnv(), WEBHOOK_PORT: undefined, AUN_WEBHOOK_PORT: undefined }, 6_000)
      const combined = r.stdout + '\n' + r.stderr
      expect(combined).toMatch(/AUN_WEBHOOK_PORT/)
      expect(combined).toMatch(/no free port|range 8801-8900/)
      // Either the throw exited the process non-zero, or the runtime
      // surfaced the error. We don't care which path — only that the
      // resolver didn't silently fall back to 8789.
      expect(combined).not.toMatch(/bound webhook port 8789/)
    },
    30_000,
  )

  test.if(OPT_IN)(
    '(5) orphan-kill non-interference — bot on 8789 survives free-port detection',
    async () => {
      const survivor = await occupyPort(8789)
      if (survivor) occupied.push(survivor)
      // If `survivor` is null, 8789 is already held by an external
      // process — the test is still valid (we observe that the
      // resolver picks 8800+ and doesn't kill anything on 8789).
      const r = await spawnServer({ ...baseEnv(), WEBHOOK_PORT: undefined, AUN_WEBHOOK_PORT: undefined }, 4_000)
      const m = r.stderr.match(/bound webhook port (\d+) \(free-port detection\)/)
      expect(m).not.toBeNull()
      const picked = parseInt(m![1], 10)
      expect(picked).toBeGreaterThanOrEqual(8801)
      // Critically — the orphan-kill log line must NOT have fired
      // against the 8789 owner. Free-port detection is supposed to
      // skip the kill entirely (no env-explicit intent).
      expect(r.stderr).not.toMatch(/killing orphan process .* on port 8789/)
      if (survivor) expect(survivor.listening).toBe(true)
    },
    15_000,
  )

  test.if(OPT_IN)(
    '(6) case 2b: SSE_PORT collision avoidance — EXPECTED_BOTS set + WEBHOOK_PORT unset must not pick 8800',
    async () => {
      // Cycle 2 — lead-ama L1 hidden impact (msg `fdab4db0`). When
      // MULTI_BOT_MODE is on (EXPECTED_BOTS set or AGENT_COMMS_PORT set)
      // the SSE server later binds AGENT_COMMS_PORT default 8800. If
      // the webhook resolver had picked 8800 first, SSE startup would
      // EADDRINUSE. PORT_RANGE_START shifted to 8801 leaves 8800 free
      // for SSE.
      const r = await spawnServer({
        ...baseEnv(),
        WEBHOOK_PORT: undefined,
        AUN_WEBHOOK_PORT: undefined,
        EXPECTED_BOTS: 'foo,bar',
      }, 4_000)
      const m = r.stderr.match(/bound webhook port (\d+) \(free-port detection\)/)
      expect(m).not.toBeNull()
      const picked = parseInt(m![1], 10)
      // Critically — must not be 8800 (SSE_PORT default reservation).
      expect(picked).not.toBe(8800)
      expect(picked).toBeGreaterThanOrEqual(8801)
      expect(picked).toBeLessThanOrEqual(8900)
    },
    15_000,
  )

  test.if(OPT_IN)(
    '(7) TOCTOU retry — 8801 pre-occupied → resolver skips 8801 and binds 8802+',
    async () => {
      // Cycle 3 — auditor axis 3 BLOCK fix. Pre-fix `findFreePortSync`
      // trusted lsof, so a process started after the lsof check could
      // grab the same port. Now `tryBindSync` does a real bind probe;
      // with 8801 already held by this test's listener, the resolver
      // must observe EADDRINUSE on its probe and move to 8802.
      await ensureBlocked(8801)
      const r = await spawnServer({ ...baseEnv(), WEBHOOK_PORT: undefined, AUN_WEBHOOK_PORT: undefined }, 4_000)
      const m = r.stderr.match(/bound webhook port (\d+) \(free-port detection\)/)
      expect(m).not.toBeNull()
      const picked = parseInt(m![1], 10)
      expect(picked).not.toBe(8801)
      expect(picked).toBeGreaterThanOrEqual(8802)
      expect(picked).toBeLessThanOrEqual(8900)
    },
    15_000,
  )

  test.if(OPT_IN)(
    '(8) lsof-failure fallback — PATH stripped of lsof, bind probe still finds a port',
    async () => {
      // Cycle 3 — auditor axis 3 secondary concern (lsof failure
      // returning "free" by default). With lsof unreachable, the
      // first pass treats every port as "likely free" and falls
      // through to the bind probe; a free port must still be found
      // via the bind path alone.
      const r = await spawnServer({
        ...baseEnv(),
        WEBHOOK_PORT: undefined,
        AUN_WEBHOOK_PORT: undefined,
        // /tmp has no `lsof`. Empty PATH would also break `bun` itself,
        // so we point at a directory that contains the bun binary but
        // not lsof. Caller's `bun` is invoked via absolute path, so
        // this only blinds the resolver's `execSync('lsof ...')`.
        PATH: '/tmp',
      }, 6_000)
      const m = r.stderr.match(/bound webhook port (\d+) \(free-port detection\)/)
      expect(m).not.toBeNull()
      const picked = parseInt(m![1], 10)
      expect(picked).toBeGreaterThanOrEqual(8801)
      expect(picked).toBeLessThanOrEqual(8900)
    },
    15_000,
  )

  // Default-run shape check (non-opt-in): make sure the constants and
  // helper symbols aren't accidentally renamed by a future refactor.
  // Cheap, no spawn. Catches the "rename broke the resolver" class of
  // regression that the heavy spawn tests would only catch in CI's
  // opt-in lane.
  test('source contains AUN_WEBHOOK_PORT priority + 8801-8900 range + SSE collision rationale + bind-probe', async () => {
    const src = await Bun.file(SERVER_TS).text()
    expect(src).toMatch(/AUN_WEBHOOK_PORT/)
    expect(src).toMatch(/PORT_RANGE_START = 8801/)
    expect(src).toMatch(/PORT_RANGE_END = 8900/)
    expect(src).toMatch(/free-port detection/)
    // Cycle 2 — rationale comment for the 8801 shift.
    expect(src).toMatch(/SSE_PORT|AGENT_COMMS_PORT/)
    // Verify the old default has actually been removed.
    expect(src).not.toMatch(/process\.env\.WEBHOOK_PORT \?\? '8789'/)
    // Cycle 3 — TOCTOU mitigation: bind probe must be present alongside lsof.
    expect(src).toMatch(/tryBindSync/)
    expect(src).toMatch(/Bun\.serve/)
    // Cycle 8 — bridge startup pre-check kill must be gated on
    // WEBHOOK_PORT_EXPLICIT (auditor msg `c01e55b6`). Catches the regression
    // where the unconditional `killProcessOnPort(WEBHOOK_PORT)` reappears.
    expect(src).toMatch(/if \(WEBHOOK_PORT_EXPLICIT\)\s*{\s*killProcessOnPort/)
  })

  test.if(OPT_IN)(
    '(9) bridge startup pre-check is gated on env-explicit (cycle 8 — TOCTOU innocent-process protection)',
    async () => {
      // Cycle 8 — auditor cycle 7 finding: server.ts:2888's bridge startup
      // pre-check `killProcessOnPort(WEBHOOK_PORT)` was unconditional, so
      // a free-port launch could still SIGKILL a process that raced into
      // the chosen port between `probe.stop()` and `Bun.serve()`. After
      // cycle 8 the call is gated on WEBHOOK_PORT_EXPLICIT. We exercise
      // the free-port path with a survivor on a likely-target port and
      // assert the survivor stays alive.
      //
      // The exact picked port depends on what's free; we hold 8801 as the
      // most likely first pick so the resolver is forced to skip it and
      // pick 8802+. If it later picks the same port the survivor holds,
      // the test self-skips (env-dependent, not script bug).
      const survivor = await occupyPort(8801)
      if (survivor) occupied.push(survivor)

      const r = await spawnServer({ ...baseEnv(), WEBHOOK_PORT: undefined, AUN_WEBHOOK_PORT: undefined }, 4_000)
      // Server picked some port via free-port detection.
      const m = r.stderr.match(/bound webhook port (\d+) \(free-port detection\)/)
      expect(m).not.toBeNull()
      // Critical: even for the free-port path, no killing-orphan-process log
      // should fire. The cycle 1 early kill block logs "killing orphan process
      // <pid> on port <N>"; the unguarded cycle-7 bridge pre-check logged via
      // `killPidsOnPort` ("Killed N orphan process(es) on port N"). Neither
      // should appear because both paths must be env-gated. (Cycle 8 only
      // gates them; the actual filter inside the kill is not part of this
      // PR — that lives in PR #260.)
      expect(r.stderr).not.toMatch(/killing orphan process \d+ on port \d+/)
      expect(r.stderr).not.toMatch(/Killed \d+ orphan process\(es\) on port \d+/)
      if (survivor) expect(survivor.listening).toBe(true)
    },
    15_000,
  )
})
