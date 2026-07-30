import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, bootstrapInternal } from '../../bin/aun/bootstrap'
import type { BootstrapExecutionPorts, BootstrapStageContext } from '../../bin/aun/bootstrap-types'
import { PgAdapter } from '../../core/db/pg-adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { bootstrapDigest } from '../../core/aun-bootstrap-state'
import {
  renderStateDaemonLaunchAgentPlist,
  STATE_DAEMON_PLIST_NAME,
  type StateDaemonRestorePlan,
} from '../../core/state-daemon/launchagent'

const roots: string[] = []
const postgresDatabases: string[] = []
const launchctlSafePrint = (pid: number) => `pid = ${pid}
SHIRUBE_D1_ENABLED => 0
SHIRUBE_D1_KILL_SWITCH => 1
SHIRUBE_D1_TARGET_ALLOWLIST => []
STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED => 0
`
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  while (postgresDatabases.length) Bun.spawnSync(['dropdb', '-h', '/tmp', '--if-exists', postgresDatabases.pop()!])
})

describe('aun bootstrap clean-host journal', () => {
  test('existing Codex target root authority comes only from metadata.codex_home and projection equality', async () => {
    const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-bootstrap-root-db-')))
    roots.push(home)
    const codexRoot = join(home, '.codex')
    mkdirSync(codexRoot, { mode: 0o700 })
    const wrongRoot = join(home, '.wrong-codex')
    mkdirSync(wrongRoot, { mode: 0o700 })
    const wrongConfig = join(wrongRoot, 'config.toml')
    writeFileSync(wrongConfig, 'wrong-profile-must-remain-byte-identical\n', { mode: 0o640 })
    const wrongBefore = { bytes: readFileSync(wrongConfig), stat: statSync(wrongConfig) }
    const databaseName = `aun_bootstrap_root_${process.pid}_${Date.now()}`
    expect(Bun.spawnSync(['createdb', '-h', '/tmp', databaseName]).exitCode).toBe(0)
    postgresDatabases.push(databaseName)
    const databaseUrl = `postgresql:///${databaseName}?host=/tmp`
    const repoRoot = join(import.meta.dir, '..', '..')
    const env = { ...process.env, HOME: home, DATABASE_URL: databaseUrl, AGENT_COM_DB: 'postgres' } as Record<string, string>
    expect(Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env }).exitCode).toBe(0)
    expect(Bun.spawnSync([
      'psql', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f',
      join(repoRoot, 'db', 'migrations', '2026-07-26-aun-configuration-reconciliation.up.sql'),
    ], { cwd: repoRoot, env }).exitCode).toBe(0)
    const db = new PgAdapter(databaseUrl)
    await db.execute(
      `INSERT INTO agents (
         agent_id, display_name, agent_type, runtime, metadata,
         runtime_engine_preference, ordinary_projection
       ) VALUES ($1, $2, 'bot', 'TUI', $3::jsonb, 'codex', $4::jsonb)`,
      ['root-authority', 'Root authority fixture', JSON.stringify({ codex_home: codexRoot }), JSON.stringify({ provider_config_root: codexRoot })],
    )
    const exact = await bootstrapInternal.resolveProviderRootAuthority({
      agentId: 'root-authority', requestedRuntime: 'codex', env: { ...env, CODEX_HOME: wrongRoot }, home, repoRoot,
    })
    expect(exact.ok).toBe(true)
    if (!exact.ok) throw new Error('expected exact root authority')
    expect(exact.authority).toMatchObject({
      existingTarget: true,
      canonicalSourceField: 'metadata.codex_home',
      canonicalRoot: codexRoot,
      projectionMatches: true,
      callerMismatch: true,
    })
    const wrongAfter = statSync(wrongConfig)
    expect(readFileSync(wrongConfig).equals(wrongBefore.bytes)).toBe(true)
    expect({ dev: wrongAfter.dev, ino: wrongAfter.ino, mode: wrongAfter.mode & 0o777, size: wrongAfter.size })
      .toEqual({ dev: wrongBefore.stat.dev, ino: wrongBefore.stat.ino, mode: wrongBefore.stat.mode & 0o777, size: wrongBefore.stat.size })
    await db.execute(`UPDATE agents SET ordinary_projection = $2::jsonb WHERE agent_id = $1`, [
      'root-authority', JSON.stringify({ provider_config_root: '/tmp/conflict' }),
    ])
    const conflict = await bootstrapInternal.resolveProviderRootAuthority({
      agentId: 'root-authority', requestedRuntime: 'codex', env, home, repoRoot,
    })
    expect(conflict).toMatchObject({ ok: false, reasonCode: 'NO_GO_PROVIDER_ROOT_CONFLICT' })
    await db.execute(`UPDATE agents SET metadata = '{}'::jsonb WHERE agent_id = $1`, ['root-authority'])
    const missing = await bootstrapInternal.resolveProviderRootAuthority({
      agentId: 'root-authority', requestedRuntime: 'codex', env, home, repoRoot,
    })
    expect(missing).toMatchObject({ ok: false, reasonCode: 'NO_GO_PROVIDER_ROOT_AUTHORITY_MISSING' })
    const symlinkRoot = join(home, '.codex-link')
    symlinkSync(codexRoot, symlinkRoot)
    await db.execute(
      `UPDATE agents SET metadata = jsonb_build_object('codex_home', $2::text), ordinary_projection = jsonb_build_object('provider_config_root', $2::text)
        WHERE agent_id = $1`,
      ['root-authority', symlinkRoot],
    )
    const ambiguous = await bootstrapInternal.resolveProviderRootAuthority({
      agentId: 'root-authority', requestedRuntime: 'codex', env, home, repoRoot,
    })
    expect(ambiguous).toMatchObject({ ok: false, reasonCode: 'NO_GO_PROVIDER_ROOT_AUTHORITY_MISSING' })
    await db.close()
  }, 30_000)

  test('B3 holds the exact desired outbox event from concurrent consumers and restores full preimages', async () => {
    const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-bootstrap-b3-hold-')))
    roots.push(home)
    const codexRoot = join(home, '.codex')
    mkdirSync(codexRoot, { mode: 0o700 })
    const databaseName = `aun_bootstrap_b3_${process.pid}_${Date.now()}`
    expect(Bun.spawnSync(['createdb', '-h', '/tmp', databaseName]).exitCode).toBe(0)
    postgresDatabases.push(databaseName)
    const databaseUrl = `postgresql:///${databaseName}?host=/tmp`
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const env = {
      ...process.env,
      HOME: home, AUN_HOME: join(home, '.aun'), DATABASE_URL: databaseUrl, AGENT_COM_DB: 'postgres',
      AUN_BOOTSTRAP_CHANNEL_PORT: '8801', AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex',
    } as Record<string, string>
    expect(Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env }).exitCode).toBe(0)
    expect(Bun.spawnSync([
      'psql', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f',
      join(repoRoot, 'db', 'migrations', '2026-07-26-aun-configuration-reconciliation.up.sql'),
    ], { cwd: repoRoot, env }).exitCode).toBe(0)
    const profileSet = Bun.spawnSync([
      process.execPath, 'cli/index.ts', 'agent', 'profile', 'set', 'b3-held',
      '--runtime', 'TUI', '--runtime-engine', 'codex', '--home-directory', repoRoot,
      '--channel-port', '8801', '--tmux-session', 'b3-session', '--enabled', 'true', '--execute',
    ], { cwd: repoRoot, env })
    expect(profileSet.exitCode).toBe(0)
    const db = new PgAdapter(databaseUrl)
    await db.execute(
      `UPDATE agents SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{codex_home}', to_jsonb($2::text), true),
                         canonical_workspace = $4,
                         canonical_home = $5,
                         supervisor_identity = 'launchd:com.agent-comms.state-daemon',
                         ordinary_communication_enrollment = true,
                         ordinary_projection = $3::jsonb,
                         desired_release_commit = $6,
                         desired_release_tree = $7,
                         desired_control_refs = $8::jsonb
        WHERE agent_id = $1`,
      [
        'b3-held', codexRoot,
        JSON.stringify({
          owner: 'continuous-reconciler', provider_repo_root: repoRoot, provider_config_root: codexRoot,
          daemon_checkout: join(home, '.agent-comms', 'state-daemon', 'releases', 'c'.repeat(40)),
          schema_version: 'aun-configuration-projection/v1',
        }),
        repoRoot, home, 'c'.repeat(40), 'd'.repeat(40),
        JSON.stringify(['https://github.com/watchout/agent-comms-mcp/issues/887#preexisting-fixture']),
      ],
    )
    const preAgent = await db.queryOne<any>(`SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`, ['b3-held'])
    const preOutbox = await db.query<any>(
      `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o WHERE agent_id = $1 ORDER BY event_id`,
      ['b3-held'],
    )
    const run = async (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => {
      const joined = args.join(' ')
      if (command === 'git' && joined === 'rev-parse HEAD^{tree}') return { exitCode: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' }
      if (command === 'tmux') return { exitCode: 0, stdout: 'b3-session\n', stderr: '' }
      if (command === process.execPath && args[0] === 'cli/index.ts') {
        const child = Bun.spawn([command, ...args], { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ])
        return { exitCode, stdout, stderr }
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected ${command} ${joined}` }
    }
    const ports = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot })
    const context: BootstrapStageContext = {
      runId: 'b3-held-run', agentId: 'b3-held', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
      priorState: { mutations: [] } as any,
      providerRootAuthority: {
        existingTarget: true, canonicalSourceField: 'metadata.codex_home', canonicalRoot: codexRoot,
        canonicalRootDigest: bootstrapDigest(codexRoot), canonicalRealpathDigest: bootstrapDigest(codexRoot),
        projectionMatches: true, callerMismatch: false,
      },
    }
    const outcome = await ports.ensureAgentProfile(context)
    expect(outcome.ok).toBe(true)
    expect(outcome.mutation?.kind).toBe('configuration_desired')
    const held = await db.query<any>(
      `SELECT event_id, attempt_count, delivered_at, available_at::text AS available_at_text
         FROM aun_configuration_desired_outbox
        WHERE agent_id = $1 AND event_id = ANY($2::uuid[])`,
      ['b3-held', outcome.mutation?.rollback_payload?.new_event_ids],
    )
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ attempt_count: 0, delivered_at: null, available_at_text: 'infinity' })
    const concurrentlyVisible = await db.query<any>(
      `SELECT event_id FROM aun_configuration_desired_outbox
        WHERE agent_id = $1 AND delivered_at IS NULL AND available_at <= now()`,
      ['b3-held'],
    )
    expect(concurrentlyVisible.filter((row) => String(row.event_id) === String(held[0].event_id))).toHaveLength(0)
    const rolledBack = await ports.rollbackMutation(context, {
      mutation_id: 'b3-held-mutation', stage: 'B3_AGENT_PROFILE', rollback_status: 'not_run', ...outcome.mutation!,
    })
    expect(rolledBack.ok).toBe(true)
    expect(rolledBack.readinessPredicates).toMatchObject({
      held_run_event_delivery_count: 0,
      compensating_event_count: 1,
      exact_delete_count: 2,
      broad_delete_count: 0,
      trigger_disable_count: 0,
      foreign_event_mutation_count: 0,
    })
    const finalAgent = await db.queryOne<any>(`SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`, ['b3-held'])
    const finalOutbox = await db.query<any>(
      `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o WHERE agent_id = $1 ORDER BY event_id`,
      ['b3-held'],
    )
    expect(bootstrapDigest(finalAgent?.row)).toBe(bootstrapDigest(preAgent?.row))
    expect(bootstrapDigest(finalOutbox.map((item) => item.row))).toBe(bootstrapDigest(preOutbox.map((item) => item.row)))
    await db.close()
  }, 30_000)

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
    if (databaseUrl) {
      const migrated = Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env })
      expect(migrated.exitCode).toBe(0)
    }
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
    let daemonLoaded = false
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
      if (command === 'launchctl' && args[0] === 'print') return daemonLoaded
        ? { exitCode: 0, stdout: launchctlSafePrint(4242), stderr: '', pid: ++syntheticPid }
        : { exitCode: 3, stdout: '', stderr: 'Could not find service', pid: ++syntheticPid }
      if (command === 'launchctl' && args[0] === 'bootout') {
        daemonLoaded = false
        return { exitCode: 0, stdout: 'booted out\n', stderr: '', pid: ++syntheticPid }
      }
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
        mkdirSync(options.env.CODEX_HOME, { recursive: true, mode: 0o700 })
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
        daemonLoaded = true
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
    let activeOwnedQueueId: string | null = null
    let invalidPayloadQueueId: string | null = null
    const invalidPayload = 'step one legacy queue payload'
    if (databaseUrl) {
      const ownedDb = new PgAdapter(databaseUrl)
      const activeOwned = await ownedDb.query<{ id: string | number }>(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 0, now()) RETURNING id`,
        ['clean-default', randomUUID(), JSON.stringify({
          author_id: 'aun-bootstrap', message_type: 'instruction', content: 'run-owned rollback fixture',
          bootstrap_run_id: first.run_id, protected_effect_allowed: false, no_reply_required: true,
        })],
      )
      activeOwnedQueueId = String(activeOwned[0]!.id)
      const invalidShared = await ownedDb.query<{ id: string | number }>(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at, done_at)
         VALUES ($1, $2, $3, 'done', 0, now(), now()) RETURNING id`,
        ['clean-default', randomUUID(), invalidPayload],
      )
      invalidPayloadQueueId = String(invalidShared[0]!.id)
      await ownedDb.close()
    }
    const rolledBack = await bootstrap({ ...input, rollbackRunId: first.run_id }, { run })
    expect(rolledBack.status).toBe('ROLLED_BACK')
    expect(rolledBack.reason_codes).toEqual([])
    if (fixture === 'sqlite-new') {
      expect([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].every((path) => !existsSync(path))).toBe(true)
    } else if (fixture === 'sqlite-existing') {
      expect(readFileSync(dbPath).equals(sqlitePrestate!)).toBe(true)
      expect([`${dbPath}-wal`, `${dbPath}-shm`].every((path) => !existsSync(path))).toBe(true)
    } else if (databaseUrl) {
      const rollbackReadback = new PgAdapter(databaseUrl)
      const queueRows = await rollbackReadback.query<any>(
        'SELECT id, status, payload FROM message_queue ORDER BY id',
      )
      const activeOwnedQueueRows = queueRows.filter((row) => {
        let payload: any = null
        try { payload = JSON.parse(String(row.payload)) } catch { return false }
        return payload?.bootstrap_run_id === first.run_id
          && ['pending', 'read', 'received', 'in_progress'].includes(String(row.status))
      })
      const activeOwned = [
        await rollbackReadback.query<any>(`SELECT runtime_instance_id FROM agent_runtime_instances
          WHERE metadata->>'bootstrap_run_id' = $1 AND status IN ('running', 'active')`, [first.run_id]),
        await rollbackReadback.query<any>(`SELECT id FROM runtime_memory_ready_evidence
          WHERE metadata->>'bootstrap_run_id' = $1 AND result_status = 'ready'`, [first.run_id]),
        activeOwnedQueueRows,
      ]
      expect(activeOwned.map((rows) => rows.length)).toEqual([0, 0, 0])
      const expiredOwned = await rollbackReadback.queryOne<any>(
        'SELECT status, failed_reason, done_at, payload FROM message_queue WHERE id = $1',
        [activeOwnedQueueId],
      )
      expect(expiredOwned?.status).toBe('skipped')
      expect(expiredOwned?.failed_reason).toBe('BOOTSTRAP_ROLLBACK')
      expect(expiredOwned?.done_at).toBeTruthy()
      expect(JSON.parse(String(expiredOwned?.payload)).bootstrap_rollback_expired).toBe(true)
      const sharedContention = await rollbackReadback.queryOne<any>('SELECT status, payload FROM message_queue WHERE id = $1', [contentionQueueId])
      expect(sharedContention?.status).toBe('done')
      expect(JSON.parse(String(sharedContention?.payload)).bootstrap_run_id).toBeUndefined()
      const invalidShared = await rollbackReadback.queryOne<any>(
        'SELECT status, payload FROM message_queue WHERE id = $1', [invalidPayloadQueueId],
      )
      expect(invalidShared).toEqual({ status: 'done', payload: invalidPayload })
      await rollbackReadback.close()
    }
  }, 60_000)

  test('daemon native pre-state fences loaded-without-plist and restores unloaded/run-created states exactly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-daemon-prestate-'))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    const plan: StateDaemonRestorePlan = {
      commit: 'a'.repeat(40), restoreRoot: join(home, '.agent-comms', 'state-daemon', 'checkouts'),
      checkoutPath: repoRoot, entryPath: join(repoRoot, 'core', 'state-daemon', 'index.ts'),
      logsDir: join(home, 'logs'), buildOutfile: join(home, 'state-daemon'), plistPath,
      tempPlistPath: `${plistPath}.tmp`, bunPath: process.execPath,
      databaseUrl: 'postgresql:///disposable?host=/tmp', agentDenylist: '', extraEnv: {},
    }
    const original = renderStateDaemonLaunchAgentPlist(plan, {
      AGENT_ID: 'state_daemon', SHIRUBE_D1_ENABLED: '0', SHIRUBE_D1_KILL_SWITCH: '1',
      SHIRUBE_D1_TARGET_ALLOWLIST: '[]', STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
    })
    let loaded = false
    let pid = 9001
    let restoreCalls = 0
    let bootoutCalls = 0
    const run = async (command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'print') return loaded
        ? { exitCode: 0, stdout: launchctlSafePrint(pid), stderr: '' }
        : { exitCode: 3, stdout: '', stderr: 'not loaded' }
      if (command === 'launchctl' && args[0] === 'bootout') {
        bootoutCalls++
        loaded = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        loaded = true
        pid = 9001
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (command === process.execPath && args[0] === 'scripts/state-daemon-launchagent.ts') {
        restoreCalls++
        writeFileSync(plistPath, original, { mode: 0o644 })
        loaded = true
        pid = 9002
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
      }
      if (command === process.execPath && args.join(' ').includes('state-daemon readiness')) {
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const env = {
      HOME: home, AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: join(home, 'disposable.db'),
      AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex',
    }
    const context = {
      runId: 'daemon-run', agentId: 'daemon-agent', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
      priorState: { mutations: [] } as any,
    } satisfies BootstrapStageContext
    const ports = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot })

    loaded = true
    rmSync(plistPath, { force: true })
    const orphanLoaded = await ports.installAndStartDaemon(context)
    expect(orphanLoaded.reasonCodes).toEqual(['NO_GO_PRESTATE_UNREADABLE'])
    expect(restoreCalls).toBe(0)

    loaded = false
    writeFileSync(plistPath, original, { mode: 0o640 })
    const preExistingUnloaded = await ports.installAndStartDaemon(context)
    expect(preExistingUnloaded.ok).toBe(true)
    expect(preExistingUnloaded.mutation?.rollback_payload?.created_by_run).toBe(false)
    const restored = await ports.rollbackMutation(context, {
      mutation_id: 'daemon-m1', stage: 'B6_ORDINARY_DAEMON_INSTALL_START', rollback_status: 'not_run', ...preExistingUnloaded.mutation!,
    })
    expect(restored.ok).toBe(true)
    expect(loaded).toBe(false)
    expect(readFileSync(plistPath, 'utf8')).toBe(original)
    expect(statSync(plistPath).mode & 0o777).toBe(0o640)

    loaded = false
    rmSync(plistPath, { force: true })
    const runCreated = await ports.installAndStartDaemon({ ...context, runId: 'daemon-created' })
    expect(runCreated.ok).toBe(true)
    expect(runCreated.mutation?.rollback_payload?.created_by_run).toBe(true)

    const rollbackWithoutMutation = async (mutation: typeof runCreated.mutation, candidateContext = { ...context, runId: 'daemon-created' }) => {
      const callsBefore = bootoutCalls
      const outcome = await ports.rollbackMutation(candidateContext, {
        mutation_id: 'daemon-fence', stage: 'B6_ORDINARY_DAEMON_INSTALL_START', rollback_status: 'not_run', ...mutation!,
      })
      expect(outcome.ok).toBe(false)
      expect(bootoutCalls).toBe(callsBefore)
      expect(loaded).toBe(true)
      expect(existsSync(plistPath)).toBe(true)
    }
    await rollbackWithoutMutation({
      ...runCreated.mutation!,
      rollback_payload: { ...runCreated.mutation!.rollback_payload, launch_label: 'wrong.label' },
    })
    await rollbackWithoutMutation(runCreated.mutation, { ...context, runId: 'daemon-created', agentId: 'wrong-agent' })
    await rollbackWithoutMutation({
      ...runCreated.mutation!,
      rollback_payload: { ...runCreated.mutation!.rollback_payload, bootstrap_run_id: 'wrong-owner-token' },
    })
    writeFileSync(plistPath, `${original}\n<!-- drift -->\n`, { mode: 0o644 })
    await rollbackWithoutMutation(runCreated.mutation)
    writeFileSync(plistPath, original, { mode: 0o644 })
    pid = 9999
    await rollbackWithoutMutation(runCreated.mutation)
    pid = 9002
    const removed = await ports.rollbackMutation({ ...context, runId: 'daemon-created' }, {
      mutation_id: 'daemon-m2', stage: 'B6_ORDINARY_DAEMON_INSTALL_START', rollback_status: 'not_run', ...runCreated.mutation!,
    })
    expect(removed.ok).toBe(true)
    expect(existsSync(plistPath)).toBe(false)
    expect(loaded).toBe(false)

    writeFileSync(plistPath, original, { mode: 0o644 })
    loaded = true
    pid = 9003
    const exactLoadedBytes = readFileSync(plistPath)
    const exactLoadedMode = statSync(plistPath).mode & 0o777
    const restoreCallsBeforeLoaded = restoreCalls
    const existingLoaded = await ports.installAndStartDaemon({ ...context, runId: 'daemon-existing' })
    expect(existingLoaded.ok).toBe(true)
    expect(existingLoaded.mutation).toBeUndefined()
    expect(restoreCalls).toBe(restoreCallsBeforeLoaded)
    expect(readFileSync(plistPath).equals(exactLoadedBytes)).toBe(true)
    expect(statSync(plistPath).mode & 0o777).toBe(exactLoadedMode)
  })

  test('profile, SQLite DB, and daemon mutations returned after nonzero are read back and exactly recoverable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-post-timeout-targets-'))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const dbPath = join(home, 'target.db')
    expect(Bun.spawnSync(['sqlite3', dbPath, 'CREATE TABLE before_marker(value TEXT); INSERT INTO before_marker VALUES (\'exact\');']).exitCode).toBe(0)
    const dbBefore = readFileSync(dbPath)
    const env = { HOME: home, AUN_HOME: join(home, '.aun'), AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: dbPath }
    let profile: any = null
    let profileCreateCalls = 0
    const profileRun = async (command: string, args: string[]) => {
      const joined = args.join(' ')
      if (command === 'tmux') return { exitCode: 0, stdout: 'timeout-session\n', stderr: '' }
      if (command === 'lsof') return { exitCode: 1, stdout: '', stderr: '' }
      if (command === process.execPath && joined.includes('agent profile get')) {
        return { exitCode: 0, stdout: JSON.stringify({ profile }), stderr: '' }
      }
      if (command === process.execPath && joined.includes('agent profile set')) {
        if (args.includes('false')) {
          profile = { ...profile, profile_enabled: false }
          return { exitCode: 0, stdout: '{}', stderr: '' }
        }
        profileCreateCalls++
        profile = {
          runtime: 'TUI', runtime_engine_preference: 'codex', home_directory: repoRoot,
          channel_port: 8801, tmux_session: 'timeout-session', profile_enabled: true, profile_revision: 1,
        }
        return { exitCode: 124, stdout: '', stderr: 'timed out after profile write' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    }
    const profileContext = {
      runId: 'profile-timeout', agentId: 'timeout-agent', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
      priorState: { mutations: [] } as any,
    } satisfies BootstrapStageContext
    const profilePorts = bootstrapInternal.createDefaultPorts({ run: profileRun, env, home, repoRoot })
    const profileFailed = await profilePorts.ensureAgentProfile(profileContext)
    expect(profileCreateCalls).toBe(1)
    expect(profileFailed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    expect(profileFailed.mutation?.actual_after_digest).toBeString()
    const profileRollback = await profilePorts.rollbackMutation(profileContext, {
      mutation_id: 'profile-m1', stage: 'B3_AGENT_PROFILE', rollback_status: 'not_run', ...profileFailed.mutation!,
    })
    expect(profileRollback.ok).toBe(true)
    expect(profile.profile_enabled).toBe(false)

    let migrationCalls = 0
    const databaseRun = async (command: string, args: string[]) => {
      if (command === process.execPath && args[0] === 'db/migrate.ts') {
        migrationCalls++
        expect(Bun.spawnSync(['sqlite3', dbPath, 'CREATE TABLE timeout_mutation(value TEXT);']).exitCode).toBe(0)
        return { exitCode: 124, stdout: '', stderr: 'timed out after database write' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    }
    const dbPorts = bootstrapInternal.createDefaultPorts({ run: databaseRun, env, home, repoRoot })
    const dbFailed = await dbPorts.migrateDatabase({ ...profileContext, runId: 'db-timeout' })
    expect(migrationCalls).toBe(1)
    expect(dbFailed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    const dbRollback = await dbPorts.rollbackMutation({ ...profileContext, runId: 'db-timeout' }, {
      mutation_id: 'db-m1', stage: 'B2_DB_MIGRATION', rollback_status: 'not_run', ...dbFailed.mutation!,
    })
    expect(dbRollback.ok).toBe(true)
    expect(readFileSync(dbPath).equals(dbBefore)).toBe(true)
    expect([`${dbPath}-wal`, `${dbPath}-shm`].every((path) => !existsSync(path))).toBe(true)

    const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    let loaded = false
    const daemonPlan: StateDaemonRestorePlan = {
      commit: 'a'.repeat(40), restoreRoot: join(home, 'restore'), checkoutPath: repoRoot,
      entryPath: join(repoRoot, 'core', 'state-daemon', 'index.ts'), logsDir: join(home, 'logs'),
      buildOutfile: join(home, 'daemon'), plistPath, tempPlistPath: `${plistPath}.tmp`, bunPath: process.execPath,
      databaseUrl: 'postgresql:///disposable?host=/tmp', agentDenylist: '', extraEnv: {},
    }
    const daemonPlist = renderStateDaemonLaunchAgentPlist(daemonPlan, {
      AGENT_ID: 'state_daemon', SHIRUBE_D1_ENABLED: '0', SHIRUBE_D1_KILL_SWITCH: '1',
      SHIRUBE_D1_TARGET_ALLOWLIST: '[]', STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
    })
    const daemonRun = async (command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'print') return loaded
        ? { exitCode: 0, stdout: launchctlSafePrint(7123), stderr: '' }
        : { exitCode: 3, stdout: '', stderr: 'not loaded' }
      if (command === 'launchctl' && args[0] === 'bootout') {
        loaded = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (command === process.execPath && args[0] === 'scripts/state-daemon-launchagent.ts') {
        writeFileSync(plistPath, daemonPlist, { mode: 0o644 })
        loaded = true
        return { exitCode: 124, stdout: '', stderr: 'timed out after launchd mutation' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const daemonEnv = { ...env, AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex' }
    const daemonPorts = bootstrapInternal.createDefaultPorts({ run: daemonRun, env: daemonEnv, home, repoRoot })
    const daemonFailed = await daemonPorts.installAndStartDaemon({ ...profileContext, runId: 'daemon-timeout', env: daemonEnv })
    expect(daemonFailed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    const daemonRollback = await daemonPorts.rollbackMutation({ ...profileContext, runId: 'daemon-timeout', env: daemonEnv }, {
      mutation_id: 'daemon-timeout-m1', stage: 'B6_ORDINARY_DAEMON_INSTALL_START', rollback_status: 'not_run', ...daemonFailed.mutation!,
    })
    expect(daemonRollback.ok).toBe(true)
    expect(loaded).toBe(false)
    expect(existsSync(plistPath)).toBe(false)
  })

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
    stub('codex', 'case "$*" in "mcp get wasurezu --json") exit 1;; *) echo codex-cli 1.0.0;; esac')
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
    }, { ports, run: async (command, args) => command === 'codex' && args.join(' ') === 'mcp get wasurezu --json'
      ? { exitCode: 1, stdout: '', stderr: 'not configured' }
      : { exitCode: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' } })
    expect(result.status).toBe('READY')
    const path = join(home, '.aun', 'bootstrap', 'clean-host', `${result.run_id}.json`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const body = readFileSync(path, 'utf8')
    expect(body).not.toContain('super-secret-value')
    expect(body).not.toContain('must-not-leak')
  })
})
