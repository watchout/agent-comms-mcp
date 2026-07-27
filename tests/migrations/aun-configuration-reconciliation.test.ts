import { describe, expect, test } from 'bun:test'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claimApprovedConfigurationRestartExecution,
  canonicalConfigurationJson,
  completeConfigurationRestartExecution,
  configurationRestartReceiptAuthorizationDocument,
  createConfigurationRestartRequest,
  normalizeDesiredStateRow,
  recordConfigurationObservedState,
  verifyConfigurationRestartExecutionClaim,
} from '../../core/aun-configuration-desired-state'
import { acquireControlPlaneLease, releaseControlPlaneLease } from '../../core/control-plane-leases'
import { PgAdapter } from '../../core/db/pg-adapter'

const upPath = join(import.meta.dir, '../../db/migrations/2026-07-26-aun-configuration-reconciliation.up.sql')
const downPath = join(import.meta.dir, '../../db/migrations/2026-07-26-aun-configuration-reconciliation.down.sql')
const up = readFileSync(upPath, 'utf8')
const down = readFileSync(downPath, 'utf8')
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const receiptSecret = 'fixture-restart-receipt-hmac-secret'

function signedRestartReceipt(input: Parameters<typeof configurationRestartReceiptAuthorizationDocument>[0], options: {
  secret?: string
  timestamp?: number
  activeFunction?: string
} = {}) {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
  const exactDocument = configurationRestartReceiptAuthorizationDocument(input)
  const document = options.activeFunction
    ? { ...exactDocument, active_function: options.activeFunction }
    : exactDocument
  const content = canonicalConfigurationJson(document)
  const contentHash = sha256(content)
  const signature = createHmac('sha256', options.secret ?? receiptSecret)
    .update(`codex-cto:${timestamp}:${input.channelId}:${contentHash}`)
    .digest('hex')
  return { content, metadata: { ...document, auth: { signature, timestamp } }, timestamp }
}

async function configurationSchemaSnapshot(db: PgAdapter): Promise<Record<string, string>> {
  const columns = await db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name LIKE 'aun_configuration_%' OR column_name LIKE 'desired_%'
          OR column_name IN ('canonical_workspace', 'canonical_home', 'supervisor_identity',
            'expected_provider_identity_ref', 'ordinary_communication_enrollment', 'ordinary_projection'))
      ORDER BY table_name, column_name`)
  const functions = await db.query(`SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'aun_configuration_%'
         OR (n.nspname = 'public' AND p.proname IN ('aun_canonical_jsonb', 'enforce_aun_configuration_desired_state', 'append_aun_configuration_desired_event'))
      ORDER BY p.proname`)
  const triggers = await db.query(`SELECT tgname, pg_get_triggerdef(oid, true) AS definition
      FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_agents_aun_configuration_%'
      ORDER BY tgname`)
  const indexes = await db.query(`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename LIKE 'aun_configuration_%'
      ORDER BY indexname`)
  const constraints = await db.query(`SELECT conname, pg_get_constraintdef(oid, true) AS definition
      FROM pg_constraint WHERE conrelid IN (
        'aun_configuration_desired_outbox'::regclass,
        'aun_configuration_observed_state'::regclass,
        'aun_configuration_restart_requests'::regclass
      ) ORDER BY conname`)
  return Object.fromEntries(Object.entries({ columns, functions, triggers, indexes, constraints })
    .map(([key, value]) => [key, sha256(JSON.stringify(value))]))
}

describe('AUN configuration reconciliation migration', () => {
  test('has deterministic nonempty up/down artifacts and explicit guarded rollback', () => {
    expect(sha256(up)).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256(down)).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256(up)).not.toBe(sha256(down))
    expect(down).toContain('refusing to drop nonempty AUN configuration reconciliation evidence')
    expect(down).toContain('DROP TRIGGER IF EXISTS trg_agents_aun_configuration_desired_event')
    expect(down).toContain('DROP COLUMN IF EXISTS desired_revision')
  })

  test('enforces one revision/digest/outbox transaction path for direct governed writes', () => {
    expect(up).toContain('BEFORE INSERT OR UPDATE OF')
    expect(up).toContain("OLD.desired_digest IS NOT DISTINCT FROM next_digest")
    expect(up).toContain('COALESCE(OLD.desired_revision, 0) + 1')
    expect(up).toContain('UNIQUE (agent_id, desired_revision)')
    expect(up).toContain("event_type = 'AUN_AGENT_CONFIGURATION_DESIRED_CHANGED'")
    expect(up).toContain("pg_notify('aun_configuration_desired_changed'")
    expect(up).toContain('aun_canonical_jsonb')
  })

  test('creates desired outbox, observed state, fenced receipt, and restart-budget constraints', () => {
    for (const table of [
      'aun_configuration_desired_outbox',
      'aun_configuration_observed_state',
      'aun_configuration_restart_requests',
    ]) expect(up).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    expect(up).toContain("lease_id UUID NOT NULL REFERENCES control_plane_leases")
    expect(up).toContain('fencing_token BIGINT NOT NULL')
    expect(up).toContain('restart_budget INTEGER NOT NULL CHECK (restart_budget = 1)')
    expect(up).toContain('from_revision IS NULL OR from_revision <= to_revision')
    expect(up).toContain("'DEGRADED_DB_UNAVAILABLE'")
    expect(up).toContain("'NO_GO_STALE_CANDIDATE'")
  })

  test('executes isolated PostgreSQL up/down/up with one revision and one outbox event per governed update', async () => {
    const databaseName = `acm887_${process.pid}_${randomUUID().replaceAll('-', '')}`
    const databaseUrl = `postgresql:///${databaseName}?host=/tmp`
    const repoRoot = join(import.meta.dir, '../..')
    const created = Bun.spawnSync(['createdb', '-h', '/tmp', databaseName], { stdout: 'pipe', stderr: 'pipe' })
    expect(created.exitCode).toBe(0)
    const priorAuthSecret = process.env.AGENT_COMMS_SECRET
    process.env.AGENT_COMMS_SECRET = receiptSecret
    let db: PgAdapter | null = null
    try {
      const migrated = Bun.spawnSync([process.execPath, 'db/migrate.ts'], {
        cwd: repoRoot,
        env: { ...process.env, AGENT_COM_DB: 'postgres', DATABASE_URL: databaseUrl },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(migrated.exitCode).toBe(0)
      db = new PgAdapter(databaseUrl)
      await db.execute(up)
      const firstSchemaDigest = await configurationSchemaSnapshot(db)

      await db.execute(
        `INSERT INTO agents (
           agent_id, display_name, agent_type, runtime, profile_enabled,
           runtime_engine_preference, home_directory, channel_port
         ) VALUES ('acm887-incomplete', 'Incomplete fixture', 'bot', 'TUI', true, 'codex', '/tmp/incomplete', 8899)`,
      )
      const incomplete = await db.queryOne<any>(
        `SELECT desired_revision, desired_digest FROM agents WHERE agent_id = 'acm887-incomplete'`,
      )
      expect(incomplete).toMatchObject({ desired_revision: null, desired_digest: null })
      expect((await db.queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM aun_configuration_desired_outbox WHERE agent_id = 'acm887-incomplete'`,
      ))?.count).toBe('0')

      await db.execute(
        `INSERT INTO agents (
           agent_id, display_name, agent_type, runtime, profile_enabled,
           runtime_engine_preference, home_directory, channel_port,
           provider_token_source_ref, expected_provider_identity, ordinary_projection
         ) VALUES ($1,$2,'bot','TUI',true,'codex',$3,8801,$4,$5::jsonb,$6::jsonb)`,
        [
          'acm887-fixture', 'ACM887 fixture', '/tmp/acm887-fixture', 'secret-ref:test/provider',
          '{"account_id":"fixture"}',
          '{"provider_repo_root":"/tmp/provider","provider_config_root":"/tmp/provider-config","daemon_checkout":"/tmp/daemon","weight":1.0,"😀":"astral","":"private-use"}',
        ],
      )
      const first = await db.queryOne<any>('SELECT * FROM agents WHERE agent_id = $1', ['acm887-fixture'])
      const firstDesired = normalizeDesiredStateRow(first)
      const firstEvents = await db.queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM aun_configuration_desired_outbox
          WHERE agent_id = $1 AND desired_revision = $2 AND desired_digest = $3`,
        ['acm887-fixture', firstDesired.desiredRevision, firstDesired.desiredDigest],
      )
      expect(firstEvents?.count).toBe('1')

      await db.execute(`UPDATE agents SET channel_port = 8802 WHERE agent_id = $1`, ['acm887-fixture'])
      const second = await db.queryOne<any>('SELECT * FROM agents WHERE agent_id = $1', ['acm887-fixture'])
      const secondDesired = normalizeDesiredStateRow(second)
      expect(secondDesired.desiredRevision - firstDesired.desiredRevision).toBe(1)
      expect(secondDesired.desiredDigest).not.toBe(firstDesired.desiredDigest)
      const secondEvents = await db.queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM aun_configuration_desired_outbox
          WHERE agent_id = $1 AND desired_revision = $2 AND desired_digest = $3`,
        ['acm887-fixture', secondDesired.desiredRevision, secondDesired.desiredDigest],
      )
      expect(secondEvents?.count).toBe('1')

      await db.execute(`UPDATE agents SET profile_enabled = false WHERE agent_id = $1`, ['acm887-fixture'])
      const disabled = await db.queryOne<any>('SELECT * FROM agents WHERE agent_id = $1', ['acm887-fixture'])
      const disabledDesired = normalizeDesiredStateRow(disabled)
      expect(disabledDesired.profileEnabled).toBe(false)
      expect(disabledDesired.desiredRevision - secondDesired.desiredRevision).toBe(1)
      expect(disabledDesired.desiredDigest).not.toBe(secondDesired.desiredDigest)
      const disabledEvents = await db.queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM aun_configuration_desired_outbox
          WHERE agent_id = $1 AND desired_revision = $2 AND desired_digest = $3`,
        ['acm887-fixture', disabledDesired.desiredRevision, disabledDesired.desiredDigest],
      )
      expect(disabledEvents?.count).toBe('1')

      await expect(db.execute(
        `UPDATE agents SET provider_token_source_ref = $2 WHERE agent_id = $1`,
        ['acm887-fixture', 'literal:sk-abcdefghijklmnop'],
      )).rejects.toThrow('RAW_SECRET_FORBIDDEN')
      const afterRejectedSecret = await db.queryOne<any>(
        `SELECT desired_revision, desired_digest FROM agents WHERE agent_id = $1`, ['acm887-fixture'],
      )
      expect(Number(afterRejectedSecret?.desired_revision)).toBe(disabledDesired.desiredRevision)
      expect(String(afterRejectedSecret?.desired_digest)).toBe(disabledDesired.desiredDigest)

      const lease = await acquireControlPlaneLease(db, {
        scopeType: 'runtime_instance', scopeId: 'configuration-reconciler:fixture-host',
        purpose: 'maintenance', ttlMs: 45_000, holderAgentId: 'acm887-fixture',
        holderRuntimeInstanceId: null,
      })
      expect(lease.ok).toBe(true)
      if (!lease.ok) throw new Error('fixture lease unavailable')
      const observed = {
        hostId: 'fixture-host', agentId: 'acm887-fixture',
        observedRevision: disabledDesired.desiredRevision,
        observedDesiredDigest: disabledDesired.desiredDigest,
        candidateDigest: 'c'.repeat(64), releaseCommit: disabledDesired.releaseCommit,
        releaseTree: disabledDesired.releaseTree, providerNativeDigest: '1'.repeat(64),
        launchagentPlistDigest: '2'.repeat(64), launchctlEnvironmentDigest: '3'.repeat(64),
        runtimeIdentityDigest: '4'.repeat(64), reconcileStatus: 'DRIFTED' as const,
        driftReasonCodes: ['FIXTURE'], leaseId: lease.lease.lease_id,
        fencingToken: lease.lease.fencing_token,
      }
      expect(await recordConfigurationObservedState(db, {
        ...observed,
        observedRevision: secondDesired.desiredRevision,
        observedDesiredDigest: secondDesired.desiredDigest,
      })).toBe(false)
      expect(await recordConfigurationObservedState(db, { ...observed, hostId: 'wrong-host' })).toBe(false)
      expect(await recordConfigurationObservedState(db, observed)).toBe(true)
      const restartInput = {
        hostId: 'fixture-host', agentId: 'acm887-fixture', fromRevision: secondDesired.desiredRevision,
        fromDigest: secondDesired.desiredDigest, toRevision: disabledDesired.desiredRevision,
        toDigest: disabledDesired.desiredDigest, candidateDigest: 'c'.repeat(64),
        rollbackArtifactDigest: 'd'.repeat(64), exactReleaseCommit: disabledDesired.releaseCommit,
        exactReleaseTree: disabledDesired.releaseTree, exactControlRefs: disabledDesired.controlRefs,
        leaseId: lease.lease.lease_id, fencingToken: lease.lease.fencing_token, restartBudget: 1 as const,
      }
      await expect(createConfigurationRestartRequest(db, {
        ...restartInput, fencingToken: lease.lease.fencing_token + 1,
      })).rejects.toThrow('RESTART_REQUEST_FENCE_REJECTED')
      const restartRequestId = await createConfigurationRestartRequest(db, restartInput)
      expect(restartRequestId).toMatch(/^[0-9a-f-]{36}$/)
      expect((await db.queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM aun_configuration_restart_requests
          WHERE host_id = $1 AND agent_id = $2 AND lease_id = $3 AND fencing_token = $4`,
        ['fixture-host', 'acm887-fixture', lease.lease.lease_id, lease.lease.fencing_token],
      ))?.count).toBe('1')

      await db.execute(
        `INSERT INTO agents (
           agent_id, display_name, agent_type, runtime, profile_enabled,
           runtime_engine_preference, home_directory, channel_port
         ) VALUES ('codex-cto', 'CTO fixture', 'bot', 'TUI', true, 'codex', '/tmp/codex-cto', 8898)`,
      )
      const ctoLease = await acquireControlPlaneLease(db, {
        scopeType: 'runtime_instance', scopeId: 'configuration-restart:fixture-host:acm887-fixture',
        purpose: 'maintenance', ttlMs: 45_000, holderAgentId: 'codex-cto',
        holderRuntimeInstanceId: null,
      })
      expect(ctoLease.ok).toBe(true)
      if (!ctoLease.ok) throw new Error('CTO fixture lease unavailable')
      const ownerDecisionRef = 'github:owner-decision:fixture'
      const ctoReceiptMessageId = randomUUID()
      const ctoReceiptRef = `aun:agent-message:${ctoReceiptMessageId}`
      const receiptChannelId = 'aun-configuration-fixture'
      const signedReceipt = signedRestartReceipt({
        channelId: receiptChannelId, requestId: restartRequestId,
        hostId: restartInput.hostId, agentId: restartInput.agentId,
        toRevision: restartInput.toRevision, toDigest: restartInput.toDigest,
        candidateDigest: restartInput.candidateDigest,
        rollbackArtifactDigest: restartInput.rollbackArtifactDigest,
        exactReleaseCommit: restartInput.exactReleaseCommit,
        exactReleaseTree: restartInput.exactReleaseTree,
        exactControlRefs: restartInput.exactControlRefs,
        ownerDecisionRef, executionLeaseId: ctoLease.lease.lease_id,
        executionFencingToken: ctoLease.lease.fencing_token,
      })
      await db.execute(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata)
         VALUES ($1, $2, 'codex-cto', $3, 'approval', $4::jsonb)`,
        [ctoReceiptMessageId, receiptChannelId, signedReceipt.content,
          JSON.stringify(signedReceipt.metadata)],
      )
      let receiptSubmillisecondMicroseconds = 0
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const persisted = await db.queryOne<{ submillisecond_microseconds: number }>(
          `SELECT ((extract(epoch FROM created_at) * 1000000)::bigint % 1000)::int
                    AS submillisecond_microseconds
             FROM agent_messages WHERE id = $1`,
          [ctoReceiptMessageId],
        )
        receiptSubmillisecondMicroseconds = Number(persisted?.submillisecond_microseconds ?? 0)
        if (receiptSubmillisecondMicroseconds !== 0) break
        await db.execute(`UPDATE agent_messages SET created_at = DEFAULT WHERE id = $1`, [ctoReceiptMessageId])
      }
      expect(receiptSubmillisecondMicroseconds).not.toBe(0)
      await db.execute(
        `UPDATE aun_configuration_restart_requests
            SET status = 'APPROVED', owner_decision_ref = $2,
                owner_decision_expires_at = now() + interval '5 minutes',
                cto_execution_receipt_ref = $3
          WHERE request_id = $1`,
        [restartRequestId, ownerDecisionRef, ctoReceiptRef],
      )
      const executionInput = {
        requestId: restartRequestId, hostId: restartInput.hostId, agentId: restartInput.agentId,
        toRevision: restartInput.toRevision, toDigest: restartInput.toDigest,
        candidateDigest: restartInput.candidateDigest,
        rollbackArtifactDigest: restartInput.rollbackArtifactDigest,
        exactReleaseCommit: restartInput.exactReleaseCommit,
        exactReleaseTree: restartInput.exactReleaseTree,
        exactControlRefs: restartInput.exactControlRefs,
        executionLeaseId: ctoLease.lease.lease_id,
        executionFencingToken: ctoLease.lease.fencing_token,
        executorAgentId: 'codex-cto',
      }
      expect(await claimApprovedConfigurationRestartExecution(db, {
        ...executionInput, executorAgentId: 'wrong-executor',
      })).toBeNull()
      expect(await claimApprovedConfigurationRestartExecution(db, {
        ...executionInput, candidateDigest: 'f'.repeat(64),
      })).toBeNull()
      const executionClaim = await claimApprovedConfigurationRestartExecution(db, executionInput)
      expect(executionClaim).not.toBeNull()
      if (!executionClaim) throw new Error('exact restart execution claim unavailable')
      expect(await verifyConfigurationRestartExecutionClaim(db, executionClaim)).toBe(true)
      expect(await completeConfigurationRestartExecution(db, executionClaim, {
        status: 'EXECUTED', terminalReceiptDigest: '9'.repeat(64), reasonCode: null,
      })).toBe(true)
      expect(await completeConfigurationRestartExecution(db, executionClaim, {
        status: 'EXECUTED', terminalReceiptDigest: '9'.repeat(64), reasonCode: null,
      })).toBe(false)

      const expiredRequestId = await createConfigurationRestartRequest(db, {
        ...restartInput, candidateDigest: 'e'.repeat(64),
      })
      await db.execute(
        `UPDATE aun_configuration_restart_requests
            SET status = 'APPROVED', owner_decision_ref = 'github:owner-decision:expired',
                owner_decision_expires_at = now() - interval '1 second',
                cto_execution_receipt_ref = 'aun:cto-execution-receipt:expired'
          WHERE request_id = $1`,
        [expiredRequestId],
      )
      expect(await claimApprovedConfigurationRestartExecution(db, {
        ...executionInput, requestId: expiredRequestId, candidateDigest: 'e'.repeat(64),
      })).toBeNull()

      const rejectedRequestId = await createConfigurationRestartRequest(db, {
        ...restartInput, candidateDigest: 'd'.repeat(64),
      })
      await db.execute(
        `UPDATE aun_configuration_restart_requests SET status = 'REJECTED' WHERE request_id = $1`,
        [rejectedRequestId],
      )
      expect(await claimApprovedConfigurationRestartExecution(db, {
        ...executionInput, requestId: rejectedRequestId, candidateDigest: 'd'.repeat(64),
      })).toBeNull()

      for (const receiptCase of [
        { label: 'forged-signature', candidateDigest: '7'.repeat(64), forgedSignature: true },
        { label: 'wrong-active-function', candidateDigest: '8'.repeat(64), activeFunction: 'implementation_executor' },
        {
          label: 'expired-valid-signature',
          candidateDigest: '6'.repeat(64),
          timestamp: Math.floor(Date.now() / 1000) - 301,
        },
      ]) {
        const requestId = await createConfigurationRestartRequest(db, {
          ...restartInput, candidateDigest: receiptCase.candidateDigest,
        })
        const decisionRef = `github:owner-decision:${receiptCase.label}`
        const messageId = randomUUID()
        const receipt = signedRestartReceipt({
          channelId: receiptChannelId, requestId,
          hostId: restartInput.hostId, agentId: restartInput.agentId,
          toRevision: restartInput.toRevision, toDigest: restartInput.toDigest,
          candidateDigest: receiptCase.candidateDigest,
          rollbackArtifactDigest: restartInput.rollbackArtifactDigest,
          exactReleaseCommit: restartInput.exactReleaseCommit,
          exactReleaseTree: restartInput.exactReleaseTree,
          exactControlRefs: restartInput.exactControlRefs,
          ownerDecisionRef: decisionRef, executionLeaseId: ctoLease.lease.lease_id,
          executionFencingToken: ctoLease.lease.fencing_token,
        }, { activeFunction: receiptCase.activeFunction, timestamp: receiptCase.timestamp })
        if (receiptCase.forgedSignature) receipt.metadata.auth.signature = 'f'.repeat(64)
        await db.execute(
          `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata, created_at)
           VALUES ($1, $2, 'codex-cto', $3, 'approval', $4::jsonb, to_timestamp($5))`,
          [messageId, receiptChannelId, receipt.content, JSON.stringify(receipt.metadata), receipt.timestamp],
        )
        await db.execute(
          `UPDATE aun_configuration_restart_requests
              SET status = 'APPROVED', owner_decision_ref = $2,
                  owner_decision_expires_at = now() + interval '5 minutes',
                  cto_execution_receipt_ref = $3
            WHERE request_id = $1`,
          [requestId, decisionRef, `aun:agent-message:${messageId}`],
        )
        expect(await claimApprovedConfigurationRestartExecution(db, {
          ...executionInput, requestId, candidateDigest: receiptCase.candidateDigest,
        })).toBeNull()
        expect(await db.queryOne<{ status: string; execution_attempts: number }>(
          `SELECT status, execution_attempts FROM aun_configuration_restart_requests WHERE request_id = $1`,
          [requestId],
        )).toEqual({ status: 'APPROVED', execution_attempts: 0 })
      }

      await releaseControlPlaneLease(db, {
        leaseId: ctoLease.lease.lease_id, fencingToken: ctoLease.lease.fencing_token,
        holderAgentId: 'codex-cto', holderRuntimeInstanceId: null,
      })
      await db.execute(
        `INSERT INTO agents (
           agent_id, display_name, agent_type, runtime, profile_enabled,
           runtime_engine_preference, home_directory, channel_port
         ) VALUES ('other-agent', 'Ineligible fixture', 'bot', 'TUI', true, 'codex', '/tmp/other-agent', 8897)`,
      )
      const otherLease = await acquireControlPlaneLease(db, {
        scopeType: 'runtime_instance', scopeId: 'configuration-restart:fixture-host:acm887-fixture',
        purpose: 'maintenance', ttlMs: 45_000, holderAgentId: 'other-agent',
        holderRuntimeInstanceId: null,
      })
      expect(otherLease.ok).toBe(true)
      if (!otherLease.ok) throw new Error('ineligible fixture lease unavailable')
      const ineligibleCandidateDigest = 'b'.repeat(64)
      const ineligibleRequestId = await createConfigurationRestartRequest(db, {
        ...restartInput, candidateDigest: ineligibleCandidateDigest,
      })
      const ineligibleReceiptMessageId = randomUUID()
      const ineligibleOwnerDecisionRef = 'github:owner-decision:ineligible-fixture'
      const ineligibleReceipt = signedRestartReceipt({
        channelId: receiptChannelId, requestId: ineligibleRequestId,
        hostId: restartInput.hostId, agentId: restartInput.agentId,
        toRevision: restartInput.toRevision, toDigest: restartInput.toDigest,
        candidateDigest: ineligibleCandidateDigest,
        rollbackArtifactDigest: restartInput.rollbackArtifactDigest,
        exactReleaseCommit: restartInput.exactReleaseCommit,
        exactReleaseTree: restartInput.exactReleaseTree,
        exactControlRefs: restartInput.exactControlRefs,
        ownerDecisionRef: ineligibleOwnerDecisionRef,
        executionLeaseId: otherLease.lease.lease_id,
        executionFencingToken: otherLease.lease.fencing_token,
      })
      await db.execute(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata, created_at)
         VALUES ($1, $2, 'codex-cto', $3, 'approval', $4::jsonb, to_timestamp($5))`,
        [ineligibleReceiptMessageId, receiptChannelId, ineligibleReceipt.content,
          JSON.stringify(ineligibleReceipt.metadata), ineligibleReceipt.timestamp],
      )
      await db.execute(
        `UPDATE aun_configuration_restart_requests
            SET status = 'APPROVED', owner_decision_ref = $2,
                owner_decision_expires_at = now() + interval '5 minutes',
                cto_execution_receipt_ref = $3
          WHERE request_id = $1`,
        [ineligibleRequestId, ineligibleOwnerDecisionRef, `aun:agent-message:${ineligibleReceiptMessageId}`],
      )
      const ineligibleExecutionInput = {
        ...executionInput, requestId: ineligibleRequestId,
        candidateDigest: ineligibleCandidateDigest,
        executionLeaseId: otherLease.lease.lease_id,
        executionFencingToken: otherLease.lease.fencing_token,
      }
      expect(await claimApprovedConfigurationRestartExecution(db, {
        ...ineligibleExecutionInput, executorAgentId: 'other-agent',
      })).toBeNull()
      expect(await claimApprovedConfigurationRestartExecution(db, {
        ...ineligibleExecutionInput, executorAgentId: 'codex-cto',
      })).toBeNull()
      expect(await db.queryOne<{ status: string; execution_attempts: number }>(
        `SELECT status, execution_attempts FROM aun_configuration_restart_requests WHERE request_id = $1`,
        [ineligibleRequestId],
      )).toEqual({ status: 'APPROVED', execution_attempts: 0 })
      await releaseControlPlaneLease(db, {
        leaseId: otherLease.lease.lease_id, fencingToken: otherLease.lease.fencing_token,
        holderAgentId: 'other-agent', holderRuntimeInstanceId: null,
      })

      await expect(db.execute(down)).rejects.toThrow('refusing to drop nonempty AUN configuration reconciliation evidence')
      await db.execute(`DELETE FROM aun_configuration_restart_requests WHERE agent_id = $1`, ['acm887-fixture'])
      await db.execute(`DELETE FROM aun_configuration_observed_state WHERE host_id = $1 AND agent_id = $2`, ['fixture-host', 'acm887-fixture'])
      await db.execute(`DELETE FROM aun_configuration_desired_outbox WHERE agent_id = $1`, ['acm887-fixture'])
      await releaseControlPlaneLease(db, {
        leaseId: lease.lease.lease_id, fencingToken: lease.lease.fencing_token,
        holderAgentId: 'acm887-fixture', holderRuntimeInstanceId: null,
      })
      await db.execute(`DELETE FROM agents WHERE agent_id IN ($1, $2, $3, $4)`, ['acm887-fixture', 'acm887-incomplete', 'codex-cto', 'other-agent'])
      await db.execute(down)
      await db.execute(up)
      expect(await configurationSchemaSnapshot(db)).toEqual(firstSchemaDigest)
    } finally {
      if (priorAuthSecret === undefined) delete process.env.AGENT_COMMS_SECRET
      else process.env.AGENT_COMMS_SECRET = priorAuthSecret
      await db?.close().catch(() => {})
      const dropped = Bun.spawnSync(['dropdb', '-h', '/tmp', '--if-exists', databaseName], { stdout: 'pipe', stderr: 'pipe' })
      expect(dropped.exitCode).toBe(0)
    }
  }, 30_000)
})
