import { describe, test, expect, afterEach } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import * as net from 'node:net'

// Issue #248 cascade-disconnect root cause fix.
//
// The old cleanup-orphan-ports.sh `kill -9`d every PID returned by
// `lsof -ti :PORT`. When two bots started in parallel, the second
// bot's SessionStart hook would kill the first bot's healthy MCP
// server. Verified live as the trigger of today's outage (CTO
// directive `b64d5097`, ARC option A).
//
// New behavior: kill only PIDs whose PPID is 1 (init-reparented =
// real orphan). PIDs with a live parent (running MCP / running hook)
// must survive.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'cleanup-orphan-ports.sh')

function pickPort(): Promise<number> {
  // Use OS-assigned ephemeral port to avoid stomping on real bot ports.
  return new Promise((res) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => res(port))
    })
  })
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('cleanup-orphan-ports.sh — PPID==1 only kill (Issue #248 root cause)', () => {
  const cleanup: number[] = []
  afterEach(() => {
    for (const pid of cleanup) {
      try { process.kill(pid, 9) } catch {}
    }
    cleanup.length = 0
  })

  test('case 1 — PPID==1 (true orphan) is killed', async () => {
    const port = await pickPort()
    // Spawn nc detached + unref so it loses its parent and gets
    // reparented to launchd (PPID=1 on macOS).
    // Double-fork via launcher: outer bash backgrounds a `nohup
    // bash -c 'exec nc ...'`, disowns it, then exits. The grandchild
    // is reparented to PID 1 once its launching shell exits.
    // (Equivalent to the manual smoke I ran before writing this test.)
    const launcher = spawn('bash', [
      '-c',
      `nohup bash -c "exec nc -l ${port}" </dev/null >/dev/null 2>&1 & disown; exit 0`,
    ], { stdio: 'ignore' })
    await new Promise((r) => launcher.on('exit', r))
    await new Promise((r) => setTimeout(r, 400))

    // Find the listener PID via lsof — same lookup the script uses.
    const ls = spawnSync('lsof', ['-ti', `:${port}`])
    const pid = parseInt(ls.stdout.toString().trim().split('\n')[0], 10)
    expect(Number.isFinite(pid)).toBe(true)
    cleanup.push(pid)

    // Confirm the kernel sees PPID==1. Skip the test (not fail) if
    // the platform double-fork dance didn't reparent — that means
    // the test environment can't construct case 1, not that the
    // script is wrong.
    const ps = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)])
    const ppid = parseInt(ps.stdout.toString().trim(), 10)
    if (ppid !== 1) {
      console.warn(`case 1 environment skip: ppid was ${ppid}, expected 1`)
      return
    }

    const r = spawnSync('bash', [SCRIPT, String(port)])
    expect(r.status).toBe(0)
    // Killed → no longer alive.
    await new Promise((r) => setTimeout(r, 200))
    expect(pidAlive(pid)).toBe(false)
    cleanup.pop()  // already gone
  }, 10_000)

  test('case 2 — PPID!=1 (live parent) is skipped', async () => {
    const port = await pickPort()
    const child = spawn('nc', ['-l', String(port)], { stdio: 'ignore' })
    cleanup.push(child.pid!)
    await new Promise((r) => setTimeout(r, 300))

    // child's PPID is this test process — definitively not 1.
    const ps = spawnSync('ps', ['-o', 'ppid=', '-p', String(child.pid)])
    expect(parseInt(ps.stdout.toString().trim(), 10)).toBe(process.pid)

    const r = spawnSync('bash', [SCRIPT, String(port)])
    expect(r.status).toBe(0)
    // The live-parent PID must NOT have been killed.
    expect(pidAlive(child.pid!)).toBe(true)
    // Script must not even claim it killed anything (or if it did,
    // it killed an unrelated PPID==1 process — but the live one
    // survived, which is the contract).
    const out = r.stdout.toString()
    expect(out).not.toMatch(new RegExp(`Killing.*: .*\\b${child.pid}\\b`))
  }, 10_000)

  test('case 3 — protected PostgreSQL ports are refused before lsof/kill', () => {
    const r = spawnSync('bash', [SCRIPT, '5432'])
    expect(r.status).toBe(0)
    expect(r.stderr.toString()).toContain('Refusing protected PostgreSQL port cleanup request: 5432')

    const invalid = spawnSync('bash', [SCRIPT, 'not-a-port'])
    expect(invalid.status).toBe(0)
    expect(invalid.stderr.toString()).toContain('Refusing non-numeric port cleanup request: not-a-port')
  })
})
