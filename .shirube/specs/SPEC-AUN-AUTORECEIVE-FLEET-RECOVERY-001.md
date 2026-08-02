# AUN Automatic Receive Fleet Recovery V3 Control Spec

SPEC-ID: `SPEC-AUN-AUTORECEIVE-FLEET-RECOVERY-001`
GRAPH-ID: `GRAPH-AUN-AUTORECEIVE-FLEET-RECOVERY-001`
FRONTMOST-CELL: `CELL-AUN-RECOVERY-CONTRACT-001`
Control source: https://github.com/watchout/agent-comms-mcp/issues/602
Status: `FROZEN_FOR_PLANNING_AWAITING_INDEPENDENT_AUDIT`
Runtime authorization: `false`

## 1. Sourced intent

The owner directive is to define and freeze the goal, definitions, plan,
procedure, completion checklist, and tests before execution, including
all-agent distribution and automatic receive recovery.

This version supersedes the June Issue 602 design comments as planning
authority while preserving them as immutable evidence and constraints. It does
not reinterpret any earlier docs-only or read-only approval as permission for a
runtime, queue, database, LaunchAgent, manifest, provider, or production
effect.

Primary sources:

- Issue 602 body and adapter constraint:
  https://github.com/watchout/agent-comms-mcp/issues/602 and
  https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-4580497318
- Incident and recovery constraints:
  https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-4640211484,
  https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-4640703827,
  https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-4640887675,
  and
  https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-4641092650
- Simulated-reboot harness boundary:
  https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-4664490385
- Exact merged release baseline:
  https://github.com/watchout/agent-comms-mcp/pull/907
- Repository contracts:
  `docs/design/REBOOT_ARCHITECTURE.md`,
  `docs/design/auto-receive-lifecycle-gate-first-slice.md`,
  `docs/spec/aun-runtime-supervisor-adapter-contract.md`,
  `docs/spec/aun-state-daemon-queue-processing-readiness-contract.md`,
  `docs/operations/all-agent-communication-manifest.md`, and
  `docs/operations/aun-full-recovery-runbook.md`.

No unsourced domain semantic is introduced by this spec. Future protected
choices are explicitly reserved to `OD-AUN-001` and `OD-AUN-002`.

## 2. Exact baseline and current gap

The frozen repository baseline for this Control artifact is:

- commit `9054c38d769cc1d50238fb327f60567c8d2fbe2c`;
- tree `61494635f156bac8f950b54e8446a6f22d5f1b85`;
- merged corrective PR 907.

The new code is running, but ordinary auto-receive is not restored. The daemon
is still scoped to retired seat `codex-aun` and terminal queue 147565. The
canonical `aun` seat has unresolved profile, runtime, release, and enrollment
equality.

The registry query currently observes 39 rows and 36 active rows with at least
six known classification leaks. `39` is not the production denominator. The
legacy readiness values `ready=0`, `activation_candidates=38`, `excluded=21`,
and `blockers=123` are baseline evidence only. The exact production value `N`
remains unresolved until Cell 20 proves canonical classification and equality.

## 3. Goal and terminal definition

From one exact owner-pinned release, the canonical `aun` seat and every target
in a trusted closed-world production manifest automatically receive and
complete ordinary AUN work after daemon start or restart. No success may
depend on manual `next`, `inbox`, FIFO drain, TUI prompt injection, operator
bypass, raw SQL queue edits, unmanaged retries, or manual terminalization.

The terminal state is `VERIFIED_DONE`. The work is not done because code is
merged, a daemon is healthy, one exact-fenced canary passes, or a Discord
projection is visible. It is not done while the manifest count or digest is
unresolved, a target has ambiguous identity, or a production target is excluded
without an owner-bounded exclusion.

## 4. Definitions

### 4.1 New release

A new state-daemon release is the tuple of exact commit and tree, immutable
checkout and build provenance, a Bun executable independent of LaunchAgent
`PATH`, plist and environment digests, restore and rollback commits, canonical
manifest identity and digests, previous configuration, and kill switch.

### 4.2 Automatic receive recovered

An ordinary post-activation queue is detected by notification or bounded
sweep, claimed under the correct runtime identity and lease/fence, executed by
a typed runner, finalized with reply or outbound evidence, and closed into
exactly one valid terminal state with correlated audit evidence. The canonical
seat must pass one bounded canary, two fresh ordinary queues after the one-row
fence is removed, and one separately approved daemon restart continuity test.

### 4.3 All agents recovered

The production denominator comes only from canonical profile policy and
explicit classification evidence. Each target must have exactly one primary
workspace, one fresh selected runtime, and explicit Control, active-function,
profile, provider, ordinary auto-receive, D1-isolation, and Discord-mode
bindings. `expected_target_count == resolved_target_count == N`; blockers,
drift, bypasses, ambiguity, and unexpected exclusions are zero.

### 4.4 Distribution

Distribution is desired-state publication, manifest admission, daemon scope,
profile and runtime equality, and live per-target proof. It is not file copying.

## 5. Architecture and adapter boundaries

| Boundary | Authority |
| --- | --- |
| AUN core | desired state, logical identity, queue readiness, wake policy, claim, lease, fence, typed outcome, terminal evidence, GO/NO-GO |
| Runtime supervisor adapter | host-specific inspect/readiness/wake/start/stop/restart/log/attach behavior and evidence |
| Runtime adapter | model/runtime invocation and typed result parsing after admission |
| Connector/projection adapter | Discord or other provider delivery and read/write evidence |
| Manifest policy | closed-world targets, canonical bytes/digests, owner pin, revision, drift, expiry, revocation, and D1 isolation |
| MCP surface | control-plane contract and evidence surface, not universal OS lifecycle ownership |

tmux and launchd are local adapter implementations, not product identity or
architecture. systemd, Kubernetes, Nomad, Docker, Docker Compose, MDM desktop
agents, managed runners, direct process, and stdio supervisors must be able to
conform to the same normalized evidence contract.

Eligibility, identity, lifecycle transitions, manifest admission, claim,
lease, fence, finalization, rollback, and protected gates remain
script-controlled. LLM output may produce task content; it cannot decide
admission, equality, terminal state, or protected authority.

## 6. Frozen Cell graph

| Order | Cell | Outcome | Gate |
| ---: | --- | --- | --- |
| 10 | `CELL-AUN-RECOVERY-CONTRACT-001` | Control contract, trace, checklist, tests, owner gates, and handoff frozen | independent exact-head design audit |
| 20 | `CELL-AUN-REGISTRY-RECONCILIATION-001` | exact candidate denominator and zero-ambiguity reconciliation plan | independent audit plus `OD-AUN-001` |
| 30 | `CELL-AUN-CANONICAL-RECEIVE-001` | canonical `aun` canary, two normal queues, and restart continuity | exact evidence and owner scope |
| 40 | `CELL-AUN-MANIFEST-PUBLISH-001` | closed-world manifest accepted and read back | manifest audit and owner pin |
| 50 | `CELL-AUN-FLEET-ACTIVATION-001` | staged N/N ordinary auto-receive | `OD-AUN-002`, stop-on-first-failure |
| 60 | `CELL-AUN-REBOOT-CONVERGENCE-001` | controlled login/reboot convergence and rollback | evidence audit, operator acceptance, owner final decision |

No Cell may start before its dependencies and protected decision are complete.
No new Cell or split is allowed without a recorded graph amendment.

## 7. Plan and procedure

### Phase 10 — Control freeze

1. Materialize exactly the five Control artifact paths.
2. Safe-parse the YAML, validate graph and trace counts, and verify the exact
   five-path delta from the pinned parent.
3. Publish an immutable Issue 602 V3 amendment with GitHub API byte readback.
4. Open a Draft Control PR and record exact head, tree, parent, file hashes, and
   aggregate path-hash.
5. Route that exact head to an independent `evidence_audit_gate`.
6. Do not advance to Cell 20 until the audit passes.

### Phase 20 — Reconcile the denominator

1. Read the canonical profile registry without name inference.
2. Classify production, test, disabled, stale, and contradictory profiles.
3. Resolve one primary workspace, one fresh runtime, profile revision,
   provider identity, Control source, active function, auto-receive, D1
   isolation, and Discord mode for each expected seat.
4. Emit the exact candidate `N`, target set, digests, exclusions, and blockers.
5. Require expected equals resolved, blockers zero, ambiguity zero, and an
   independently audited protected reconciliation plan.
6. Request the single combined `OD-AUN-001` only after all exact inputs exist.

### Phase 30 — Prove canonical receive

1. Under `OD-AUN-001`, pin the exact canonical `aun` identity, release, config,
   manifest candidate, queue scope, and rollback.
2. Remove the retired-seat one-row fence only through the accepted plan.
3. Run one exact canonical canary.
4. Run two fresh ordinary queues with no manual/bypass contribution.
5. Run one approved daemon restart continuity test.
6. Preserve queue/result/reply/terminal/audit evidence and require zero
   duplicate execution.

### Phase 40 — Publish the manifest

1. Build canonical closed-world bytes from the reconciled set.
2. Validate schema, sorting, target digest, artifact digest, owner pin, revision,
   expiry, revocation, and projection equality.
3. Independently audit the exact artifact.
4. Persist and read back only under the owner decision.
5. Keep D1 admission and effects separate and unchanged.

### Phase 50 — Activate the fleet

1. Present exact waves, per-wave capacity, rollback, and reboot window for
   `OD-AUN-002`.
2. Admit only exact manifest targets.
3. Stop on the first failed target; do not continue later admission.
4. Require each seat to pass the same lifecycle and identity proof.
5. Reconcile N/N and zero blocker/drift/bypass/unexpected-exclusion values.

### Phase 60 — Login/reboot acceptance

1. In the approved window, record the exact host, release, manifest, config,
   queues, operator, and rollback.
2. Prove restore, watchdog, daemon, runtime/profile equality, and fresh queue
   completion after login or reboot.
3. Prove terminal work did not re-execute.
4. Rehearse rollback and read back the previous release, manifest, and config.
5. Obtain independent evidence audit, distinct operator acceptance, and owner
   final decision before marking Issue 602 `VERIFIED_DONE`.

## 8. Requirement and acceptance trace

| Requirement | Measurable acceptance | Tests |
| --- | --- | --- |
| REQ-REC-001 exact release provenance | all release/config/build/manifest/rollback identities exact | TEST-001, TEST-002 |
| REQ-REC-002 durable supervisor readiness and rollback | normalized adapter readiness and deterministic restore | TEST-005, TEST-017 |
| REQ-REC-003 canonical automatic receive | one canary plus two unfenced queues, bypass zero | TEST-003, TEST-006, TEST-007 |
| REQ-REC-004 exactly-once claim/lease/fence | one valid owner/fence/terminal, duplicate zero | TEST-003, TEST-004, TEST-010 |
| REQ-REC-005 typed result and closure | typed outcome plus reply/outbound and terminal evidence | TEST-002, TEST-004, TEST-006, TEST-009 |
| REQ-REC-006 no manual/bypass PASS | prohibited contribution count zero | TEST-007, TEST-015 |
| REQ-REC-007 restart convergence | pre/new work once, terminal work never reruns | TEST-008, TEST-010 |
| REQ-REC-008 closed-world denominator | expected equals resolved equals N, blockers zero | TEST-011, TEST-012 |
| REQ-REC-009 per-target equality | one workspace/runtime and exact bindings per target | TEST-011, TEST-013, TEST-014, TEST-015 |
| REQ-REC-010 staged fleet activation | N/N and stop-on-first-failure | TEST-013, TEST-017 |
| REQ-REC-011 containment and rollback | kill switch and previous state restore | TEST-005, TEST-009, TEST-010, TEST-017 |
| REQ-REC-012 immutable maker-checker evidence | distinct exact-head audit/operator/owner evidence | TEST-001, TEST-012, TEST-013, TEST-018 |
| REQ-REC-013 D1 isolation | ordinary changes leave D1 authority invariant | TEST-016 |
| REQ-REC-014 controlled reboot convergence | fresh queue completes without human prompt | TEST-018 |

The machine-readable graph contains the normative 14 acceptance predicates.

## 9. Frozen test matrix

| Test | Kind | Green predicate |
| --- | --- | --- |
| TEST-001 | static | exact release, build, plist, env, manifest, rollback digests |
| TEST-002 | focused | restricted-PATH nested Bun and finalizer errors propagate |
| TEST-003 | focused | notification/sweep/claim-source/lease/fence tests pass |
| TEST-004 | disposable PostgreSQL | mutation-time fence, affected row one, rollback, lease race pass |
| TEST-005 | preflight | immutable checkout, install plan, supervisor, rollback GO; mutation false |
| TEST-006 | live canary | canonical `aun` automatically claims, processes, replies, terminates |
| TEST-007 | live normal | two fresh ordinary queues pass after fence removal |
| TEST-008 | restart | pre/new queues run once; terminal queue never reruns |
| TEST-009 | failure | runner/finalizer/provider failure cannot become success |
| TEST-010 | failure | DB reconnect and lease expiry cause no duplicate/false terminal |
| TEST-011 | manifest | schema, denominator, duplicate runtime, stale identity, test leak fail closed |
| TEST-012 | disposable PostgreSQL | manifest up/up/down refusal/up and trust lifecycle pass |
| TEST-013 | live fleet | every exact target passes; N/N evidence |
| TEST-014 | negative | disabled/test/stale/wrong-identity/unverified-provider rejected |
| TEST-015 | memory gate | fresh canonical memory required; expiry/bypass fail |
| TEST-016 | regression | ordinary manifest does not alter protected D1 |
| TEST-017 | rollback | kill switch and previous manifest/release/config restore |
| TEST-018 | operator | controlled login/reboot restores and completes a fresh queue |

Tests 006 through 018 that mutate or exercise protected/live surfaces are not
authorized by this spec. They run only in their admitted Cell and exact owner
decision scope.

## 10. Completion checklist

Issue 602 remains open until all are true:

- [ ] The V3 amendment and graph v1 have immutable refs and API readback.
- [ ] All 14 requirements map to acceptance, tests, and evidence.
- [ ] Exact release, build, plist, environment, manifest, and rollback exist.
- [ ] Profile classification and runtime equality are unambiguous.
- [ ] Candidate expected `N` equals resolved `N` with blockers zero.
- [ ] Canonical canary and two unfenced queues pass.
- [ ] One approved restart continuity test passes.
- [ ] Manifest publication and projection readback pass.
- [ ] Staged fleet N/N lifecycle passes.
- [ ] Manual/bypass contribution count is zero.
- [ ] Protected D1 isolation regression passes.
- [ ] Rollback rehearsal passes.
- [ ] Controlled login/reboot convergence passes.
- [ ] Independent audit, operator acceptance, and owner final decision exist.
- [ ] The control source is `VERIFIED_DONE` with no blocking next action.

## 11. Failure and rollback policy

The machine graph defines stable failures for placed-not-delivered,
declared-not-verified, raw-denominator promotion, retired-seat fencing,
duplicate runtime, contradictory profile state, wrong endpoint identity,
claim/lease race, finalizer false success, restart duplicate, partial fleet
activation, D1 bleed, human bypass as PASS, and unverified rollback.

Detection is deterministic. Recovery either keeps the relevant Cell blocked,
routes an exact reconciliation/correction, stops later wave admission, or
restores the previous manifest, release, and config. Rollback never deletes
queue history, bulk-closes active work, uses raw SQL repair, or substitutes a
restart/prompt for evidence.

## 12. Protected decisions

`OD-AUN-001` is requested only after exact denominator, manifest candidate,
canonical activation plan, release, config, queue fence, and rollback are
known. It combines exact profile reconciliation, manifest publication,
canonical `aun` activation, one daemon restart, and rollback authority.

`OD-AUN-002` is requested only after the canonical Cell passes and exact fleet
waves plus reboot window are known. It combines staged fleet activation,
rollback authority, and controlled login/reboot acceptance.

No approval is requested for ordinary read-only diagnostics, evidence
readback, listed non-mutating validation, or per-agent queues inside an already
approved exact wave.

## 13. Design Flow G1–G7 result

- G1 PASS: all intent is sourced; unsourced domain semantics zero.
- G2 PASS: deterministic agent-first control, explicit autonomy tiers, typed
  evidence, knowledge grounding, MCP boundary, and fixture learning loop.
- G3 PASS: UI/connector, runtime/LLM, DB, identity/auth, and platform supervisor
  axes are adapter-separated with provenance.
- G4 PASS: 14 requirements, 14 measurable acceptance predicates, 18 tests, and
  zero trace gaps.
- G5 PASS: 14 detection/recovery failure modes, including placed versus
  delivered and declared versus verified.
- G6 PASS: protected surfaces and owner decisions are explicit; author differs
  from auditor; runtime authorization is false.
- G7 PASS: exact audit handoff and durable reach-check are defined.

This is a candidate PASS for independent audit. It is not an audit verdict,
runtime GO, owner decision, merge decision, or completion claim.

## 14. Next action

`codex-audit` acts next as `evidence_audit_gate`. It audits the exact Draft
Control PR head against the graph, Cell, spec, handoff, and audit checklist,
without editing files. It returns an immutable PASS, REQUEST_CHANGES, or
ESCALATE verdict with exact head/tree, hashes, validation evidence, and a
complete `next_action` to ARC and AUN.
