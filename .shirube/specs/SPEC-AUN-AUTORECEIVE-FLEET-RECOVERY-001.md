# AUN automatic-receive and fleet recovery — graph 2.0 freeze

Status: `FROZEN_FOR_PLANNING_AWAITING_INDEPENDENT_AUDIT`
Control source: [Issue #602](https://github.com/watchout/agent-comms-mcp/issues/602)
Authoritative amendment: AUN queue `147620`, message `45268548-a9fc-4735-be12-e35ec15d784a`
Draft delivery container: [PR #908](https://github.com/watchout/agent-comms-mcp/pull/908)

This version supersedes the earlier six-Cell and seven-Cell planning candidates. Those records remain immutable evidence, but neither is freeze authority and neither authorizes implementation or a protected effect.

## Goal and terminal meaning

From one exact owner-pinned release, canonical `aun` and every target in the trusted production manifest automatically receive and complete ordinary work after daemon start or restart. Completion must not depend on manual `next` or `inbox`, LLM drain loops, prompt injection, raw SQL repair, manual terminalization, unmanaged fallback, or protected D1 authority bleed.

`VERIFIED_DONE` additionally requires exact MCP bootstrap, deterministic queue-residue reconciliation, fresh runtime and endpoint ownership, direct delivery without silent AUN fallback, live manifest schema activation, N-of-N manifest and fleet evidence, controlled reboot convergence, and immutable requirement-level disposition of Issues #691, #603, #604, #449, and #435.

Green code, a healthy process, a tmux session, one canary, canonical `aun -> ceo` projection, or merge alone is not completion.

## G1 — sourced intent and current preimage

The normative sources are:

- AUN final amendment `45268548-a9fc-4735-be12-e35ec15d784a` and P0 correction `4776a58d-f2bf-487b-ba6d-bd9d2642bea8`.
- [Issue #602](https://github.com/watchout/agent-comms-mcp/issues/602): reboot recovery and automatic queue wake.
- [Issue #691](https://github.com/watchout/agent-comms-mcp/issues/691): fleet, endpoint lease, NORM-060, and live recovery gates.
- [Issue #603](https://github.com/watchout/agent-comms-mcp/issues/603): durable state-daemon restore and queue wake.
- [Issue #604](https://github.com/watchout/agent-comms-mcp/issues/604): sender direct delivery and explicit fallback evidence.
- [Issue #449](https://github.com/watchout/agent-comms-mcp/issues/449): deterministic bounded queue reconciliation.
- [Issue #435](https://github.com/watchout/agent-comms-mcp/issues/435): fresh Codex and Claude MCP registration.
- [PR #907](https://github.com/watchout/agent-comms-mcp/pull/907): pinned baseline mechanism corrections.

The pinned baseline is commit `9054c38d769cc1d50238fb327f60567c8d2fbe2c`, tree `61494635f156bac8f950b54e8446a6f22d5f1b85`. The source audit records 304 non-live tests passing and zero failing plus a passing build. That proves baseline mechanisms only; the live state is `NO_GO`.

Current Phase-0 read-only evidence is:

| Gate | Current evidence | Result |
|---|---|---|
| Queue preflight | 3 blocker classes; stale pending 153; expired active claims 6; stale outbound 840 | NO_GO |
| Fleet readiness | ready 12; candidates 24; excluded 23; blockers 54 | NO_GO |
| NORM-060 | 23 channels; passed 0; incomplete 8; blocked 15; no endpoint lease 26; missing delivery owner 4 | NO_GO |
| Inbound smoke | 22 channels; passed 0; incomplete 22 | NO_GO |
| Canonical AUN | blocker `STATE_DAEMON_AGENT_NOT_ALLOWLISTED`; pending 5; active claim 0 | NO_GO |
| Runtime inventory | agents 59; runtime instances 4551; fresh runtimes 31; active connectors 26; blockers 18 | NO_GO |
| Manifest schema | live manifest tables absent | NO_GO |
| Restore service | `com.aun.bot-restore` not loaded | NO_GO |
| Watchdog | old checkout `bf4bd196…`; exact release false; last exit 1 | NO_GO |
| Canonical AUN projection | `aun -> ceo` direct projection from sender-token evidence | GO only for this path |

No Phase-0 observation authorizes DB, queue, runtime, LaunchAgent, MCP-registration, manifest, or Discord mutation.

## G2–G3 — deterministic core and boundaries

The deterministic skeleton owns eligibility, identity, claim, lease, fence, reconciliation plan hash, admission, lifecycle transitions, typed result, finalization, rollback, and protected gates. An LLM may generate task content but never becomes admission, disposition, or terminal authority.

The boundaries are:

| Boundary | Owns | Must not own |
|---|---|---|
| AUN core | desired state, logical identity, queue readiness, wake, claim, lease, fence, terminal evidence | tmux, launchd, provider projection, database-specific mechanics |
| Supervisor adapter | host inspect/readiness/wake/start/stop/restart/logs/attach | logical identity or queue authority |
| Runtime adapter | Codex/Claude/OpenClaw invocation and typed result parsing | queue admission or terminal policy |
| Connector projection adapter | Discord/provider delivery and provider evidence | sender identity, ownership, or completion authority |
| Persistence adapter | SQLite/PostgreSQL mechanics behind one contract | product policy or implicit live migration authority |
| Manifest policy | closed-world targets, canonical bytes, digests, revision, expiry, revocation, drift, D1 isolation | runtime activation |
| MCP surface | exact registration, contract exposure, tool evidence | universal host supervision |

Agent-name inference is forbidden. The production denominator is canonical only when `expected_target_count == resolved_target_count == N` and classification, workspace, runtime, profile, provider, Control, and endpoint ambiguity are all zero.

## Frozen ten-Cell graph

| Order | Cell | Primary outcome | Depends on |
|---:|---|---|---|
| 10 | `CELL-AUN-RECOVERY-CONTRACT-001` | Freeze graph, trace, evidence, owner gates, and frontmost handoff | — |
| 20 | `CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001` | Canonical production denominator and exact identity | 10 |
| 30 | `CELL-AUN-MCP-BOOTSTRAP-CONVERGENCE-001` | Exact fresh-session Codex/Claude MCP bootstrap and restart persistence | 20 |
| 40 | `CELL-AUN-QUEUE-RESIDUE-RECONCILIATION-001` | Deterministic reviewed bounded disposition for all active queue residue | 10 |
| 50 | `CELL-AUN-RUNTIME-ENDPOINT-DELIVERY-READINESS-001` | Fresh runtimes, endpoint leases, direct owners, zero NORM-060 failures | 20, 30 |
| 60 | `CELL-AUN-CANONICAL-RECEIVE-001` | Canonical AUN canary, two ordinary queues, restart continuity | 30, 40, 50 |
| 70 | `CELL-AUN-MANIFEST-SCHEMA-ACTIVATION-001` | Exact live manifest migration with protected negative proof | 10 |
| 80 | `CELL-AUN-MANIFEST-PUBLISH-001` | Owner-pinned closed-world manifest admission and readback | 20, 30, 50, 60, 70 |
| 90 | `CELL-AUN-FLEET-ACTIVATION-001` | Owner-pinned N-of-N waves and full lifecycle proof | 80 |
| 100 | `CELL-AUN-REBOOT-CONVERGENCE-001` | Controlled reboot convergence and related-control disposition | 90 |

Each Cell has one primary responsibility, implementation boundary, and verification boundary. After durable freeze, new findings stay inside the owning Cell unless a recorded graph amendment changes the graph.

## Requirements and acceptance trace

| Requirement | Measurable acceptance | Tests |
|---|---|---|
| REQ-REC-001 exact release and provenance | Exact commit, tree, build, service, environment, manifest, rollback identities | TEST-001, 002 |
| REQ-REC-002 durable supervisor and rollback | Normalized readiness and rollback; host mechanics remain adapter-only | TEST-005, 017 |
| REQ-REC-003 canonical AUN automatic receive | One canary and two fresh unfenced ordinary queues; bypass zero | TEST-003, 006, 007 |
| REQ-REC-004 exactly-once queue lifecycle | One claim owner, lease, fence, result, terminal transition; duplicate zero | TEST-003, 004, 010 |
| REQ-REC-005 typed result and projection | Schema-valid outcome, reply/outbound evidence, correlated terminal | TEST-002, 004, 006, 009 |
| REQ-REC-006 no manual bypass | Manual-next/inbox/drain/prompt/SQL/manual-close contribution zero | TEST-007, 015 |
| REQ-REC-007 restart convergence | Pending-before and new-after execute once; terminal never re-executes | TEST-008, 010 |
| REQ-REC-008 exact closed-world denominator | expected = resolved = N; stable digest; blockers/name inference zero | TEST-011, 012 |
| REQ-REC-009 per-target equality | One workspace, fresh runtime, exact profile/provider/Control/Discord bindings | TEST-011, 013, 014, 015 |
| REQ-REC-010 staged fleet activation | N-of-N owner-pinned waves; first failure stops later admission | TEST-013, 017 |
| REQ-REC-011 containment and rollback | Kill switch and previous manifest/release/config restore with readback | TEST-005, 009, 010, 017 |
| REQ-REC-012 immutable maker-checker evidence | Author, auditor, operator, owner are distinct and exact-head bound | TEST-001, 012, 013, 018 |
| REQ-REC-013 protected D1 isolation | D1 admission, allowlist, receipts, history, effects remain invariant | TEST-016 |
| REQ-REC-014 controlled reboot | Services restore and a fresh ordinary queue completes without prompt | TEST-018 |
| REQ-REC-015 supervisor neutrality | Core owns no host command authority; adapters pass conformance | TEST-019 |
| REQ-REC-016 live manifest schema | Exact migration, repeated-up, readback, down refusal, protected negative proof | TEST-020 |
| REQ-REC-017 related-control disposition | #691/#603/#604/#449/#435 closed or immutably mapped with zero unmet item | TEST-021 |
| REQ-REC-018 exact MCP bootstrap | Fresh Codex/Claude load exact server, survive restart, no ACL drift | TEST-022 |
| REQ-REC-019 queue reconciliation | Every active row classified; reviewed plan; bounded idempotent apply; blockers zero | TEST-023 |
| REQ-REC-020 endpoint/direct delivery | N fresh runtimes and leases; intended consumers; all NORM-060 failures zero | TEST-024 |

The machine-readable graph carries the complete one-to-one acceptance IDs and many-to-many test references. Missing or unknown references must equal zero.

## Test contract

TEST-001 through TEST-018 retain the release, lifecycle, restart, manifest, fleet, D1, rollback, and reboot coverage of the prior candidate.

The final six tests close the superseding source audit:

- `TEST-019`: supervisor-neutral core and all supported host-adapter conformance.
- `TEST-020`: disposable preflight followed by owner-approved exact live manifest migration, repeated-up, schema readback, down refusal, and queue/D1 negative hashes.
- `TEST-021`: immutable requirement-by-requirement disposition matrix for #691/#603/#604/#449/#435.
- `TEST-022`: clean-host SQLite-new, SQLite-existing, and PostgreSQL bootstrap plus fresh Codex/Claude MCP list/tool smoke, restart persistence, rollback, and ACL-negative proof.
- `TEST-023`: read-only inventory of every active row, reviewed plan/hash, bounded idempotent apply, audit equality, and queue blocker count zero.
- `TEST-024`: fresh endpoint leases and intended direct consumers for N targets, `passed == target_channels`, all eight NORM-060 failure classes zero, and no unintended fallback.

The 304/0 source baseline is evidence, not a live PASS. Live tests remain pending and protected.

## Execution sequence and owner decisions

1. Cell 10 is independently audited on one exact PR head.
2. AUN prepares exact plans and hashes for registry, MCP, queue, schema, endpoint, and canonical activation.
3. `OD-AUN-001` is one combined protected decision covering those exact plans, rollback, and one service/daemon restart window.
4. Cells 20–70 execute only along their declared dependencies and exact approved scope.
5. After canonical PASS and exact manifest/waves/reboot plan, `OD-AUN-002` decides manifest publication, fleet waves, controlled reboot, and rollback.
6. Cells 80–100 execute with stop-on-first-failure, independent evidence audit, operator acceptance, and immutable related-control disposition.

Read-only diagnostics, listed non-live tests, and evidence readback require no new approval. They do not authorize an apply step.

## G4 — measurable completion

The freeze contains exactly:

- 10 ordered Cells.
- 20 requirements.
- 20 acceptance criteria.
- 24 tests.
- 24 completion predicates.
- 20 named failure modes.

Every completion predicate remains pending until its designated Cell supplies durable evidence. Cell 10 completion requires the superseding Issue #602 amendment, Draft PR identity and hashes, machine validation, AUN reach receipt, and independent exact-head audit PASS. It does not complete the parent recovery goal.

## G5 — failure and rollback policy

The machine-readable graph names detection and recovery for 20 failure modes. The additional final-pre-freeze classes are:

- Host-supervisor authority leaking into core.
- Live manifest schema missing despite merged migration code.
- Related controls unresolved or only informally superseded.
- Fresh sessions loading stale, dirty, or wrong-identity MCP registration.
- Queue rows terminalized by age, free-form prose, an unbounded drain, or a planless mutation.
- Missing endpoint/direct-owner evidence hidden by silent AUN fallback.

Any such finding blocks the owning Cell. Rollback must restore exact prior release, config, manifest, or protected state and must include readback; a rollback command alone is not evidence.

## G6 — protected surfaces and role separation

ARC is limited to the five Control artifact paths, immutable GitHub readback, and the independent-audit route. ARC may not modify code, DB, production queues, state-daemon, LaunchAgents, MCP registrations, profiles, runtimes, endpoints, credentials, manifests, Discord, Ready state, approval, merge, deployment, rollout, or release.

The author and AUN requester cannot serve as the independent auditor. `codex-audit` or another permitted evidence-audit function must issue the exact-head verdict. Protected effects require `OD-AUN-001` or `OD-AUN-002`; neither is implied by this freeze.

## G7 — reflection and handoff

The graph is complete enough for independent audit because source intent, deterministic mechanisms, adapter boundaries, measurable predicates, failure modes, protected surfaces, and a complete next action are present. It is not implementation-complete and does not make any live gate GO.

Next action:

- Actor: `codex-audit` as `evidence_audit_gate`.
- Input: the successor exact head and tree of Draft PR #908 plus all five artifacts and the superseding Issue #602 amendment.
- Scope: read-only exact-head source, trace, count, boundary, and G1–G7 audit.
- Deliverable: immutable `PASS`, `REQUEST_CHANGES`, or `ESCALATE` verdict with itemized evidence and complete `next_action`.
- Completion evidence: verdict URL, exact identities, artifact hashes, reproducible validation output, GitHub API byte equality, and AUN delivery receipt.

Until that verdict is PASS, Cell 10 remains nonterminal and no later Cell is admitted.
