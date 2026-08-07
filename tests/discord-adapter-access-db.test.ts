#!/usr/bin/env bun
/**
 * Phase 2 G — scripts/discord-adapter.ts の access.json 依存除去 source-pin.
 *
 * Pre-v2.1.0 the legacy Discord adapter (`scripts/discord-adapter.ts`) read
 * a JSON file (`access.json`) via `DISCORD_STATE_DIR` env, producing the
 * `Access` struct used by `gate()` to permit / drop incoming messages.
 * v2.1.0 moves this to the DB: `channels.members` + `agents.discord_user_id`
 * are the single source of truth (spec §20 廃止: access.json / plugin:discord).
 *
 * Shell-script runtime tests are out of scope — this file pins the contract
 * at the source level so a refactor that accidentally reintroduces
 * `readFileSync('access.json')` or `DISCORD_STATE_DIR` breaks the test.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gate, type Access } from '../scripts/discord-adapter'

const REPO_ROOT = join(import.meta.dir, '..')
const SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'discord-adapter.ts'), 'utf-8')

describe('G1 — access.json file reads removed', () => {
  test('no `readFileSync` import from node:fs (access.json was the only user)', () => {
    // The module no longer needs node:fs — the only file read was the
    // access.json parse, now replaced with a DB query.
    expect(SCRIPT).not.toMatch(/import[^;]*readFileSync[^;]*from 'node:fs'/)
  })
  test('no `DISCORD_STATE_DIR` env var reads', () => {
    expect(SCRIPT).not.toMatch(/process\.env\.DISCORD_STATE_DIR/)
  })
  test('no `ACCESS_FILE` const (renamed / removed)', () => {
    expect(SCRIPT).not.toMatch(/\bconst\s+ACCESS_FILE\b/)
  })
  test('loadAccess() no longer accepts a filePath argument', () => {
    // The v2.1.0 signature is `loadAccess(): Promise<Access>`; the legacy
    // `loadAccess(filePath: string): Access` signature is gone.
    expect(SCRIPT).toMatch(/export async function loadAccess\(\)\s*:\s*Promise<Access>/)
    expect(SCRIPT).not.toMatch(/export function loadAccess\(filePath:/)
  })
})

describe('G2 — DB-backed Access source', () => {
  test('imports pg.Client for DB access lookup', () => {
    expect(SCRIPT).toMatch(/import\s+\{\s*Client as PgClient\s*\}\s+from 'pg'/)
  })
  test('SELECT pulls metadata->>discord_id from agents table (DM allowlist source, ADR-040 D1)', () => {
    // Phase C H G-live regression: the pre-hotfix query referenced a
    // non-existent `agents.discord_user_id` column on PG (SQLite migrate
    // had it, PG migrate never did). ADR-040 D1 stores the Discord id in
    // `agents.metadata.discord_id` (JSONB). The SQLite adapter's adaptSql
    // auto-rewrites `metadata->>'discord_id'` into `json_extract(metadata,
    // '$.discord_id')`, so the same query string runs against both DBs.
    expect(SCRIPT).toMatch(/SELECT agent_id, metadata->>'discord_id' AS discord_user_id FROM agents WHERE metadata->>'discord_id' IS NOT NULL/)
    // Negative pin: the pre-hotfix column-based query MUST NOT reappear.
    expect(SCRIPT).not.toMatch(/SELECT agent_id, discord_user_id FROM agents WHERE discord_user_id IS NOT NULL/)
  })
  test('SELECT pulls members from channels table (per-channel allowlist source)', () => {
    expect(SCRIPT).toMatch(/SELECT id, members FROM channels/)
  })
  test('loadAccess defaults to `dmPolicy: allowlist` (not pre-v2.1.0 pairing)', () => {
    // Pre-v2.1.0 default was 'pairing' (file-based pairing workflow); the DB
    // source has no concept of pending pairings, so default is 'allowlist'.
    expect(SCRIPT).toMatch(/dmPolicy: 'allowlist'/)
  })
  test('groups[channel_id] keeps `requireMention: true` default (traffic control)', () => {
    // The DB schema has no requireMention column, but flipping it to false
    // would flood every bot with every channel message. The v2.1.0 default
    // preserves the pre-v2.1.0 "only @mentions" gate.
    expect(SCRIPT).toMatch(/requireMention: true/)
  })

  test('empty channels.members projection fails closed instead of accepting every guild sender', () => {
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['discord-member'],
      groups: { 'channel-a': { requireMention: true, allowFrom: [] } },
      pending: {},
    }

    expect(gate(access, 'discord-member', 'channel-a', null, false, true)).toEqual({
      action: 'drop',
      reason: 'not in channel allowFrom',
    })
  })

  test('guild receive passes only for a projected channels.members identity', () => {
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['discord-member', 'discord-outsider'],
      groups: { 'channel-a': { requireMention: true, allowFrom: ['discord-member'] } },
      pending: {},
    }

    expect(gate(access, 'discord-member', 'channel-a', null, false, true)).toEqual({ action: 'deliver' })
    expect(gate(access, 'discord-outsider', 'channel-a', null, false, true)).toEqual({
      action: 'drop',
      reason: 'not in channel allowFrom',
    })
  })
})

describe('G3 — mentionPatterns (regex list) removed', () => {
  test('Access interface no longer carries `mentionPatterns` field', () => {
    // The field was carried through from access.json for regex alt-mentions
    // (e.g. matching "CTO" literally). v2.1.0 drops it; Discord @mentions
    // are the only source.
    const accessBlock = SCRIPT.match(/export interface Access \{[\s\S]*?\n\}/)
    expect(accessBlock).toBeTruthy()
    expect(accessBlock?.[0]).not.toMatch(/mentionPatterns/)
  })
  test('checkMentioned() signature drops the extraPatterns parameter', () => {
    expect(SCRIPT).toMatch(/function checkMentioned\(msg: Message, botUserId: string\): boolean/)
  })
  test('no RegExp construction on access-loaded patterns', () => {
    // Negative pin: the old body constructed `new RegExp(pat, 'i')` per
    // access.mentionPatterns entry. Dropped — should not reappear.
    const fnMatch = SCRIPT.match(/function checkMentioned[\s\S]*?\n\}/)
    expect(fnMatch).toBeTruthy()
    expect(fnMatch?.[0]).not.toContain('new RegExp')
  })
})

describe('G4 — all call sites await the async loadAccess()', () => {
  test('all `loadAccess` call sites use `await loadAccess()` (no file path)', () => {
    // Negative pin: the pre-v2.1.0 call shape `loadAccess(ACCESS_FILE)` MUST NOT
    // appear anywhere.
    expect(SCRIPT).not.toMatch(/loadAccess\(ACCESS_FILE\)/)
    // Positive pin: every callsite now reads as `await loadAccess()`.
    const callsites = SCRIPT.match(/\bawait loadAccess\(\)/g) ?? []
    expect(callsites.length).toBeGreaterThanOrEqual(3)
  })
})
