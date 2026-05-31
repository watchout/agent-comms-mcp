#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #132 — agent-com CLI MVP commands.
 *
 * Background:
 *   message-queue-spec §4-6 defines `agent-com next / send / agents` as the
 *   canonical CLI for bot message I/O. Issue #132 ships an MVP that wires
 *   these commands into the existing `cli/index.ts` on top of the current
 *   DB + filesystem-signal infrastructure (no new tables required).
 *
 * These tests are source-level + dispatch-level: we verify that
 *   1. cli/index.ts defines handler functions for next/send/agents,
 *   2. each command name is reachable from the top-level dispatch,
 *   3. the package.json `agent-com` bin entry points at this file, and
 *   4. running `agent-com next` without AGENT_ID prints the env-var error
 *      and exits non-zero (the only behavior we can verify without a DB).
 *
 * Live DB-backed integration tests are intentionally out of scope for the
 * MVP — those run in the post-merge verification step on dev environment.
 *
 * See:
 *   - cli/index.ts                                            (handlers + dispatch)
 *   - github.com/watchout/agent-comms-mcp/issues/132
 *   - docs/agent-com-message-queue-spec.md §4-6              (canonical spec)
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CLI_PATH = join(REPO_ROOT, 'cli', 'index.ts')
const PKG_PATH = join(REPO_ROOT, 'package.json')
const QUEUE_DOCTOR_PATH = join(REPO_ROOT, 'core', 'queue-doctor.ts')
const QUEUE_NORMALIZATION_PATH = join(REPO_ROOT, 'core', 'queue-normalization.ts')
const QUEUE_REPAIR_PATH = join(REPO_ROOT, 'core', 'queue-repair.ts')
const DIRECTORY_PATH = join(REPO_ROOT, 'core', 'directory.ts')
const RUNTIME_INVENTORY_PATH = join(REPO_ROOT, 'core', 'runtime-inventory.ts')
const RUNTIME_CLEANUP_PATH = join(REPO_ROOT, 'core', 'runtime-cleanup.ts')
const INBOUND_SMOKE_PATH = join(REPO_ROOT, 'core', 'inbound-smoke.ts')
const AUN_FLEET_READINESS_PATH = join(REPO_ROOT, 'core', 'aun-fleet-readiness.ts')
const FULL_CHANNEL_SMOKE_PATH = join(REPO_ROOT, 'core', 'full-channel-smoke.ts')
const STATE_DAEMON_READINESS_PATH = join(REPO_ROOT, 'core', 'state-daemon-readiness.ts')
const CONTROL_PLANE_LEASES_PATH = join(REPO_ROOT, 'core', 'control-plane-leases.ts')
const CHANNEL_CONNECTOR_SYNC_PATH = join(REPO_ROOT, 'core', 'channel-connector-sync.ts')
const CHANNEL_REGISTRATION_RECONCILE_PATH = join(REPO_ROOT, 'core', 'channel-registration-reconcile.ts')

const CLI_SRC = readFileSync(CLI_PATH, 'utf-8')
const QUEUE_DOCTOR_SRC = readFileSync(QUEUE_DOCTOR_PATH, 'utf-8')
const QUEUE_NORMALIZATION_SRC = readFileSync(QUEUE_NORMALIZATION_PATH, 'utf-8')
const QUEUE_REPAIR_SRC = readFileSync(QUEUE_REPAIR_PATH, 'utf-8')
const DIRECTORY_SRC = readFileSync(DIRECTORY_PATH, 'utf-8')
const RUNTIME_INVENTORY_SRC = readFileSync(RUNTIME_INVENTORY_PATH, 'utf-8')
const RUNTIME_CLEANUP_SRC = readFileSync(RUNTIME_CLEANUP_PATH, 'utf-8')
const INBOUND_SMOKE_SRC = readFileSync(INBOUND_SMOKE_PATH, 'utf-8')
const AUN_FLEET_READINESS_SRC = readFileSync(AUN_FLEET_READINESS_PATH, 'utf-8')
const FULL_CHANNEL_SMOKE_SRC = readFileSync(FULL_CHANNEL_SMOKE_PATH, 'utf-8')
const STATE_DAEMON_READINESS_SRC = readFileSync(STATE_DAEMON_READINESS_PATH, 'utf-8')
const CONTROL_PLANE_LEASES_SRC = readFileSync(CONTROL_PLANE_LEASES_PATH, 'utf-8')
const CHANNEL_CONNECTOR_SYNC_SRC = readFileSync(CHANNEL_CONNECTOR_SYNC_PATH, 'utf-8')
const CHANNEL_REGISTRATION_RECONCILE_SRC = readFileSync(CHANNEL_REGISTRATION_RECONCILE_PATH, 'utf-8')
const PKG = JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { bin?: Record<string, string> }

// ─────────────────────────────────────────────────────────────────────────────
// T1: handler functions exist
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: a refactor that renames or removes any of next / send /
// agents would silently break the spec-defined CLI surface. Anchor on the
// declared function names so the failure points at the offending rename.
describe('T1 — cli/index.ts defines handler functions for next/send/agents', () => {
  test('nextMessage handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function nextMessage\s*\(/)
  })
  test('sendMessage handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function sendMessage\s*\(/)
  })
  test('listAgents handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function listAgents\s*\(/)
  })
  test('diagnoseProjection handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function diagnoseProjection\s*\(/)
  })
  test('diagnoseQueue handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function diagnoseQueue\s*\(/)
  })
  test('repairQueue handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function repairQueue\s*\(/)
  })
  test('directory handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function directory\s*\(/)
  })
  test('runtimeCommand handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function runtimeCommand\s*\(/)
  })
  test('inboundCommand handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function inboundCommand\s*\(/)
  })
  test('channelPolicy handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function channelPolicy\s*\(/)
  })
  test('leaseCommand handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function leaseCommand\s*\(/)
  })
  test('fleetCommand handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function fleetCommand\s*\(/)
  })
  test('agentProfile handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function agentProfile\s*\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: dispatch routes the three command names to their handlers
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: handlers exist but never get called because the top-level
// argv switch lost a branch. Pin both the command literal and the call site.
describe('T2 — top-level dispatch routes next/send/agents', () => {
  test("'next' command invokes nextMessage()", () => {
    expect(CLI_SRC).toMatch(/command === 'next'[\s\S]*?nextMessage\(\)/)
  })
  test("'send' command invokes sendMessage(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'send'[\s\S]*?sendMessage\(/)
  })
  test("'agents' command invokes listAgents()", () => {
    expect(CLI_SRC).toMatch(/command === 'agents'[\s\S]*?listAgents\(\)/)
  })
  test("'diagnose-projection' command invokes diagnoseProjection(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'diagnose-projection'[\s\S]*?diagnoseProjection\(/)
  })
  test("'diagnose-queue' and 'queue doctor' commands invoke diagnoseQueue(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'diagnose-queue'[\s\S]*?diagnoseQueue\(/)
    expect(CLI_SRC).toMatch(/command === 'queue' && subcommand === 'doctor'[\s\S]*?diagnoseQueue\(/)
  })
  test("'queue' repair subcommands invoke repairQueue(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'queue'[\s\S]*?repairQueue\(/)
  })
  test("'directory' command invokes directory(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'directory'[\s\S]*?directory\(/)
  })
  test("'runtime' command invokes runtimeCommand(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'runtime'[\s\S]*?runtimeCommand\(subcommand, rest\)/)
  })
  test("'inbound' command invokes inboundCommand(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'inbound'[\s\S]*?inboundCommand\(subcommand, rest\)/)
  })
  test("'channel policy' subcommands invoke channelPolicy(...)", () => {
    expect(CLI_SRC).toMatch(/subcommand === 'policy'[\s\S]*?channelPolicy\(rest\)/)
  })
  test("'lease' command invokes leaseCommand(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'lease'[\s\S]*?leaseCommand\(subcommand, rest\)/)
  })
  test("'fleet' command invokes fleetCommand(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'fleet'[\s\S]*?fleetCommand\(subcommand, rest\)/)
  })
  test("'agent profile' subcommands invoke agentProfile(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'agent'[\s\S]*?subcommand === 'profile'[\s\S]*?agentProfile\(rest\)/)
  })
})

describe('T2b — bot profile projection/write invariants', () => {
  test('profile set casts channel_port parameters for Postgres writes', () => {
    expect(CLI_SRC).toMatch(/CASE WHEN \$22 THEN \$21::int ELSE NULL END/)
    expect(CLI_SRC).toMatch(/channel_port = CASE WHEN \$22 THEN \$21::int ELSE agents\.channel_port END/)
  })

  test('profile set uses the Postgres sequence for implicit ui_id allocation', () => {
    expect(CLI_SRC).toMatch(/const implicitUiIdSql = isSqliteMode\(\)[\s\S]*?nextval\('agent_ui_id_seq'\)/)
    expect(CLI_SRC).toMatch(/CASE WHEN \$24 THEN \$23::bigint ELSE \$\{implicitUiIdSql\} END/)
    expect(CLI_SRC).toMatch(/COALESCE\(agents\.ui_id, \$\{implicitUiIdSql\}\)/)
  })

  test('profile project links active runtime rows to the projected workspace', () => {
    expect(CLI_SRC).toMatch(/table: 'agent_runtime_instances'[\s\S]*?action: 'link_active_workspace'/)
    expect(CLI_SRC).toMatch(/UPDATE agent_runtime_instances[\s\S]*?SET workspace_id = \$2[\s\S]*?status IN \('running', 'active'\)[\s\S]*?workspace_id IS NULL/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: package.json bin entry points at cli/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: the spec requires `agent-com` to be the canonical bin
// name (not `agent-comms-mcp`). A drift in package.json would silently break
// downstream installs that rely on `npx agent-com next`.
describe('T3 — package.json bin.agent-com points at cli/index.ts', () => {
  test('bin.agent-com resolves to cli/index.ts', () => {
    expect(PKG.bin).toBeDefined()
    // Allow either `./cli/index.ts` or `cli/index.ts` — npm normalises both.
    expect(PKG.bin?.['agent-com']).toMatch(/^\.?\/?cli\/index\.ts$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4: `agent-com next` without AGENT_ID exits non-zero with the env error
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: the only end-to-end check we can run without a DB is the
// pre-flight env validation. If `requireAgentId` ever returns silently or the
// error message gets re-worded, this test catches it. Strip AGENT_ID from
// the spawned env explicitly so a developer who sets it locally still sees a
// deterministic test.
describe('T4 — `agent-com next` requires AGENT_ID', () => {
  test('exits non-zero with the AGENT_ID error message', () => {
    const env = { ...process.env }
    delete env.AGENT_ID
    const result = spawnSync('bun', [CLI_PATH, 'next'], {
      env,
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AGENT_ID')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5: agent-com send fans out message_queue rows per recipient via fanoutToRecipients
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: Phase 2 F cycle 2 (CTO option (a), msg 1495781874977734814).
// Pre-v2.1.0 the CLI delegated fanout to the daemon via
// `SELECT pg_notify('agent_inbox', …)`; in SQLite mode no LISTEN-er was
// attached, so recipients never saw the message (auditor BLOCKER on PR #224).
// The delegation was replaced with a direct call to `fanoutToRecipients()`
// which INSERTs one `message_queue` row per recipient and signals their
// bot-runner, working identically on PG and SQLite. Pin both:
//   (a) the call is invoked with `recipients: mentions` (per-mention fanout)
//   (b) the old `SELECT pg_notify('agent_inbox', …)` path is GONE
describe('T5 — `agent-com send` fans out message_queue rows per recipient', () => {
  test('sendMessage calls fanoutToRecipients with recipients: mentions', () => {
    // Find the sendMessage function body so the regex doesn't accidentally
    // match an unrelated fanout site (there's also one in notifyMessage).
    const fnStart = CLI_SRC.indexOf('async function sendMessage')
    expect(fnStart).toBeGreaterThan(-1)
    // Walk to the end of the function (next top-level `async function` or EOF).
    const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
    const body = CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)

    // (a) Body invokes fanoutToRecipients and passes `recipients: mentions`.
    expect(body).toMatch(/fanoutToRecipients\(/)
    expect(body).toMatch(/recipients:\s*mentions\b/)

    // (b) Negative: the old PG LISTEN delegation must not reappear.
    expect(body).not.toMatch(/SELECT pg_notify\('agent_inbox'/)
    expect(body).not.toMatch(/to:\s*recipient\b/)
  })
})

// Helper: extract the body of sendMessage so T6/T7/T8 don't match unrelated text.
function sendMessageBody(): string {
  const fnStart = CLI_SRC.indexOf('async function sendMessage')
  const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
  return CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
}

// ─────────────────────────────────────────────────────────────────────────────
// T6: cli `send` queues outbound delivery via outbound_queue (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: Phase 1.5 used a local `deliverToDiscord` REST helper
// that ran inside the transaction and failed synchronously. Phase 3 (Issue
// #129) replaces it with an outbound_queue INSERT — the receiver consumer
// dequeues and posts asynchronously. The legacy helper MUST be gone.
// Detailed Phase 3 invariants live in
// tests/spec-enforcement/outbound-queue-phase3.test.ts; this test only pins
// the legacy helper's removal so a future revert is caught here too.
describe('T6 — `agent-com send` no longer calls deliverToDiscord (Phase 3)', () => {
  test('legacy deliverToDiscord helper is removed', () => {
    expect(CLI_SRC).not.toMatch(/async function deliverToDiscord\s*\(/)
  })
  test('sendMessage no longer references deliverToDiscord or discord.com REST API', () => {
    const body = sendMessageBody()
    expect(body).not.toMatch(/deliverToDiscord\(/)
    expect(body).not.toMatch(/discord\.com\/api\//)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T7: HMAC auth metadata is built and stamped into the INSERT
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: ARC codex audit (2026-04-10) flagged that CLI-originated
// rows had no metadata.auth, so receivers running with auth.mode === 'enforce'
// dropped them as [UNVERIFIED]. The fix mirrors server.ts:createAuthMetadata
// and folds the result into the INSERT metadata. Pin both the helper and
// the fold-in.
describe('T7 — `agent-com send` builds and stamps HMAC auth metadata', () => {
  test('buildAuthMetadata helper is defined and uses createHmac', () => {
    expect(CLI_SRC).toMatch(/function buildAuthMetadata\s*\(/)
    expect(CLI_SRC).toMatch(/createHmac\s*\(\s*'sha256'/)
  })
  test('sendMessage merges authMeta into the INSERT metadata', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/const authMeta\s*=\s*buildAuthMetadata\(/)
    // The fold can be `...(authMeta ?? {})` or equivalent — assert authMeta
    // is referenced inside the metadata literal. Distance grew with the
    // PR#134 transaction wrapper so the lookahead window is loose.
    expect(body).toMatch(/metadata[\s\S]{0,300}authMeta/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T8: thread_id flows from `next` → state file → INSERT → outbound delivery
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: ARC codex audit (2026-04-10) flagged that replies landed
// in the parent channel even when the original message was in a thread,
// because the in-flight state never carried thread_id. Pin the entire chain:
//   (a) `nextMessage` SELECTs thread_id and writes it into the state file
//   (b) `sendMessage` reads thread_id from state and passes it to INSERT
//   (c) `sendMessage` passes the same threadId to deliverToDiscord
function nextMessageBody(): string {
  const fnStart = CLI_SRC.indexOf('async function nextMessage')
  const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
  return CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
}

describe('T8 — thread_id flows from next → send → outbound', () => {
  // Phase 4 (Issue #130): the signal-mode fallback is removed. thread_id
  // now flows exclusively through the message_queue payload. The intent is
  // unchanged: the reply must land in the same thread as the original.
  test('next path threads thread_id through queue payload', () => {
    const queueBody = nextMessageBody()
    // Queue mode: payload.thread_id is surfaced on the response.
    expect(queueBody).toMatch(/thread_id:\s*payload\.thread_id\s*\?\?\s*null/)
  })
  test('sendMessage resolves threadId from target.thread_id (queue-only)', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/const threadId:\s*string \| null\s*=\s*target\.thread_id/)
    // Queue resolution branch defaults null:
    expect(body).toMatch(/thread_id:\s*payload\.thread_id\s*\?\?\s*null/)
  })
  test('sendMessage INSERTs thread_id (not the literal NULL)', () => {
    const body = sendMessageBody()
    // The INSERT must bind threadId rather than the previous hardcoded NULL.
    expect(body).toMatch(/'agent-comms',\s*\$8,\s*'outbound'/)
    expect(body).toMatch(/JSON\.stringify\(metadata\),\s*threadId/)
    // Negative: the previous shape hardcoded NULL between 'agent-comms' and 'outbound'.
    expect(body).not.toMatch(/'agent-comms',\s*NULL,\s*'outbound'/)
  })
  // Phase 3 (Issue #129): outbound delivery is async via outbound_queue.
  // The thread_id flow continues — the queued row's channel_external_id is
  // resolved through thread_adapters first (so the post lands in the thread,
  // not the parent channel). Pin both the resolution lookup and the fact
  // that threadId still flows into the lookup.
  test('sendMessage resolves channel_external_id via thread_adapters when threadId is set', () => {
    const body = sendMessageBody()
    const projectionSrc = readFileSync(join(REPO_ROOT, 'core', 'outbound-projection.ts'), 'utf-8')
    expect(body).toMatch(/resolveOutboundProjectionDecision\(db as any,\s*\{\s*channelId,\s*threadId,\s*senderAgentId:\s*agentId,\s*recipientAgentIds:\s*mentions,\s*\}/)
    expect(projectionSrc).toMatch(/if\s*\(\s*input\.threadId\s*\)\s*\{[\s\S]{0,500}thread_adapters/)
  })
})

describe('T9 — projection diagnostics CLI surface', () => {
  test('help documents diagnose-projection preview command', () => {
    expect(CLI_SRC).toMatch(/diagnose-projection --channel <id> --from <agent> --to <agent>\[,<agent>\]/)
    expect(CLI_SRC).toMatch(/terminal preview of surface\/projection routing/)
  })

  test('diagnoseProjection passes recipientAgentIds to the projection resolver', () => {
    expect(CLI_SRC).toMatch(/const toAgentIds = [\s\S]*?\.split\(','/)
    expect(CLI_SRC).toMatch(/resolveOutboundProjectionDecision\(db as any,\s*\{[\s\S]*?senderAgentId:\s*fromAgentId,[\s\S]*?recipientAgentIds:\s*toAgentIds,[\s\S]*?\}/)
    expect(CLI_SRC).toMatch(/projection_source/)
    expect(CLI_SRC).toMatch(/projection_fallback_reason/)
    expect(CLI_SRC).toMatch(/Consumer status:/)
    expect(CLI_SRC).toMatch(/Projection status:/)
  })
})

describe('T10 — queue doctor CLI surface', () => {
  test('help documents diagnose-queue and queue doctor', () => {
    expect(CLI_SRC).toMatch(/diagnose-queue \[--agent-id <id>\] \[--stale-minutes 15\] \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/queue doctor \[--agent-id <id>\] \[--stale-minutes 15\] \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/queue health blockers and stale-work diagnostics/)
    expect(CLI_SRC).toMatch(/queue preflight \[--gate all\|runtime\|projection\] \[--agent-id <id>\] \[--stale-minutes 15\] \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/restart gate; exits non-zero while selected queue blockers remain/)
    expect(CLI_SRC).toMatch(/queue normalize \[--agent-id <id>\] \[--stale-minutes 15\] \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/dry-run normalization plan with scoped repair commands/)
  })

  test('diagnoseQueue reports the P0 blocker classes', () => {
    expect(QUEUE_DOCTOR_SRC).toMatch(/legacy_status_mix/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/stale_pending/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/active_claim_missing_owner/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/expired_active_claim/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/retired_or_offline_recipient/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/loop_prompt_backlog/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/outbound_pending_stale/)
  })

  test('queue preflight supports subsystem gates for daemon restart safety', () => {
    expect(CLI_SRC).toMatch(/flags\.gate \?\? 'all'/)
    expect(CLI_SRC).toMatch(/'runtime'[\s\S]*?'loop_prompt_backlog'/)
    expect(CLI_SRC).toMatch(/'projection'[\s\S]*?'outbound_pending_stale'/)
    expect(CLI_SRC).toMatch(/failed_blocker_codes/)
    expect(CLI_SRC).toMatch(/Preflight\(\$\{gate\}\)/)
  })

  test('queue repair commands are documented and audit logged', () => {
    expect(CLI_SRC).toMatch(/command === 'queue'[\s\S]*?repairQueue\(/)
    expect(CLI_SRC).toMatch(/subcommand === 'normalize'[\s\S]*?buildQueueNormalizationReport/)
    expect(QUEUE_NORMALIZATION_SRC).toMatch(/deriveQueueNormalizationReport/)
    expect(QUEUE_NORMALIZATION_SRC).toMatch(/approval_required/)
    expect(CLI_SRC).toMatch(/queue reassign --from <agent> --to <agent> \[--execute\|--dry-run\]/)
    expect(CLI_SRC).toMatch(/queue close-obsolete --agent-id <agent> --reason <text> \[--queue-id <id>\] \[--include-active\] \[--execute\|--dry-run\]/)
    expect(CLI_SRC).toMatch(/queue reclaim-expired \[--agent-id <agent>\] \[--execute\|--dry-run\]/)
    expect(CLI_SRC).toMatch(/dry-run by default/)
    expect(QUEUE_REPAIR_SRC).toMatch(/queue\.reassign/)
    expect(QUEUE_REPAIR_SRC).toMatch(/queue\.close_obsolete/)
    expect(QUEUE_REPAIR_SRC).toMatch(/queue\.reclaim_expired/)
    expect(QUEUE_REPAIR_SRC).toMatch(/QUEUE_REPAIR_INCLUDE_ACTIVE_REQUIRES_QUEUE_ID/)
  })

  test('queue repair rejects --execute and --dry-run together before DB access', () => {
    const result = spawnSync('bun', [CLI_PATH, 'queue', 'reclaim-expired', '--execute', '--dry-run'], {
      env: { ...process.env, DATABASE_URL: '' },
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('use either --execute or --dry-run')
  })
})

describe('T11 — bot/channel directory CLI surface', () => {
  test('help documents the directory report', () => {
    expect(CLI_SRC).toMatch(/directory \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/bot\/channel directory and sendability report/)
  })

  test('directory report pins DB as SSOT and JSON as seed/export policy', () => {
    expect(DIRECTORY_SRC).toMatch(/db_ssot/)
    expect(DIRECTORY_SRC).toMatch(/stable logical slug/)
    expect(DIRECTORY_SRC).toMatch(/JSON is bootstrap\/policy compatibility/)
    expect(DIRECTORY_SRC).toMatch(/channel_id_looks_like_platform_external_id/)
    expect(DIRECTORY_SRC).toMatch(/final_send_must_revalidate_db/)
    expect(DIRECTORY_SRC).toMatch(/offline is warning-only until agent_runtime_instances/)
  })
})

describe('T11b — runtime inventory CLI surface', () => {
  test('help documents the runtime inventory report', () => {
    expect(CLI_SRC).toMatch(/runtime inventory \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/\[--binding-role outbound\]/)
    expect(CLI_SRC).toMatch(/read-only runtime\/connector\/binding freshness report/)
  })

  test('runtime inventory is DB evidence based and read-only', () => {
    expect(RUNTIME_INVENTORY_SRC).toMatch(/db_is_source_of_truth/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/runtime_instance_id is concrete process\/session evidence/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/connector_instances/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/channel_connector_bindings/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/channel_routing_policy/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/binding_role/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/missing_active_binding/)
    expect(RUNTIME_INVENTORY_SRC).not.toMatch(/INSERT INTO|UPDATE .*SET|DELETE FROM/)
  })
})

describe('T11b2 — runtime cleanup lifecycle CLI surface', () => {
  test('help documents the runtime cleanup plan and approval flags', () => {
    expect(CLI_SRC).toMatch(/runtime cleanup \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/\[--execute --confirm <plan_hash>\]/)
    expect(CLI_SRC).toMatch(/\[--allow-unknown-risk\]/)
    expect(CLI_SRC).toMatch(/dry-run stale runtime\/listener\/tmux cleanup plan/)
  })

  test('runtime cleanup has stable dry-run plan hash, approval gate, and audit evidence', () => {
    expect(RUNTIME_CLEANUP_SRC).toMatch(/plan_hash/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/default_mode: 'dry-run'/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/execute_requires_plan_hash: true/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/unknown_risk_requires_override: true/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/UNKNOWN_RISK_REFUSED/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/runtime\.cleanup_target/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/runtime_instance_id/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/tmux_session/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/kill_process/)
    expect(RUNTIME_CLEANUP_SRC).toMatch(/kill_tmux_session/)
  })
})

describe('T11c — inbound smoke evidence CLI surface', () => {
  test('help documents the inbound smoke report', () => {
    expect(CLI_SRC).toMatch(/inbound smoke \[--format json\|text\] \[--window-hours 168\]/)
    expect(CLI_SRC).toMatch(/read-only Discord inbound smoke evidence by channel/)
  })

  test('inbound smoke is DB-evidence based and read-only', () => {
    expect(INBOUND_SMOKE_SRC).toMatch(/db_evidence_required/)
    expect(INBOUND_SMOKE_SRC).toMatch(/agent_messages\.source=discord/)
    expect(INBOUND_SMOKE_SRC).toMatch(/input_mentions resolved to channel members/)
    expect(INBOUND_SMOKE_SRC).toMatch(/message_queue rows exist for routed recipients/)
    expect(INBOUND_SMOKE_SRC).toMatch(/bot-authored duplicate rows are absent/)
    expect(INBOUND_SMOKE_SRC).not.toMatch(/INSERT INTO|UPDATE .*SET|DELETE FROM/)
  })
})

describe('T11d — AUN fleet readiness CLI surface', () => {
  test('help documents the fleet readiness report', () => {
    expect(CLI_SRC).toMatch(/fleet readiness \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/\[--include-disabled\] \[--include-test\]/)
    expect(CLI_SRC).toMatch(/read-only all-agent AUN readiness gates and activation blockers/)
  })

  test('fleet readiness is DB-evidence based and read-only', () => {
    expect(AUN_FLEET_READINESS_SRC).toMatch(/db_is_source_of_truth/)
    expect(AUN_FLEET_READINESS_SRC).toMatch(/STATE_DAEMON_AGENT_DENYLIST/)
    expect(AUN_FLEET_READINESS_SRC).toMatch(/disabled_profile_excluded/)
    expect(AUN_FLEET_READINESS_SRC).toMatch(/test_profile_excluded/)
    expect(AUN_FLEET_READINESS_SRC).toMatch(/smoke_request_not_terminal/)
    expect(AUN_FLEET_READINESS_SRC).toMatch(/smoke_ack_missing/)
    expect(AUN_FLEET_READINESS_SRC).not.toMatch(/INSERT INTO|UPDATE .*SET|DELETE FROM/)
  })
})

describe('T11e — NORM-060 full-channel smoke CLI surface', () => {
  test('help documents the full-channel smoke runner', () => {
    expect(CLI_SRC).toMatch(/smoke run \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/NORM-060 full-channel smoke \(dry-run\/plan default, read-only\)/)
    expect(CLI_SRC).toMatch(/command === 'smoke'[\s\S]*?smokeCommand\(subcommand, rest\)/)
  })

  test('full-channel smoke is dry-run first and uses the NORM-050 failure model', () => {
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/dry_run_default/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/OPERATOR_APPROVAL_REQUIRED/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/confirmPlanHash !== planHash/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/consumes_norm_050_failure_model/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/unregistered_channel/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/missing_member/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/offline_runtime/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/no_endpoint_lease/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/missing_delivery_owner/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/send_feedback_mismatch/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/timeout/)
    expect(FULL_CHANNEL_SMOKE_SRC).toMatch(/duplicate_routing/)
  })

  test('help documents the bounded queue wake smoke runner', () => {
    expect(CLI_SRC).toMatch(/smoke queue-wake \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/bounded state-daemon queue wake smoke; no manual next and no terminal close/)
    expect(CLI_SRC).toMatch(/subcommand === 'queue-wake'[\s\S]*?buildQueueWakeSmokeReport/)
  })

  test('queue wake smoke is bounded, approval-gated, and does not drain or terminalize rows', () => {
    expect(STATE_DAEMON_READINESS_SRC).toMatch(/execute_requires_confirm_plan_hash: true/)
    expect(STATE_DAEMON_READINESS_SRC).toMatch(/bounded_poll: true/)
    expect(STATE_DAEMON_READINESS_SRC).toMatch(/calls_manual_next: false/)
    expect(STATE_DAEMON_READINESS_SRC).toMatch(/terminalizes_existing_rows: false/)
    expect(STATE_DAEMON_READINESS_SRC).toMatch(/OPERATOR_APPROVAL_REQUIRED/)
    expect(STATE_DAEMON_READINESS_SRC).toMatch(/state_daemon\.queue_wake_smoke/)
    expect(STATE_DAEMON_READINESS_SRC).toMatch(/idle_pending_no_wake_progress/)
    expect(STATE_DAEMON_READINESS_SRC).toMatch(/busy_active_pending_growth/)
  })
})

describe('T12 — DB-backed channel policy CLI surface', () => {
  test('help documents DB policy management commands', () => {
    expect(CLI_SRC).toMatch(/channel policy list \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/channel policy import-json \[--execute\|--dry-run\]/)
    expect(CLI_SRC).toMatch(/channel policy bootstrap \[--execute\|--dry-run\]/)
    expect(CLI_SRC).toMatch(/channel policy sync-connectors \[--channel <id\|name>\]/)
    expect(CLI_SRC).toMatch(/channel policy set <channel_id> \[--primary <agent\|none>\]/)
  })

  test('policy commands are dry-run by default and audit mutating writes', () => {
    expect(CLI_SRC).toMatch(/channel\.policy_import_json/)
    expect(CLI_SRC).toMatch(/channel\.policy_bootstrap_directory/)
    expect(CLI_SRC).toMatch(/channel\.policy_sync_connectors/)
    expect(CLI_SRC).toMatch(/channel\.policy_set/)
    expect(CLI_SRC).toMatch(/parseRepairDryRun\(flags\)/)
    expect(CLI_SRC).toMatch(/refreshChannelPolicyDbSnapshot/)
  })

  test('connector sync maps legacy routing policy into control-plane connector tables', () => {
    expect(CHANNEL_CONNECTOR_SYNC_SRC).toMatch(/channel_routing_policy/)
    expect(CHANNEL_CONNECTOR_SYNC_SRC).toMatch(/connector_instances/)
    expect(CHANNEL_CONNECTOR_SYNC_SRC).toMatch(/channel_connector_bindings/)
    expect(CHANNEL_CONNECTOR_SYNC_SRC).toMatch(/active_binding_conflict/)
  })

  test('channel reconcile CLI is dry-run first and execute requires operator approval hash', () => {
    expect(CLI_SRC).toMatch(/channel reconcile \[--provider discord\]/)
    expect(CLI_SRC).toMatch(/subcommand === 'reconcile'[\s\S]*?channelReconcile\(rest\)/)
    expect(CHANNEL_REGISTRATION_RECONCILE_SRC).toMatch(/read_only_inventory/)
    expect(CHANNEL_REGISTRATION_RECONCILE_SRC).toMatch(/dry_run_default/)
    expect(CHANNEL_REGISTRATION_RECONCILE_SRC).toMatch(/OPERATOR_APPROVAL_REQUIRED/)
    expect(CHANNEL_REGISTRATION_RECONCILE_SRC).toMatch(/confirmPlanHash !== planHash/)
    expect(CHANNEL_REGISTRATION_RECONCILE_SRC).toMatch(/inbound\.channel_unregistered/)
  })
})

describe('T13 — control-plane lease CLI surface', () => {
  test('help documents runtime heartbeat evidence option', () => {
    expect(CLI_SRC).toMatch(/heartbeat \[--runtime-instance-id <uuid>\]/)
    expect(CLI_SRC).toMatch(/optional runtime heartbeat evidence/)
  })

  test('help documents script-controlled lease operations', () => {
    expect(CLI_SRC).toMatch(/lease acquire --scope-type <type> --scope-id <id>/)
    expect(CLI_SRC).toMatch(/acquire a control-plane lease and fencing token/)
    expect(CLI_SRC).toMatch(/lease heartbeat --lease-id <id> --fencing-token <n>/)
    expect(CLI_SRC).toMatch(/lease verify --lease-id <id> --fencing-token <n>/)
    expect(CLI_SRC).toMatch(/lease release --lease-id <id> --fencing-token <n>/)
  })

  test('lease commands call the provider-neutral control-plane helper', () => {
    expect(CLI_SRC).toMatch(/acquireControlPlaneLease\(adapter/)
    expect(CLI_SRC).toMatch(/heartbeatControlPlaneLease\(adapter/)
    expect(CLI_SRC).toMatch(/verifyControlPlaneFence\(adapter/)
    expect(CLI_SRC).toMatch(/releaseControlPlaneLease\(adapter/)
    expect(CLI_SRC).toMatch(/--metadata must be a JSON object/)
  })

  test('lease helper enforces active uniqueness, expiry takeover, and fencing token checks', () => {
    expect(CONTROL_PLANE_LEASES_SRC).toMatch(/status = 'expired'/)
    expect(CONTROL_PLANE_LEASES_SRC).toMatch(/MAX\(fencing_token\)/)
    expect(CONTROL_PLANE_LEASES_SRC).toMatch(/active_lease_exists/)
    expect(CONTROL_PLANE_LEASES_SRC).toMatch(/fencing_token_mismatch/)
    expect(CONTROL_PLANE_LEASES_SRC).toMatch(/holder_mismatch/)
  })
})

// T11 (Phase 1.5/2 Discord-failure preservation) was removed in Phase 3
// (Issue #129). The CLI no longer has a synchronous Discord-delivery
// failure branch — `deliverToDiscord` is gone, and the outbound HTTP call
// is now done by the receiver consumer (server.ts) on its 1-second tick.
// The consumer handles retries via attempts/max_attempts, covered by
// tests/spec-enforcement/outbound-queue-phase3.test.ts T2.
