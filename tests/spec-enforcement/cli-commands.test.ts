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
const CONTROL_PLANE_LEASES_PATH = join(REPO_ROOT, 'core', 'control-plane-leases.ts')
const CHANNEL_CONNECTOR_SYNC_PATH = join(REPO_ROOT, 'core', 'channel-connector-sync.ts')

const CLI_SRC = readFileSync(CLI_PATH, 'utf-8')
const QUEUE_DOCTOR_SRC = readFileSync(QUEUE_DOCTOR_PATH, 'utf-8')
const QUEUE_NORMALIZATION_SRC = readFileSync(QUEUE_NORMALIZATION_PATH, 'utf-8')
const QUEUE_REPAIR_SRC = readFileSync(QUEUE_REPAIR_PATH, 'utf-8')
const DIRECTORY_SRC = readFileSync(DIRECTORY_PATH, 'utf-8')
const RUNTIME_INVENTORY_SRC = readFileSync(RUNTIME_INVENTORY_PATH, 'utf-8')
const CONTROL_PLANE_LEASES_SRC = readFileSync(CONTROL_PLANE_LEASES_PATH, 'utf-8')
const CHANNEL_CONNECTOR_SYNC_SRC = readFileSync(CHANNEL_CONNECTOR_SYNC_PATH, 'utf-8')
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
  test('channelPolicy handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function channelPolicy\s*\(/)
  })
  test('leaseCommand handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function leaseCommand\s*\(/)
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
  test("'channel policy' subcommands invoke channelPolicy(...)", () => {
    expect(CLI_SRC).toMatch(/subcommand === 'policy'[\s\S]*?channelPolicy\(rest\)/)
  })
  test("'lease' command invokes leaseCommand(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'lease'[\s\S]*?leaseCommand\(subcommand, rest\)/)
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
    expect(CLI_SRC).toMatch(/queue normalize \[--agent-id <id>\] \[--stale-minutes 15\] \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/dry-run normalization plan with scoped repair commands/)
  })

  test('diagnoseQueue reports the P0 blocker classes', () => {
    expect(QUEUE_DOCTOR_SRC).toMatch(/legacy_status_mix/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/stale_pending/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/active_claim_missing_owner/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/expired_active_claim/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/retired_or_offline_recipient/)
    expect(QUEUE_DOCTOR_SRC).toMatch(/outbound_pending_stale/)
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
  })
})

describe('T11b — runtime inventory CLI surface', () => {
  test('help documents the runtime inventory report', () => {
    expect(CLI_SRC).toMatch(/runtime inventory \[--format json\|text\]/)
    expect(CLI_SRC).toMatch(/read-only runtime\/connector\/binding freshness report/)
  })

  test('runtime inventory is DB evidence based and read-only', () => {
    expect(RUNTIME_INVENTORY_SRC).toMatch(/db_is_source_of_truth/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/runtime_instance_id is concrete process\/session evidence/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/connector_instances/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/channel_connector_bindings/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/channel_routing_policy/)
    expect(RUNTIME_INVENTORY_SRC).toMatch(/missing_active_binding/)
    expect(RUNTIME_INVENTORY_SRC).not.toMatch(/INSERT INTO|UPDATE .*SET|DELETE FROM/)
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
})

describe('T13 — control-plane lease CLI surface', () => {
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
