import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, bootstrapInternal } from '../../bin/aun/bootstrap'
import type {
  BootstrapExecutionPorts,
  BootstrapReasonCode,
  BootstrapStageContext,
  BootstrapStageOutcome,
} from '../../bin/aun/bootstrap-types'
import { MemoryBootstrapStateStore, bootstrapDigest } from '../../core/aun-bootstrap-state'
import { PgAdapter } from '../../core/db/pg-adapter'
import { createPostgresTestDatabase } from '../helpers/postgres-test-database'

const HEAD = 'c8eb30805a587a65a794499fa597935f2460c703'
const fakeRun = async (command: string, args: string[]) => command === 'codex' && args.join(' ') === 'mcp get wasurezu --json'
  ? { exitCode: 1, stdout: '', stderr: 'not configured' }
  : { exitCode: 0, stdout: `${HEAD}\n`, stderr: '' }

function ports(failMethod: keyof BootstrapExecutionPorts, code: BootstrapReasonCode): BootstrapExecutionPorts {
  const ok = async (): Promise<BootstrapStageOutcome> => ({ ok: true })
  const resolved = async (): Promise<BootstrapStageOutcome> => ({ ok: true, resolvedRuntime: 'codex' })
  const failing = async (): Promise<BootstrapStageOutcome> => ({ ok: false, reasonCodes: [code] })
  return {
    lockAndSnapshot: failMethod === 'lockAndSnapshot' ? failing : ok,
    dependencyPreflight: failMethod === 'dependencyPreflight' ? failing : resolved,
    migrateDatabase: failMethod === 'migrateDatabase' ? failing : ok,
    ensureAgentProfile: failMethod === 'ensureAgentProfile' ? failing : ok,
    ensureMcpRegistration: failMethod === 'ensureMcpRegistration' ? failing : ok,
    ensureMemoryReadiness: failMethod === 'ensureMemoryReadiness' ? failing : ok,
    installAndStartDaemon: failMethod === 'installAndStartDaemon' ? failing : ok,
    runQueueSmoke: failMethod === 'runQueueSmoke' ? failing : ok,
    readbackReady: failMethod === 'readbackReady' ? failing : ok,
    rollbackMutation: ok,
  }
}

const crashFixtureStage = process.env.AUN_BOOTSTRAP_CRASH_FIXTURE_STAGE === 'B3'
  || process.env.AUN_BOOTSTRAP_CRASH_FIXTURE_STAGE === 'B4'
  ? process.env.AUN_BOOTSTRAP_CRASH_FIXTURE_STAGE
  : null

function crashBoundaryPorts(
  stage: 'B3' | 'B4',
  markerPath: string,
  onReentry?: () => void,
): BootstrapExecutionPorts {
  const ok = async (): Promise<BootstrapStageOutcome> => ({ ok: true })
  const boundary = async (context: BootstrapStageContext): Promise<BootstrapStageOutcome> => {
    onReentry?.()
    context.admitRecoveryMutation?.({
      kind: stage === 'B3' ? 'configuration_desired' : 'mcp_registration',
      owner_key: `hard-crash:${stage}:${context.runId}`,
      before_digest: `exact-${stage}-preimage`,
      intended_after_digest: `exact-${stage}-intended`,
      actual_after_digest: null,
      rollback_action: `restore exact ${stage} preimage`,
      rollback_payload: {
        created_by_run: true,
        exact_artifact_identity: bootstrapDigest({ stage, run_id: context.runId }),
      },
    })
    writeFileSync(markerPath, `${stage}:owned-effect\n`, { flag: 'a', mode: 0o600 })
    process.kill(process.pid, 'SIGKILL')
    return new Promise(() => {})
  }
  return {
    lockAndSnapshot: ok,
    dependencyPreflight: async () => ({ ok: true, resolvedRuntime: 'codex' }),
    migrateDatabase: ok,
    ensureAgentProfile: stage === 'B3' ? boundary : ok,
    ensureMcpRegistration: stage === 'B4' ? boundary : ok,
    ensureMemoryReadiness: ok,
    installAndStartDaemon: ok,
    runQueueSmoke: ok,
    readbackReady: ok,
    rollbackMutation: async () => ({ ok: true, readbackDigest: `exact-${stage}-preimage` }),
  }
}

if (crashFixtureStage) {
  test(`subprocess ${crashFixtureStage} hard-crash boundary fixture`, async () => {
    const home = process.env.AUN_BOOTSTRAP_CRASH_FIXTURE_HOME!
    const markerPath = process.env.AUN_BOOTSTRAP_CRASH_FIXTURE_MARKER!
    await bootstrap({
      agentId: `hard-crash-${crashFixtureStage.toLowerCase()}`,
      runtime: 'codex',
      home,
      repoRoot: process.cwd(),
      workspaceRoot: process.cwd(),
      env: { HOME: home },
    }, {
      ports: crashBoundaryPorts(crashFixtureStage, markerPath),
      run: fakeRun,
      uuid: () => `hard-crash-${crashFixtureStage.toLowerCase()}`,
    })
    throw new Error('hard-crash fixture unexpectedly returned')
  })
} else describe('aun bootstrap failure injection matrix', () => {
  const cases: Array<[keyof BootstrapExecutionPorts, BootstrapReasonCode, string]> = [
    ['migrateDatabase', 'NO_GO_DB_MIGRATION', 'B2_DB_MIGRATION'],
    ['ensureAgentProfile', 'NO_GO_IDENTITY_MISMATCH', 'B3_AGENT_PROFILE'],
    ['ensureMcpRegistration', 'NO_GO_MCP_REGISTRATION', 'B4_MCP_REGISTRATION'],
    ['ensureMemoryReadiness', 'NO_GO_MEMORY_RECOVERY', 'B5_MEMORY_READINESS'],
    ['installAndStartDaemon', 'NO_GO_DAEMON_START', 'B6_ORDINARY_DAEMON_INSTALL_START'],
    ['runQueueSmoke', 'NO_GO_DUPLICATE_CLAIM', 'B7_QUEUE_SMOKE'],
    ['readbackReady', 'NO_GO_READY_PREDICATE_FALSE', 'B8_READY_READBACK'],
  ]
  for (const [method, code, stage] of cases) {
    test(`${stage} failure is terminal NO_GO with exact code`, async () => {
      const store = new MemoryBootstrapStateStore()
      const result = await bootstrap({
        agentId: `failure-${stage.toLowerCase()}`, runtime: 'codex', home: '/tmp/failure', repoRoot: process.cwd(), env: { HOME: '/tmp/failure' },
      }, { stateStore: store, ports: ports(method, code), run: fakeRun })
      expect(result.status).toBe('NO_GO')
      expect(result.stage).toBe(stage)
      expect(result.reason_codes).toEqual([code])
      expect(result.next_action.deliver_via).not.toContain('--resume')
    })
  }

  test('B5-EVIDENCE-001 receipt mismatch output is typed and digest-only', () => {
    const checkout = realpathSync(process.cwd())
    const tuple = {
      agent_id: 'evidence-agent', runtime_engine: 'codex' as const, session_name: 'target-session',
      process_id: 7312, port: 8812, checkout_path: checkout, commit_sha: HEAD,
    }
    const decision = bootstrapInternal.classifyRuntimeReceiptRows([{
      runtime_instance_id: 'receipt-secret-fixture', ...tuple, process_id: 9999,
      runtime_kind: 'bootstrap_bound_provider', status: 'running',
      metadata: {
        raw_command: 'codex --dangerously-pass-token SECRET_VALUE',
        raw_env: 'DATABASE_URL=postgresql://secret',
      },
    }], tuple)
    expect(decision).toMatchObject({ ok: false, discriminator: 'runtime_receipt_incompatible' })
    expect(decision.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain('SECRET_VALUE')
    expect(serialized).not.toContain('DATABASE_URL')
    expect(serialized).not.toContain('raw_command')
  })

  test('B3/B4 subprocess hard crashes retain a fsynced admission and resume cannot duplicate the effect', async () => {
    for (const stage of ['B3', 'B4'] as const) {
      const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `aun-bootstrap-crash-${stage.toLowerCase()}-`)))
      const markerPath = join(home, `${stage.toLowerCase()}-effect.log`)
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AUN_BOOTSTRAP_CRASH_FIXTURE_STAGE: stage,
          AUN_BOOTSTRAP_CRASH_FIXTURE_HOME: home,
          AUN_BOOTSTRAP_CRASH_FIXTURE_MARKER: markerPath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode).not.toBe(0)
      const agentId = `hard-crash-${stage.toLowerCase()}`
      const runId = `bootstrap-hard-crash-${stage.toLowerCase()}`
      const statePath = join(home, '.aun', 'bootstrap', agentId, `${runId}.json`)
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      expect(state.stages.find((record: any) => record.stage === (stage === 'B3' ? 'B3_AGENT_PROFILE' : 'B4_MCP_REGISTRATION')))
        .toMatchObject({ status: 'pending' })
      expect(state.mutations).toHaveLength(1)
      expect(state.mutations[0]).toMatchObject({
        actual_after_digest: null,
        rollback_payload: {
          recovery_admission: true,
          rollback_disposition: 'admitted_pending_effect',
        },
      })
      expect(readFileSync(markerPath, 'utf8').trim().split('\n')).toEqual([`${stage}:owned-effect`])

      const lockPath = join(home, '.aun', 'bootstrap', agentId, '.lock')
      expect(existsSync(lockPath)).toBe(true)
      let reentryCount = 0
      const resumed = await bootstrap({
        agentId,
        runtime: 'codex',
        home,
        repoRoot: process.cwd(),
        workspaceRoot: process.cwd(),
        env: { HOME: home },
        resumeRunId: runId,
      }, {
        ports: crashBoundaryPorts(stage, markerPath, () => { reentryCount++ }),
        run: fakeRun,
      })
      expect(resumed.reason_codes).toEqual(['NO_GO_RESUME_REVALIDATION'])
      expect(reentryCount).toBe(0)
      expect(readFileSync(markerPath, 'utf8').trim().split('\n')).toEqual([`${stage}:owned-effect`])
      console.log(JSON.stringify({
        fixture: `${stage}_HARD_CRASH_RECOVERY_ADMISSION`,
        child_exit: exitCode,
        admission_persisted: true,
        stage_pending: true,
        resume_reason: resumed.reason_codes[0],
        reentry_count: reentryCount,
        owned_effect_count: 1,
        child_stdout_digest: bootstrapDigest(stdout),
        child_stderr_digest: bootstrapDigest(stderr),
      }))
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  test('B3 locked authority and exact outbox revision/digest fences reject drift with zero protected deletion', async () => {
    const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-bootstrap-b3-fences-')))
    const databaseName = `aun_bootstrap_fences_${process.pid}_${Date.now()}`
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const codexRoot = join(home, '.codex')
    mkdirSync(codexRoot, { mode: 0o700 })
    const postgresDatabase = createPostgresTestDatabase(databaseName)
    const databaseUrl = postgresDatabase.databaseUrl
    const env = {
      ...process.env,
      HOME: home,
      AUN_HOME: join(home, '.aun'),
      DATABASE_URL: databaseUrl,
      AGENT_COM_DB: 'postgres',
      AUN_BOOTSTRAP_CHANNEL_PORT: '8801',
      AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex',
    } as Record<string, string>
    let db: PgAdapter | null = null
    try {
      expect(Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env }).exitCode).toBe(0)
      expect(Bun.spawnSync([
        'psql', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f',
        join(repoRoot, 'db', 'migrations', '2026-07-26-aun-configuration-reconciliation.up.sql'),
      ], { cwd: repoRoot, env }).exitCode).toBe(0)
      const profileSet = Bun.spawnSync([
        process.execPath, 'cli/index.ts', 'agent', 'profile', 'set', 'b3-fences',
        '--runtime', 'TUI', '--runtime-engine', 'codex', '--home-directory', repoRoot,
        '--channel-port', '8801', '--tmux-session', 'b3-session', '--enabled', 'true', '--execute',
      ], { cwd: repoRoot, env })
      expect(profileSet.exitCode).toBe(0)
      db = new PgAdapter(databaseUrl)
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
          'b3-fences', codexRoot,
          JSON.stringify({
            owner: 'continuous-reconciler', provider_repo_root: repoRoot, provider_config_root: codexRoot,
            daemon_checkout: join(home, '.agent-comms', 'state-daemon', 'releases', 'c'.repeat(40)),
            schema_version: 'aun-configuration-projection/v1',
          }),
          repoRoot, home, 'c'.repeat(40), 'd'.repeat(40),
          JSON.stringify(['https://github.com/watchout/agent-comms-mcp/issues/887#b3-fence-fixture']),
        ],
      )
      const preAgent = await db.queryOne<any>(`SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`, ['b3-fences'])
      const preOutbox = await db.query<any>(
        `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o WHERE agent_id = $1 ORDER BY event_id`,
        ['b3-fences'],
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
      const executionPorts = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot })
      const authority = await bootstrapInternal.resolveProviderRootAuthority({
        agentId: 'b3-fences', requestedRuntime: 'codex', env, home, repoRoot,
      })
      expect(authority.ok).toBe(true)
      if (!authority.ok || !authority.authority) throw new Error('expected exact B3 authority')
      const context: BootstrapStageContext = {
        runId: 'b3-fences-run', agentId: 'b3-fences', requestedRuntime: 'codex', resolvedRuntime: 'codex',
        repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
        priorState: { mutations: [] } as any,
        providerRootAuthority: authority.authority,
      }

      const driftedRoot = join(home, '.codex-drift')
      mkdirSync(driftedRoot, { mode: 0o700 })
      await db.execute(
        `UPDATE agents SET metadata = jsonb_set(metadata, '{codex_home}', to_jsonb($2::text), true) WHERE agent_id = $1`,
        ['b3-fences', driftedRoot],
      )
      const driftBaselineAgent = await db.queryOne<any>(`SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`, ['b3-fences'])
      const authorityDrift = await executionPorts.ensureAgentProfile(context)
      expect(authorityDrift.ok).toBe(false)
      const afterAuthorityAgent = await db.queryOne<any>(`SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`, ['b3-fences'])
      const afterAuthorityOutbox = await db.query<any>(
        `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o WHERE agent_id = $1 ORDER BY event_id`,
        ['b3-fences'],
      )
      expect(bootstrapDigest(afterAuthorityAgent?.row)).toBe(bootstrapDigest(driftBaselineAgent?.row))
      expect(bootstrapDigest(afterAuthorityOutbox.map((item) => item.row))).toBe(bootstrapDigest(preOutbox.map((item) => item.row)))
      expect((await db.queryOne<any>(`SELECT metadata->>'codex_home' AS codex_home FROM agents WHERE agent_id = $1`, ['b3-fences']))?.codex_home)
        .toBe(driftedRoot)
      expect(existsSync(join(home, '.aun', 'bootstrap', context.agentId, `${context.runId}.configuration-desired.rollback.json`))).toBe(false)
      await db.execute(
        `UPDATE agents SET metadata = jsonb_set(metadata, '{codex_home}', to_jsonb($2::text), true) WHERE agent_id = $1`,
        ['b3-fences', codexRoot],
      )

      const outcome = await executionPorts.ensureAgentProfile(context)
      expect(outcome.ok).toBe(true)
      const held = await db.queryOne<any>(
        `SELECT event_id, desired_revision, desired_digest FROM aun_configuration_desired_outbox
          WHERE agent_id = $1 AND event_id = ANY($2::uuid[])`,
        ['b3-fences', outcome.mutation?.rollback_payload?.new_event_ids],
      )
      expect(held).not.toBeNull()
      const driftReceipts: Array<Record<string, unknown>> = []
      for (const drift of [
        { field: 'desired_revision', value: Number(held.desired_revision) + 1 },
        { field: 'desired_digest', value: 'f'.repeat(64) },
      ] as const) {
        await db.execute(
          `UPDATE aun_configuration_desired_outbox SET ${drift.field} = $2 WHERE event_id = $1`,
          [String(held.event_id), drift.value],
        )
        const rejected = await executionPorts.rollbackMutation(context, {
          mutation_id: `b3-${drift.field}`, stage: 'B3_AGENT_PROFILE', rollback_status: 'not_run', ...outcome.mutation!,
        })
        expect(rejected.ok).toBe(false)
        const retained = await db.queryOne<any>(
          `SELECT event_id, desired_revision, desired_digest FROM aun_configuration_desired_outbox WHERE event_id = $1`,
          [String(held.event_id)],
        )
        expect(retained).not.toBeNull()
        driftReceipts.push({ field: drift.field, rejected: true, row_retained: true })
        await db.execute(
          `UPDATE aun_configuration_desired_outbox SET desired_revision = $2, desired_digest = $3 WHERE event_id = $1`,
          [String(held.event_id), held.desired_revision, held.desired_digest],
        )
      }
      const rolledBack = await executionPorts.rollbackMutation(context, {
        mutation_id: 'b3-exact-fences', stage: 'B3_AGENT_PROFILE', rollback_status: 'not_run', ...outcome.mutation!,
      })
      expect(rolledBack.ok).toBe(true)
      const finalAgent = await db.queryOne<any>(`SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`, ['b3-fences'])
      const finalOutbox = await db.query<any>(
        `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o WHERE agent_id = $1 ORDER BY event_id`,
        ['b3-fences'],
      )
      expect(bootstrapDigest(finalAgent?.row)).toBe(bootstrapDigest(preAgent?.row))
      expect(bootstrapDigest(finalOutbox.map((item) => item.row))).toBe(bootstrapDigest(preOutbox.map((item) => item.row)))
      console.log(JSON.stringify({
        fixture: 'B3_AUTHORITY_REVISION_DIGEST_FENCES',
        authority_drift_zero_effect: true,
        authority_drift_field: 'config_profile.metadata_codex_home',
        authority_tuple_digest: authority.authority.authorityTupleDigest,
        drift_receipts: driftReceipts,
        exact_rollback_verified: true,
      }))
    } finally {
      await db?.close().catch(() => {})
      postgresDatabase.drop()
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})
