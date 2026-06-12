/**
 * ADR-029R PR 5 — seed the Phase 1 identity SSOT for one bot workspace.
 *
 * Performs, idempotently and dry-run by default:
 *   1. verify the agent exists in `agents` (never creates agents)
 *   2. upsert `agent_workspaces` (org_id, local_path=realpath(workspace))
 *   3. upsert an ACTIVE `agent_workspace_bindings` row
 *   4. write `<workspace>/.agent/identity.json` (declaration only — the DB
 *      rows above are the authority, per ADR-029R §5)
 *
 * Usage:
 *   bun scripts/seed-workspace-identity.ts --agent-id <id> --workspace <path> \
 *       [--project <name>] [--org-id default] [--execute]
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
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
  const workspaceId = `ws-${args.agentId}-${Buffer.from(canonicalPath).toString('base64url').slice(0, 12)}`
  const identityFile = join(canonicalPath, '.agent', 'identity.json')

  const plan = {
    agent_id: args.agentId,
    org_id: args.orgId,
    workspace_id: workspaceId,
    local_path: canonicalPath,
    identity_file: identityFile,
    project: args.project ?? null,
    dry_run: !args.execute,
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms' })
  await client.connect()
  try {
    const agent = await client.query(`SELECT 1 FROM agents WHERE agent_id = $1`, [args.agentId])
    if (agent.rows.length === 0) {
      process.stderr.write(`Error: agent_id '${args.agentId}' not present in agents — register the agent first; this tool never creates agents\n`)
      process.exit(1)
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
