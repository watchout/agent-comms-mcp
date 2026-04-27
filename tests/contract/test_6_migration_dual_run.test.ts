import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'

// Spec §contract_test test_6 (specs/review/2026-04-23-lightweight-redesign-v3.md)
// Impl担当: PR #1 (merge gate, executable)
//
// Scope per lead-ama PR #1 instruction §4.1:
//   (a) 旧 server.ts を env=1 で起動、mock Discord で 1 insert
//   (b) 同 bot-id を env=0 で別 instance 起動、Discord skip 確認
//   (c) Discord mock 1 msg push → agent_messages 1 row のみ
//       (discord_message_id partial unique で重複 reject)
//   (d) inferior process stderr に duplicate-key log 確認
//
// Mock Discord delivery is simulated by direct INSERTs into agent_messages
// (no real Discord client; §3.5 forbids real Discord in test_6). The dedup
// under test is the `uq_agent_messages_discord_id` partial unique index.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SERVER = join(REPO_ROOT, 'server.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')
const AGENT_ID = 'test-dual-run-bot'
const DISCORD_MSG_ID = 'MSG_DUAL_RUN_X'

function baseEnv(dbPath: string): Record<string, string> {
  return {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: dbPath,
    DATABASE_URL: '',
    AGENT_COM_PG_NOTIFY: 'false',
    DISCORD_TOKEN: 'FAKE_TOKEN_DUAL_RUN_TEST',
    DISCORD_BOT_TOKEN: 'FAKE_TOKEN_DUAL_RUN_TEST',
    AGENT_ID,
  }
}

async function waitForStderr(getter: () => string, pattern: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pattern.test(getter())) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

async function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill('SIGTERM')
  await new Promise<void>(resolve => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch {}; resolve() }, 3000)
    proc.once('exit', () => { clearTimeout(t); resolve() })
  })
}

describe('test_6 migration_dual_run (PR #1, spec v3 contract_test test_6, merge gate)', () => {
  let tmpDir: string
  let dbPath: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test6-dual-'))
    dbPath = join(tmpDir, 'test6.db')
    const migrateResult = spawnSync('bun', [MIGRATE], {
      env: baseEnv(dbPath),
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    })
    if (migrateResult.status !== 0) {
      throw new Error(`SQLite migrate failed (status=${migrateResult.status}):\nstdout=${migrateResult.stdout}\nstderr=${migrateResult.stderr}`)
    }
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('dual-run: env=1 starts in legacy path, env=0 logs disabled, partial unique dedups', async () => {
    let procA: ChildProcess | null = null
    let procB: ChildProcess | null = null
    try {
      // Issue #248 cycle 3 — cascade-kill removal. Pre-cycle-3 the second
      // subprocess would SIGKILL the first via the orphan-kill on a shared
      // port; the test relied on that. Now PPID==1 filter blocks that path,
      // so we must give each subprocess its own port. Unique high ports avoid
      // colliding with any running bot on this machine.
      const portB = 19880 + Math.floor(Math.random() * 100)
      const portA = 19980 + Math.floor(Math.random() * 100)
      // (b) Spawn subprocess B with env=0 first (fast path, no Discord connect)
      procB = spawn('bun', [SERVER], {
        env: { ...baseEnv(dbPath), AGENT_COM_LEGACY_DISCORD_GATEWAY: '0', WEBHOOK_PORT: String(portB) },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: REPO_ROOT,
      })
      let bStderr = ''
      procB.stderr!.on('data', (d: Buffer) => { bStderr += d.toString() })

      const bDisabled = await waitForStderr(
        () => bStderr,
        /AGENT_COM_LEGACY_DISCORD_GATEWAY=0, legacy Discord WebSocket disabled/,
        8000,
      )
      expect(bDisabled).toBe(true)

      // (a) Spawn subprocess A with env=1 (legacy path enters, fake token → non-fatal fail)
      procA = spawn('bun', [SERVER], {
        env: { ...baseEnv(dbPath), AGENT_COM_LEGACY_DISCORD_GATEWAY: '1', WEBHOOK_PORT: String(portA) },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: REPO_ROOT,
      })
      let aStderr = ''
      procA.stderr!.on('data', (d: Buffer) => { aStderr += d.toString() })

      // env=1 enters the try block; fake token causes Discord connect to fail
      // which is caught and logged as non-fatal WARNING. That WARNING is our
      // marker that the legacy path was taken.
      const aEnteredLegacy = await waitForStderr(
        () => aStderr,
        /Discord adapter failed \(non-fatal\)|Discord adapter connected/,
        10000,
      )
      expect(aEnteredLegacy).toBe(true)
      // env=1 must NOT emit the disabled log
      expect(aStderr).not.toContain('AGENT_COM_LEGACY_DISCORD_GATEWAY=0, legacy Discord WebSocket disabled')

      // (a)(c) Mock Discord delivery → first insert succeeds (1 row)
      const db = new Database(dbPath)
      try {
        db.exec(
          `INSERT INTO agent_messages (id, author_id, content, message_type, discord_message_id, source)
           VALUES ('m-dual-1', 'fake-external-author', 'hello dual run', 'chat', '${DISCORD_MSG_ID}', 'discord')`,
        )
        const countAfterFirst = db.query<{ c: number }, []>(
          `SELECT COUNT(*) as c FROM agent_messages WHERE discord_message_id = ?`,
        ).get(DISCORD_MSG_ID)!
        expect(countAfterFirst.c).toBe(1)

        // (c)(d) Duplicate INSERT via inferior process — partial unique rejects
        const dupScript = `
import { Database } from 'bun:sqlite'
const dbPath = ${JSON.stringify(dbPath)}
const discordId = ${JSON.stringify(DISCORD_MSG_ID)}
const db = new Database(dbPath)
try {
  const stmt = db.prepare("INSERT INTO agent_messages (id, author_id, content, message_type, discord_message_id, source) VALUES (?, ?, ?, ?, ?, ?)")
  stmt.run('m-dual-2', 'fake-external-author', 'hello dual run dup', 'chat', discordId, 'discord')
  process.exit(0)
} catch (err) {
  process.stderr.write('agent-comms-test: duplicate-key INSERT rejected: ' + (err instanceof Error ? err.message : String(err)) + '\\n')
  process.exit(1)
}
`
        const dupResult = spawnSync('bun', ['-e', dupScript], { encoding: 'utf-8' })
        expect(dupResult.status).not.toBe(0)
        expect(dupResult.stderr).toContain('duplicate-key INSERT rejected')
        expect(dupResult.stderr).toMatch(/UNIQUE constraint|duplicate/i)

        // (c) Final state: 1 row only (partial unique dedup upheld)
        const countFinal = db.query<{ c: number }, []>(
          `SELECT COUNT(*) as c FROM agent_messages WHERE discord_message_id = ?`,
        ).get(DISCORD_MSG_ID)!
        expect(countFinal.c).toBe(1)
      } finally {
        db.close()
      }

      // Re-assert env=0 never enters the legacy path
      expect(bStderr).toContain('AGENT_COM_LEGACY_DISCORD_GATEWAY=0, legacy Discord WebSocket disabled')
      expect(bStderr).not.toContain('Discord adapter connected (inbound + outbound)')
      expect(bStderr).not.toContain('Discord adapter failed (non-fatal)')
    } finally {
      if (procA) await killAndWait(procA)
      if (procB) await killAndWait(procB)
    }
  }, 30_000)
})
