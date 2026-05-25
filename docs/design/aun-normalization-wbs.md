# AUN Normalization MVP WBS

Date: 2026-05-25
Status: Working breakdown for the MVP slices defined in
[`aun-normalization-roadmap.md`](./aun-normalization-roadmap.md). Not normative
on its own; the roadmap remains the contract. This document tracks per-slice
state, expected PR count, dependencies, recommended owner, and completion
evidence so progress is visible without re-reading every PR description.

Refresh cadence: update on each merged PR that advances a slice, or when a
slice's scope shifts.

## Summary

| Status | Count |
|---|---|
| Done | 1 |
| In progress | 4 |
| Spec ready, impl pending | 4 |
| Not started | 5 |

## Slice State

### NORM-000 — Roadmap and SSOT references ✅ done

- Evidence: `docs/design/aun-normalization-roadmap.md` merged 2026-05-24
  (035ccfb).
- No further PR expected unless the roadmap itself is revised.

### NORM-010 — Queue claim/send consistency 🟡 partial

- Latest progress: PR #533 (claim treats in-progress as active, 0c5c11b).
- Remaining: contract test demonstrating `next → processing → send` closes the
  claim across fallback paths (notify, missing claim).
- Owner: agent-com-dev.
- Expected PRs: 1 (test-only, behaviour already shipped).
- Depends on: none.
- Completion evidence: contract test in `tests/contract/` proving the claim is
  closed by `send` without a separate `done` call.

### NORM-020 — Bot profile and runtime heartbeat registration 🟡 in progress

- Recent merges: #539 (SSOT CLI), #540 (evidence projection), #541 (heartbeat
  binds to bot profile workspace), #542 (status reads from bot profile).
- Remaining: heartbeat coverage check in `aun doctor`; failure mode when no
  bot profile row exists for an active process.
- Owner: agent-com-dev with ARC review on schema.
- Expected PRs: 2.
- Depends on: NORM-021 (table reduction) for canonical profile shape.
- Completion evidence: `agent_runtime_instances` rows for every active local
  process; `aun doctor --strict` reports drift if a process has no profile.

### NORM-021 — Bot table reduction and script rewrite 🟡 in progress

- Recent merges: #543 (lifecycle tools prefer bot profile inventory).
- Remaining: scripts for restart, fleet rollout, watchdog read from bot
  profile only; legacy `bots` table reads are removed or limited to migration
  code.
- Owner: agent-com-dev (lead-bot review required since this touches scripts in
  `scripts/` and `infra/launchd`).
- Expected PRs: 2-3.
- Depends on: NORM-020.
- Completion evidence: grep shows no production read path against the legacy
  bot table; smoke test boots a fleet from one editable profile per bot.

### NORM-025 — Provider identity registry 🟡 spec ready, impl in review

- Spec: `docs/spec/norm-025-provider-identity-registry-impl.md`.
- Open PR: #536 (provider identity normalization). L2 codex-auditor review
  in progress as of 2026-05-25.
- Owner: codex (impl), codex-auditor (L2), CTO (L3).
- Expected PRs: 1 (current PR) plus any cycle-2 follow-up.
- Depends on: none.
- Completion evidence: provider subject rows are the DB authority for
  Discord bot/user/app ids; duplicate active providers fail closed.

### NORM-030 — Connector credential registry and token uniqueness 🔵 spec ready, impl not started

- Spec: `docs/spec/norm-030-connector-credential-registry-impl.md`.
- Owner: lead-bot drafts 6-section instruction; agent-com-dev or codex
  implements.
- Expected PRs: 2 (schema + projection, then strict-doctor wiring).
- Depends on: NORM-025 (provider identity is the credential subject anchor).
- Completion evidence: non-secret credential records exist; duplicate active
  token fingerprint is blocked or causes `aun doctor --strict` to exit non
  zero; raw tokens never logged.

### NORM-035 — Provider channel access discovery 🔵 spec ready, impl not started

- Spec: `docs/spec/norm-035-provider-channel-access-impl.md`.
- Owner: agent-com-dev (impl), lead-bot review.
- Expected PRs: 2 (discovery write path, then read/write semantics in
  routing).
- Depends on: NORM-030.
- Completion evidence: per provider channel, the connector's read/write
  access is recorded without raw token output, and routing consults the row
  before treating the connector as a delivery owner.

### NORM-036 — Effective delivery owner resolver 🔵 spec ready, impl not started

- Spec: `docs/spec/norm-036-effective-delivery-owner-resolver-impl.md`.
- Owner: agent-com-dev (impl), lead-bot review.
- Expected PRs: 1-2.
- Depends on: NORM-035.
- Completion evidence: a deterministic function returns the delivery owner
  for a (channel, agent) pair, or returns an explicit ambiguity/failure
  result with audit reason; legacy override path is explicit and audited.

### NORM-040 — `aun doctor --strict` 🟡 partial

- Recent merges: #538 (status CLI adds agents table + queue summary + drift
  warnings).
- Remaining: strict mode covering missing registry rows, duplicate active
  token fingerprints, processes without runtime evidence, connectors without
  owner/runtime linkage, channels without policy, stale queue/runtime rows.
- Owner: agent-com-dev.
- Expected PRs: 2 (add `--strict` flag and core checks; add coverage for
  NORM-030/035/036 once those land).
- Depends on: NORM-020, NORM-025 minimum; tightens further as later slices
  ship.
- Completion evidence: clean fixture exits zero; drift fixture exits non
  zero with the offending row id printed.

### NORM-050 — Channel/bot assignment reconcile ⚪ not started

- Owner: requires lead-bot 6-section instruction; agent-com-dev impl.
- Expected PRs: 2 (dry-run plan generator, then audited execute path).
- Depends on: NORM-035, NORM-036.
- Completion evidence: dry-run plan output is reproducible; execute path
  writes audit rows; no raw tokens in plan output.

### NORM-060 — Full-channel smoke runner ⚪ not started

- Owner: agent-com-dev with ARC review on success criteria.
- Expected PRs: 1-2 (runner script, then DB invariant assertions).
- Depends on: NORM-020, NORM-040.
- Completion evidence: a single command runs all target internal channels
  and prints DB evidence (`agent_messages.source='discord'`, queue row,
  claim/done, outbound terminal state, audit row).

### NORM-070 — Legacy queue/runtime cleanup ⚪ not started

- Open question: this slice will replace ad-hoc `close-obsolete` workflows
  the team has been running by hand. Requires a deterministic dry-run plan
  whose hash is recorded before execute.
- Owner: agent-com-dev; lead-bot review on plan format.
- Expected PRs: 2 (plan generator with hash; audited execute path).
- Depends on: NORM-010, NORM-040.
- Completion evidence: dry-run plan hash is committed in audit before
  execute; terminal states are preserved; rerun on clean state is a no-op.

### NORM-080 — State-daemon DB policy coverage and deny policy ⚪ not started

- Open question: today state-daemon uses a manual allow list per host. MVP
  wants DB-driven default coverage with a deny override.
- Owner: agent-com-dev (impl), lead-bot review on policy semantics.
- Expected PRs: 2 (DB policy read path; deny override and audit).
- Depends on: NORM-020.
- Completion evidence: adopting a new local bot does not require editing a
  per-bot allow list in scripts.

## Sequencing

Solid edges = strict dependency. Dashed sequencing edges (NORM-010 → NORM-070)
exist because NORM-070 reuses NORM-010 invariants but does not block on it.

```
NORM-021 ─┬─ NORM-020 ─┬─ NORM-040 ─┬─ NORM-060
          │            │            │
          │            └─ NORM-080  │
          │                         │
NORM-025 ─┴─ NORM-030 ── NORM-035 ── NORM-036 ── NORM-050
                                                  │
NORM-010 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ NORM-070
```

The critical path for MVP closure runs through NORM-025 → 030 → 035 → 036 →
050. Until NORM-036 is in code, NORM-050 reconcile cannot make safe owner
decisions, and `aun doctor --strict` (NORM-040) cannot complete its connector
checks.

## Open Decisions

These are not yet fixed by the roadmap and need a CEO or ARC call before
implementation can start on the corresponding slice.

1. NORM-070 plan hash: what hash function and where is the hash recorded so
   that the execute path can refuse a divergent plan?
2. NORM-080 policy table: is the deny list a new table, or an existing column
   on `agents` / bot profile?
3. NORM-060 success scope: which internal channels are in the MVP smoke set?
   The roadmap says "all target internal channels"; we need the explicit
   list.

Until these are decided, the corresponding slices stay at the spec drafting
step under lead-bot, not at implementation.

## How to use this document

- Every PR that closes a NORM slice updates the relevant row from in progress
  to done in the same PR (so the doc never lags merged code by more than one
  PR).
- A new defect classified into MVP attaches to a slice here; if no slice fits,
  the roadmap gets a new slice first, then this WBS gets a new row, then the
  PR is opened.
- Progress reports to CEO quote the summary table at the top so the visible
  number of done/in-progress/not-started slices stays honest.
