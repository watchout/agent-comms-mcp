/**
 * ADR-029R §5 — issue a per-bot bearer credential for the Streamable HTTP
 * MCP endpoint (identity binding mode).
 *
 * Inserts sha256(token) into agent_identity_keys (key_type='bearer-sha256',
 * status='active'); the plaintext token is printed ONCE and never stored.
 *
 * Usage:
 *   bun scripts/issue-http-mcp-token.ts --agent-id <id> [--valid-days N] [--revoke-existing]
 */
import { createHash, randomBytes } from 'node:crypto'
import { Client } from 'pg'

function parseArgs(argv: string[]): { agentId?: string; validDays?: number; revokeExisting: boolean } {
  const out: { agentId?: string; validDays?: number; revokeExisting: boolean } = { revokeExisting: false }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--agent-id') out.agentId = argv[++i]
    else if (argv[i] === '--valid-days') out.validDays = parseInt(argv[++i], 10)
    else if (argv[i] === '--revoke-existing') out.revokeExisting = true
  }
  return out
}

async function main(): Promise<void> {
  const { agentId, validDays, revokeExisting } = parseArgs(process.argv)
  if (!agentId) {
    process.stderr.write('Usage: bun scripts/issue-http-mcp-token.ts --agent-id <id> [--valid-days N] [--revoke-existing]\n')
    process.exit(2)
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms' })
  await client.connect()
  try {
    const agent = await client.query(`SELECT 1 FROM agents WHERE agent_id = $1`, [agentId])
    if (agent.rows.length === 0) {
      process.stderr.write(`Error: agent_id '${agentId}' not present in agents (identity must be registered first)\n`)
      process.exit(1)
    }

    if (revokeExisting) {
      await client.query(
        `UPDATE agent_identity_keys SET status = 'revoked', revoked_at = now()
          WHERE agent_id = $1 AND key_type = 'bearer-sha256' AND status = 'active'`,
        [agentId],
      )
    }

    const token = `aunmcp_${randomBytes(32).toString('base64url')}`
    const fingerprint = createHash('sha256').update(token).digest('hex')
    const validUntil = validDays && validDays > 0 ? `now() + interval '${Math.floor(validDays)} days'` : 'NULL'

    const inserted = await client.query(
      `INSERT INTO agent_identity_keys (agent_id, key_type, public_key, fingerprint, status, valid_until, metadata)
       VALUES ($1, 'bearer-sha256', 'bearer-token-sha256', $2, 'active', ${validUntil}, $3)
       RETURNING key_id`,
      [agentId, fingerprint, JSON.stringify({ issued_by: process.env.USER ?? 'unknown', purpose: 'http-mcp-identity-binding' })],
    )

    process.stdout.write(JSON.stringify({
      ok: true,
      agent_id: agentId,
      key_id: inserted.rows[0].key_id,
      token,
      note: 'Store this token in the bot launch config (bearer_token_env_var / Authorization header). It is shown once and only its sha256 is stored.',
    }, null, 2) + '\n')
  } finally {
    await client.end()
  }
}

void main()
