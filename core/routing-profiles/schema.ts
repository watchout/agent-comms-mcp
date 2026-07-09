// CELL-4MCP-AUN-001 — aun_agent_routing_profiles schema.
//
// Contract authority: SPEC-4MCP-002 v0.2 (iyasaka-arc#25 comment 4918634113,
// frozen) + lane handoff agent-comms-mcp#853. Columns are EXACTLY the
// Contract B set — nothing else. The forbidden peer-domain columns
// (active_function / authority_scope / memory_partition / index_policy) are
// absent by construction and pinned absent by fixture: AUN's table cannot
// express Shirube/Kusabi/Kodama domain state at all.
//
// agent_id is the immutable identity key (the ONLY identity key): renames
// are blocked at the storage layer, mirroring EventLogCore's trigger
// discipline.

import type { DbAdapter } from '../db/adapter'

/** Contract B column allowlist, pinned by fixture against PRAGMA table_info. */
export const ROUTING_PROFILE_COLUMNS = [
  'agent_id',
  'routing_status',
  'delivery_targets_json',
  'channel_bindings_json',
  'queue_visibility',
  'routing_source_ref',
  'updated_at',
] as const

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS aun_agent_routing_profiles (
    agent_id TEXT PRIMARY KEY,
    routing_status TEXT NOT NULL DEFAULT 'active',
    delivery_targets_json TEXT NOT NULL DEFAULT '[]',
    channel_bindings_json TEXT NOT NULL DEFAULT '[]',
    queue_visibility TEXT NOT NULL DEFAULT 'default',
    routing_source_ref TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  // agent_id is immutable — identity renames are not a thing.
  `CREATE TRIGGER IF NOT EXISTS aun_routing_profiles_agent_id_immutable
   BEFORE UPDATE OF agent_id ON aun_agent_routing_profiles
   BEGIN SELECT RAISE(ABORT, 'agent_id is the immutable identity key: rename forbidden'); END`,
]

export async function ensureRoutingProfilesSchema(db: DbAdapter): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.execute(stmt)
  }
}
