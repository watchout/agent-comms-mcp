import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap } from '../../bin/aun/bootstrap'
import type { BootstrapExecutionPorts } from '../../bin/aun/bootstrap-types'
import { PgAdapter } from '../../core/db/pg-adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  renderStateDaemonLaunchAgentPlist,
  STATE_DAEMON_PLIST_NAME,
  type StateDaemonRestorePlan,
} from '../../core/state-daemon/launchagent'

const roots: string[] = []
const postgresDatabases: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  while (postgresDatabases.length) Bun.spawnSync(['dropdb', '-h', '/tmp', '--if-exists', postgresDatabases.pop()!])
})

describe('aun bootstrap clean-host journal', () => {
  for (const fixture of ['sqlite-new', 'sqlite-existing', 'postgres'] as const) test(`real default ${fixture} path performs genuine MCP recovery and separate-process ordinary receive`, async () => {
    const backend = fixture === 'postgres' ? 'postgres' : 'sqlite'
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-default-sqlite-'))
    roots.push(home)
    const repoRoot = join(import.meta.dir, '..', '..')
    const dbPath = join(home, 'agent-com.db')
    let sqlitePrestate: Buffer | null = null
    if (fixture === 'sqlite-existing') {
      const seeded = Bun.spawnSync([
        'sqlite3', dbPath,
        "PRAGMA journal_mode=DELETE; CREATE TABLE pre_bootstrap_marker (value TEXT NOT NULL); INSERT INTO pre_bootstrap_marker VALUES ('preserve-exactly');",
      ])
      expect(seeded.exitCode).toBe(0)
      sqlitePrestate = readFileSync(dbPath)
    }
    const databaseName = backend === 'postgres' ? `aun_bootstrap_${process.pid}_${Date.now()}` : null
    if (databaseName) {
      const created = Bun.spawnSync(['createdb', '-h', '/tmp', databaseName])
      expect(created.exitCode).toBe(0)
      postgresDatabases.push(databaseName)
    }
    const databaseUrl = databaseName ? `postgresql:///${databaseName}?host=/tmp` : undefined
    const env = {
      ...process.env,
      HOME: home,
      AUN_HOME: join(home, '.aun'),
      AGENT_COM_DB: backend,
      AGENT_COM_SQLITE_PATH: dbPath,
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      AGENT_MEMORY_PROJECT: 'bootstrap-clean-project',
      CODEX_SANDBOX: 'workspace-write',
    } as Record<string, string>
    const mcpFixture = `
      const readline = require('node:readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const m = JSON.parse(line);
        if (m.id === 1) console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'wasurezu-fixture',version:'1'}}}));
        if (m.id === 2) console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[{name:'recover_context',inputSchema:{type:'object'}}]}}));
        if (m.id === 3) console.log(JSON.stringify({jsonrpc:'2.0',id:3,result:{content:[{type:'text',text:'Project bootstrap-clean-project recovered'}],isError:false}}));
      });
    `
    let aunRegistered = false
    let queueReceiveCount = 0
    let syntheticPid = 50_000
    const nativeTuple = () => JSON.stringify({
      name: 'aun', enabled: true,
      transport: {
        type: 'stdio', command: realpathSync(process.execPath),
        args: ['run', '--cwd', realpathSync(repoRoot), 'server.ts'],
        env: {
          AGENT_ID: 'clean-default', AGENT_COM_EXPECTED_AGENT_ID: 'clean-default',
          ...(databaseUrl
            ? { DATABASE_URL: databaseUrl }
            : { AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: realpathSync(dbPath) }),
          AGENT_COM_PG_NOTIFY: 'false', AGENT_COMMS_TTL_SWEEP_DISABLED: '1', AUN_WEBHOOK_PORT: '8801',
        },
      },
    })
    const run = async (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => {
      const joined = args.join(' ')
      if (command === 'git' && joined === 'rev-parse HEAD') return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '', pid: ++syntheticPid }
      if (command === 'git' && joined === 'status --porcelain') return { exitCode: 0, stdout: '', stderr: '', pid: ++syntheticPid }
      if (command === 'git' && joined === '--version') return { exitCode: 0, stdout: 'git version 2.50.0\n', stderr: '', pid: ++syntheticPid }
      if (command === 'node') return { exitCode: 0, stdout: 'v20.20.0\n', stderr: '', pid: ++syntheticPid }
      if (command === 'tmux' && joined.includes('#S:#I.#P')) return { exitCode: 0, stdout: 'clean-session:%1\n', stderr: '', pid: ++syntheticPid }
      if (command === 'tmux') return { exitCode: 0, stdout: 'clean-session\n', stderr: '', pid: ++syntheticPid }
      if (command === 'launchctl' && joined === 'help') return { exitCode: 0, stdout: 'launchctl help\n', stderr: '', pid: ++syntheticPid }
      if (command === 'launchctl' && args[0] === 'bootout') return { exitCode: 0, stdout: 'booted out\n', stderr: '', pid: ++syntheticPid }
      if (command === 'lsof') return { exitCode: 1, stdout: '', stderr: '', pid: ++syntheticPid }
      if (command === 'ps') return { exitCode: 1, stdout: '', stderr: '', pid: ++syntheticPid }
      if (command === 'codex' && joined === '--version') return { exitCode: 0, stdout: 'codex-cli 1.0.0\n', stderr: '', pid: ++syntheticPid }
      if (command === 'codex' && joined === 'mcp get wasurezu --json') {
        return { exitCode: 0, stdout: JSON.stringify({ enabled: true, transport: { type: 'stdio', command: process.execPath, args: ['-e', mcpFixture], env: {} } }), stderr: '', pid: ++syntheticPid }
      }
      if (command === 'codex' && joined === 'mcp get aun --json') return aunRegistered
        ? { exitCode: 0, stdout: nativeTuple(), stderr: '', pid: ++syntheticPid }
        : { exitCode: 1, stdout: '', stderr: 'MCP server aun not found', pid: ++syntheticPid }
      if (command === 'codex' && joined === 'mcp list --json') return { exitCode: 0, stdout: JSON.stringify(aunRegistered ? [{ name: 'aun', enabled: true }] : []), stderr: '', pid: ++syntheticPid }
      if (command === 'codex' && args.slice(0, 3).join(' ') === 'mcp add aun') {
        aunRegistered = true
        return { exitCode: 0, stdout: 'added', stderr: '', pid: ++syntheticPid }
      }
      if (command === 'codex' && joined === 'mcp remove aun') {
        aunRegistered = false
        return { exitCode: 0, stdout: 'removed', stderr: '', pid: ++syntheticPid }
      }
      if (command === process.execPath && args[0] === '--version') return { exitCode: 0, stdout: '1.3.11\n', stderr: '', pid: ++syntheticPid }
      if (command === process.execPath && args[0] === 'scripts/state-daemon-launchagent.ts') {
        const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
        mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
        const plan: StateDaemonRestorePlan = {
          commit: 'a'.repeat(40), restoreRoot: join(home, '.agent-comms', 'state-daemon', 'checkouts'),
          checkoutPath: repoRoot, entryPath: join(repoRoot, 'core', 'state-daemon', 'index.ts'),
          logsDir: join(home, 'logs'), buildOutfile: join(home, 'state-daemon'), plistPath,
          tempPlistPath: `${plistPath}.tmp`, bunPath: process.execPath,
          databaseUrl: databaseUrl || 'postgresql:///agent_comms?host=/tmp', agentDenylist: '', extraEnv: {},
        }
        writeFileSync(plistPath, renderStateDaemonLaunchAgentPlist(plan, {
          AGENT_ID: 'state_daemon', SHIRUBE_D1_ENABLED: '0', SHIRUBE_D1_KILL_SWITCH: '1',
          SHIRUBE_D1_TARGET_ALLOWLIST: '[]', STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
        }))
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '', pid: ++syntheticPid }
      }
      if (command === process.execPath && joined.includes('state-daemon readiness')) {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, expected_agent_id: 'clean-default' }), stderr: '', pid: ++syntheticPid }
      }
      const useRealCli = command === process.execPath && (
        args[0] === 'db/migrate.ts'
        || (args[0] === 'cli/index.ts' && args[1] === 'agent')
        || args[0] === 'bin/aun.ts'
      )
      if (useRealCli) {
        if (args[0] === 'bin/aun.ts' && args[1] === 'receive') queueReceiveCount++
        const child = Bun.spawn([command, ...args], { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' })
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        return { exitCode, stdout, stderr, pid: child.pid }
      }
      return { exitCode: 1, stdout: '', stderr: `unhandled fake command: ${command} ${joined}`, pid: ++syntheticPid }
    }

    const input = { agentId: 'clean-default', runtime: 'codex' as const, home, repoRoot, workspaceRoot: repoRoot, env }
    const first = await bootstrap(input, { run })
    expect(first.status).toBe('READY')
    expect(first.readiness_predicates).toMatchObject({ genuine_mcp_recovery: true, queue_progress_ready: true })
    expect(queueReceiveCount).toBe(1)

    const contentionMessageId = randomUUID()
    const contentionDb = backend === 'postgres' ? new PgAdapter(databaseUrl!) : new SqliteAdapter(dbPath)
    const inserted = await contentionDb.query<{ id: string | number }>(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
       VALUES ($1, $2, $3, 'pending', 0, now()) RETURNING id`,
      ['clean-default', contentionMessageId, JSON.stringify({
        author_id: 'aun-bootstrap', message_type: 'instruction', content: 'bounded two-consumer contention probe',
        next_action: 'none', protected_effect_allowed: false, no_reply_required: true,
      })],
    )
    const contentionQueueId = String(inserted[0]!.id)
    await contentionDb.close()
    const contentionEnv = {
      ...env,
      AGENT_ID: 'clean-default',
      AGENT_COM_EXPECTED_AGENT_ID: 'clean-default',
      AUN_RECEIVE_CLAIM_SOURCE: `aun-bootstrap-contention:${first.run_id}`,
    }
    const invokeCli = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, 'bin/aun.ts', ...args], {
        cwd: repoRoot, env: contentionEnv, stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      return { pid: child.pid, stdout, stderr, exitCode }
    }
    const competitors = await Promise.all([
      invokeCli(['receive', '--agent-id', 'clean-default', '--queue-id', contentionQueueId]),
      invokeCli(['receive', '--agent-id', 'clean-default', '--queue-id', contentionQueueId]),
    ])
    expect(competitors.filter((result) => result.exitCode === 0)).toHaveLength(1)
    expect(new Set(competitors.map((result) => result.pid)).size).toBe(2)
    const contentionReadback = backend === 'postgres' ? new PgAdapter(databaseUrl!) : new SqliteAdapter(dbPath)
    const claimed = await contentionReadback.queryOne<any>(
      'SELECT status, claimed_by, claimed_at, payload FROM message_queue WHERE id = $1',
      [contentionQueueId],
    )
    expect(claimed?.status).toBe('received')
    expect(claimed?.claimed_by).toBe('clean-default')
    expect(JSON.parse(String(claimed?.payload)).receive_claim?.source).toBe(contentionEnv.AUN_RECEIVE_CLAIM_SOURCE)
    await contentionReadback.close()
    expect((await invokeCli(['processing', '--agent-id', 'clean-default', '--queue-id', contentionQueueId])).exitCode).toBe(0)
    expect((await invokeCli([
      'record-no-reply', '--agent-id', 'clean-default', '--queue-id', contentionQueueId,
      '--reason', `aun-bootstrap-no-effect:${first.run_id}:contention`,
    ])).exitCode).toBe(0)

    const second = await bootstrap(input, { run })
    expect(second.status).toBe('IDEMPOTENT_READY')
    expect(queueReceiveCount).toBe(1)
    const rolledBack = await bootstrap({ ...input, rollbackRunId: first.run_id }, { run })
    expect(rolledBack.status).toBe(backend === 'sqlite' ? 'ROLLED_BACK' : 'PARTIAL_ROLLBACK_NO_GO')
    expect(rolledBack.reason_codes).toEqual(backend === 'sqlite' ? [] : ['NO_GO_ROLLBACK_UNVERIFIED'])
    if (fixture === 'sqlite-new') {
      expect([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].every((path) => !existsSync(path))).toBe(true)
    } else if (fixture === 'sqlite-existing') {
      expect(readFileSync(dbPath).equals(sqlitePrestate!)).toBe(true)
      expect([`${dbPath}-wal`, `${dbPath}-shm`].every((path) => !existsSync(path))).toBe(true)
    }
  }, 60_000)

  test('real CLI dry-run reaches PLANNED on a clean host and leaves no files', () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-plan-host-'))
    roots.push(home)
    const stubDir = join(home, 'bin')
    mkdirSync(stubDir)
    const stub = (name: string, body: string) => {
      const path = join(stubDir, name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`)
      chmodSync(path, 0o755)
    }
    stub('git', 'case "$*" in "rev-parse HEAD") echo c8eb30805a587a65a794499fa597935f2460c703;; "--version") echo "git version 2.50.0";; esac')
    stub('node', 'echo v20.20.0')
    stub('tmux', 'echo clean-host-session')
    stub('launchctl', 'exit 0')
    stub('codex', 'echo codex-cli 1.0.0')
    stub('ps', 'exit 1')
    stub('lsof', 'exit 1')
    const dbPath = join(home, 'agent-com.db')
    const result = Bun.spawnSync([
      process.execPath, 'bin/aun.ts', 'bootstrap', '--agent-id', 'clean-plan', '--runtime', 'codex', '--dry-run', '--json',
    ], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        HOME: home,
        AUN_HOME: join(home, '.aun'),
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: dbPath,
        CODEX_SANDBOX: 'workspace-write',
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: 'PLANNED', resolved_runtime: 'codex' })
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(join(home, '.aun')) ? readdirSync(join(home, '.aun')) : []).toEqual([])
  })

  test('writes only a mode-0600 redacted run record beneath AUN_HOME/bootstrap', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-clean-'))
    roots.push(home)
    const pass = async () => ({ ok: true })
    const ports: BootstrapExecutionPorts = {
      lockAndSnapshot: pass,
      dependencyPreflight: async () => ({ ok: true, resolvedRuntime: 'codex', evidenceRefs: ['token=must-not-leak'] }),
      migrateDatabase: pass, ensureAgentProfile: pass, ensureMcpRegistration: pass,
      ensureMemoryReadiness: pass, installAndStartDaemon: pass, runQueueSmoke: pass,
      readbackReady: pass, rollbackMutation: pass,
    }
    const result = await bootstrap({
      agentId: 'clean-host', runtime: 'codex', home, repoRoot: process.cwd(),
      env: { HOME: home, AUN_HOME: join(home, '.aun'), DISCORD_BOT_TOKEN: 'super-secret-value' },
    }, { ports, run: async () => ({ exitCode: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' }) })
    expect(result.status).toBe('READY')
    const path = join(home, '.aun', 'bootstrap', 'clean-host', `${result.run_id}.json`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const body = readFileSync(path, 'utf8')
    expect(body).not.toContain('super-secret-value')
    expect(body).not.toContain('must-not-leak')
  })
})
