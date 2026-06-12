/**
 * ADR-029R §5 Phase 1 — agent identity SSOT resolver.
 *
 * Principle: identity is never written at spawn sites. It is resolved from
 * exactly one source per process, then verified fail-closed against the DB:
 *
 *   1. explicit operator override — env AGENT_ID accompanied by BOTH
 *      AGENT_ID_OVERRIDE_REASON and AGENT_ID_OVERRIDE_ACTOR markers.
 *      In fleet mode a plain AGENT_ID (e.g. inherited from a global config
 *      layer) is NOT an override and fails closed. Every accepted override
 *      is audit-logged with reason and actor.
 *   2. workspace declaration — `<workspace>/.agent/identity.json`
 *      ({ "agent_id": "...", "project": "..." }). A declaration, never
 *      authority: it cannot bypass or create a binding.
 *   3. FAIL — there is no default identity.
 *
 * Verification (fail-closed, ARC review condition 2):
 *   realpath(workspace) → agent_workspaces(org_id, local_path) →
 *   workspace_id → ACTIVE agent_workspace_bindings(agent_id, workspace_id).
 *   A copied workspace (same identity.json, different realpath) therefore
 *   fails closed. The declared agent_id must also exist in `agents`.
 *
 * The five fail-closed negative cases in ADR-029R §5 are contract-tested in
 * tests/identity-resolver.test.ts.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export type IdentityFailureReason =
  | 'no_identity'
  | 'identity_file_invalid'
  | 'env_override_without_marker'
  | 'agent_not_registered'
  | 'workspace_not_registered'
  | 'no_active_binding'

export type IdentitySource = 'operator_override' | 'workspace_declaration'

export interface ResolvedIdentity {
  ok: true
  agent_id: string
  project: string | null
  source: IdentitySource
  workspace_path: string
  workspace_id: string | null
  override_reason?: string
  override_actor?: string
}

export interface IdentityFailure {
  ok: false
  reason: IdentityFailureReason
  detail: string
}

export type IdentityResolution = ResolvedIdentity | IdentityFailure

export interface IdentityDb {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface ResolveIdentityOptions {
  /** Workspace directory (resolved via realpath for the DB cross-check). */
  cwd: string
  env?: NodeJS.ProcessEnv
  orgId?: string
  /**
   * fleet (default): full ADR-029R discipline — plain AGENT_ID fails closed,
   * override requires both markers, DB cross-check is mandatory.
   * dev: plain AGENT_ID is accepted as an override without markers (local
   * development convenience); DB cross-check still applies.
   */
  mode?: 'fleet' | 'dev'
  /** Called for every accepted operator override (audit obligation). */
  onOverrideAccepted?: (info: { agent_id: string; reason: string; actor: string }) => void | Promise<void>
}

function fail(reason: IdentityFailureReason, detail: string): IdentityFailure {
  return { ok: false, reason, detail }
}

function readWorkspaceDeclaration(cwd: string): { agent_id: string; project: string | null } | IdentityFailure | null {
  const file = join(cwd, '.agent', 'identity.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    const agentId = typeof parsed?.agent_id === 'string' ? parsed.agent_id.trim() : ''
    if (!agentId) {
      return fail('identity_file_invalid', `${file} has no agent_id`)
    }
    const project = typeof parsed?.project === 'string' && parsed.project.trim() ? parsed.project.trim() : null
    return { agent_id: agentId, project }
  } catch (err) {
    return fail('identity_file_invalid', `${file}: ${(err as Error).message}`)
  }
}

async function verifyAgainstDb(
  db: IdentityDb,
  agentId: string,
  cwd: string,
  orgId: string,
): Promise<{ workspace_id: string } | IdentityFailure> {
  const agent = await db.query(`SELECT 1 FROM agents WHERE agent_id = $1`, [agentId])
  if (agent.rows.length === 0) {
    return fail('agent_not_registered', `agent_id '${agentId}' not present in agents`)
  }

  let canonicalPath: string
  try {
    canonicalPath = realpathSync(cwd)
  } catch (err) {
    return fail('workspace_not_registered', `realpath(${cwd}) failed: ${(err as Error).message}`)
  }

  const workspace = await db.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM agent_workspaces WHERE org_id = $1 AND local_path = $2`,
    [orgId, canonicalPath],
  )
  if (workspace.rows.length === 0) {
    return fail(
      'workspace_not_registered',
      `no agent_workspaces row for (org_id=${orgId}, local_path=${canonicalPath}) — a copied workspace fails here by design`,
    )
  }
  const workspaceId = workspace.rows[0].workspace_id

  const binding = await db.query(
    `SELECT 1 FROM agent_workspace_bindings WHERE agent_id = $1 AND workspace_id = $2 AND active = true`,
    [agentId, workspaceId],
  )
  if (binding.rows.length === 0) {
    return fail('no_active_binding', `no active agent_workspace_bindings row for (${agentId}, ${workspaceId})`)
  }

  return { workspace_id: workspaceId }
}

export async function resolveAgentIdentity(
  db: IdentityDb,
  opts: ResolveIdentityOptions,
): Promise<IdentityResolution> {
  const env = opts.env ?? process.env
  const mode = opts.mode ?? 'fleet'
  const orgId = opts.orgId ?? 'default'

  const envAgentId = env.AGENT_ID?.trim() || null
  const overrideReason = env.AGENT_ID_OVERRIDE_REASON?.trim() || null
  const overrideActor = env.AGENT_ID_OVERRIDE_ACTOR?.trim() || null

  // 1. Operator override path.
  if (envAgentId) {
    const hasMarkers = !!(overrideReason && overrideActor)
    if (!hasMarkers && mode === 'fleet') {
      // The 2026-06-12 incident class: an inherited global AGENT_ID carries
      // no marker and must fail closed, not silently win.
      return fail(
        'env_override_without_marker',
        `AGENT_ID='${envAgentId}' present without AGENT_ID_OVERRIDE_REASON + AGENT_ID_OVERRIDE_ACTOR (fleet mode forbids unmarked env identity)`,
      )
    }
    const verified = await verifyAgainstDb(db, envAgentId, opts.cwd, orgId)
    if ('ok' in verified) return verified
    if (hasMarkers) {
      await opts.onOverrideAccepted?.({ agent_id: envAgentId, reason: overrideReason!, actor: overrideActor! })
    }
    return {
      ok: true,
      agent_id: envAgentId,
      project: null,
      source: 'operator_override',
      workspace_path: opts.cwd,
      workspace_id: verified.workspace_id,
      ...(hasMarkers ? { override_reason: overrideReason!, override_actor: overrideActor! } : {}),
    }
  }

  // 2. Workspace declaration path.
  const declared = readWorkspaceDeclaration(opts.cwd)
  if (declared === null) {
    return fail('no_identity', `no AGENT_ID override and no ${join(opts.cwd, '.agent', 'identity.json')}`)
  }
  if ('ok' in declared) return declared

  const verified = await verifyAgainstDb(db, declared.agent_id, opts.cwd, orgId)
  if ('ok' in verified) return verified

  return {
    ok: true,
    agent_id: declared.agent_id,
    project: declared.project,
    source: 'workspace_declaration',
    workspace_path: opts.cwd,
    workspace_id: verified.workspace_id,
  }
}
