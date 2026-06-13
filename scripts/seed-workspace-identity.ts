/**
 * ADR-029R PR 5 — seed the Phase 1 identity SSOT for one bot workspace.
 *
 * Performs, idempotently and dry-run by default:
 *   1. verify the agent exists in `agents` (never creates agents)
 *   2. fail-closed preflight (ARC review on PR #738):
 *      - an existing agent_workspaces(org_id, local_path) row is REUSED,
 *        never duplicated;
 *      - if another agent holds an ACTIVE binding on that workspace,
 *        fail closed (workspace takeover is not seeding);
 *      - if .agent/identity.json already declares a DIFFERENT agent_id,
 *        fail closed. There is deliberately no --force: re-identifying a
 *        workspace is a migration and requires protected review, not a flag.
 *   3. upsert `agent_workspaces` + an ACTIVE `agent_workspace_bindings` row
 *   4. write `<workspace>/.agent/identity.json` (declaration only — the DB
 *      rows above are the authority, per ADR-029R §5)
 *
 * Usage:
 *   bun scripts/seed-workspace-identity.ts --agent-id <id> --workspace <path> \
 *       [--project <name>] [--org-id default] [--execute]
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'

interface Args {
  agentId?: string
  workspace?: string
  project?: string
  orgId: string
  execute: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { orgId: 'default', execute: false }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--agent-id') out.agentId = argv[++i]
    else if (argv[i] === '--workspace') out.workspace = argv[++i]
    else if (argv[i] === '--project') out.project = argv[++i]
    else if (argv[i] === '--org-id') out.orgId = argv[++i]
    else if (argv[i] === '--execute') out.execute = true
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  if (!args.agentId || !args.workspace) {
    process.stderr.write('Usage: bun scripts/seed-workspace-identity.ts --agent-id <id> --workspace <path> [--project <name>] [--org-id default] [--execute]\n')
    process.exit(2)
  }
  if (!existsSync(args.workspace)) {
    process.stderr.write(`Error: workspace path does not exist: ${args.workspace}\n`)
    process.exit(1)
  }
  const canonicalPath = realpathSync(args.workspace)
  const identityFile = join(canonicalPath, '.agent', 'identity.json')

  // Preflight 1: an existing identity.json declaring a different agent fails
  // closed before any DB work (no --force by design; see header).
  if (existsSync(identityFile)) {
    try {
      const declared = JSON.parse(readFileSync(identityFile, 'utf-8'))
      if (typeof declared?.agent_id === 'string' && declared.agent_id.trim() && declared.agent_id.trim() !== args.agentId) {
        process.stderr.write(`Error [IDENTITY_DECLARATION_CONFLICT]: ${identityFile} already declares agent_id '${declared.agent_id.trim()}' (requested '${args.agentId}'). Re-identifying a workspace is a protected migration, not a seeding operation.\n`)
        process.exit(1)
      }
    } catch (err) {
      process.stderr.write(`Error [IDENTITY_DECLARATION_UNREADABLE]: ${identityFile}: ${(err as Error).message}\n`)
      process.exit(1)
    }
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms' })
  await client.connect()
  try {
    const agent = await client.query(`SELECT 1 FROM agents WHERE agent_id = $1`, [args.agentId])
    if (agent.rows.length === 0) {
      process.stderr.write(`Error: agent_id '${args.agentId}' not present in agents — register the agent first; this tool never creates agents\n`)
      process.exit(1)
    }

    // Preflight 2: reuse an existing workspace row for this (org_id,
    // local_path) — never create a duplicate.
    const existingWs = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM agent_workspaces WHERE org_id = $1 AND local_path = $2`,
      [args.orgId, canonicalPath],
    )
    const workspaceId = existingWs.rows.length > 0
      ? existingWs.rows[0].workspace_id
      : `ws-${args.agentId}-${Buffer.from(canonicalPath).toString('base64url').slice(0, 12)}`

    // Preflight 3: an ACTIVE binding held by another agent fails closed.
    if (existingWs.rows.length > 0) {
      const otherBinding = await client.query<{ agent_id: string }>(
        `SELECT agent_id FROM agent_workspace_bindings
          WHERE workspace_id = $1 AND active = true AND agent_id <> $2
          LIMIT 1`,
        [workspaceId, args.agentId],
      )
      if (otherBinding.rows.length > 0) {
        process.stderr.write(`Error [BINDING_CONFLICT]: workspace ${workspaceId} (${canonicalPath}) has an ACTIVE binding for '${otherBinding.rows[0].agent_id}'. Workspace takeover requires protected review; this tool fails closed.\n`)
        process.exit(1)
      }
    }

    const plan = {
      agent_id: args.agentId,
      org_id: args.orgId,
      workspace_id: workspaceId,
      workspace_reused: existingWs.rows.length > 0,
      local_path: canonicalPath,
      identity_file: identityFile,
      project: args.project ?? null,
      dry_run: !args.execute,
    }

    if (!args.execute) {
      process.stdout.write(JSON.stringify({ ok: true, ...plan }, null, 2) + '\n')
      return
    }

    await client.query(
      `INSERT INTO agent_workspaces (workspace_id, org_id, name, workspace_type, local_path)
       VALUES ($1, $2, $3, 'local_path', $4)
       ON CONFLICT (workspace_id) DO UPDATE SET local_path = EXCLUDED.local_path, org_id = EXCLUDED.org_id`,
      [workspaceId, args.orgId, `${args.agentId} workspace`, canonicalPath],
    )
    await client.query(
      `INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
       VALUES ($1, $2, 'primary', true)
       ON CONFLICT (agent_id, workspace_id, binding_role) DO UPDATE SET active = true, updated_at = now()`,
      [args.agentId, workspaceId],
    )

    mkdirSync(join(canonicalPath, '.agent'), { recursive: true })
    writeFileSync(
      identityFile,
      JSON.stringify({ agent_id: args.agentId, ...(args.project ? { project: args.project } : {}) }, null, 2) + '\n',
    )

    process.stdout.write(JSON.stringify({ ok: true, ...plan, seeded: true }, null, 2) + '\n')
  } finally {
    await client.end()
  }
}

void main()
