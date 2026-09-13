# Seat runtime continuity — bounded amendment

Status: implementation candidate; independent source acceptance and applied evidence pending. Design admission PASS is recorded in CH-SEAT-CONTINUITY-IMPLEMENT-20260913-001.
Baseline: `0f772883db6f3b50772d3e4b82ce47795091f0a9`.
Author: `codex-cto/restore_inventory`, `control_artifact_author`; later SC3 implementation executor. SC1/SC2 integration maker: `codex-cto/restore_executor`. Maker history is retained; neither maker provides the independent gate.

## Authority and outcome

Control source: [OD/CH-SEAT-CONTINUITY-20260913-001](https://github.com/watchout/agent-comms-mcp/issues/575#issuecomment-5650158508), body SHA-256 `068864d3f38656952d4b07ca6669e7547f7bdb17b9f560ad2bae68b5f54227b4`.
Owner: 「基本的な考え方として、LLMをいつどこで入れ替えても文脈が残るのが席を用意するということでしょう」
The requested outcome is implementation and applied behavior for a stable seat whose durable objective, decisions, unfinished work, and next action survive provider and host-local runtime replacement. Hidden model state is not promised. Manual fixed LLM/port profile edits are not an ordinary transition step.

This amendment resolves the conflicting startup-selection and static endpoint clauses in `docs/operations/aun-bootstrap.md` Runtime selection, `docs/agent-com-message-queue-spec.md` 13.5.1.2, and NORM-022 Runtime Lifecycle for this scope. The implementation must update those clauses and `docs/SSOT.md` together. Existing identity, protected authority, runtime-kind separation, queue claim/fence, and memory isolation contracts remain normative. This document does not activate production or grant merge authority.

## Stable ownership and observations

| Data | Owner and persistence | Ordinary replacement behavior |
|---|---|---|
| Seat `agent_id`, enabled/disabled status, authority refs, permissions, logical memory project, logical workspace/repository binding | Existing identity/profile and memory contracts | Retain the seat, project and logical repository; absolute host path is observed location and cannot rename the seat/project |
| Durable objective, decisions, unfinished work, next action | Existing Kusabi/Wasurezu partition and GitHub control source for authority | Retrieve by the same seat/project; authority is verified at its control source |
| Queue item, claim owner, claim token, expiry, completion/fencing history | Existing queue and lease contract | Preserve; a new runtime cannot clear, inherit, finish or reissue a claim merely because it replaced an LLM |
| Actual LLM provider, process identity, host/workspace observation, runtime instance, endpoint, liveness | Verified process/bootstrap/runtime evidence | Re-observe each transition; obsolete values are history, never desired state |
| `agents.runtime_engine_preference`, `agents.channel_port`, launcher port literals | Legacy compatibility data | Never select the ordinary actual LLM or endpoint; no automatic DB rewrite to make observation match these fields |
| Provider account and credential references | Existing account/provider authority | Preserve existing selection and isolation; no credential copying, new login, or provider switch inferred from available authentication |

`runtime_kind` is a runtime namespace (`local_process`, `bootstrap_bound_provider`, etc.), not an LLM brand. A generic AUN/MCP `local_process.runtime_engine` such as `TUI` is not evidence that the LLM is Codex or Claude. A sealed `bootstrap_bound_provider` row may identify the provider in `runtime_engine`; otherwise a provider must be obtained from verified exact-target process identity and recorded as provenance-bearing observation. Do not overwrite the AUN runtime-kind namespace to encode the LLM. Retain separate runtime instances when existing kinds coexist.

The durable workspace binding identifies the logical repository/project, not an immutable host-specific absolute path. `agents.home_directory` may remain a cold-start location hint/history, but a verified same-seat/project invocation at a new host-local path must not require a profile edit. Verify the target process against the explicit invocation/current runtime provenance and stable logical identity; never accept a foreign workspace merely because a caller supplied the same seat string. Preserve explicit memory project across path/basename changes.

## SC-1 — provider selection and cold start

1. For an existing seat with a live LLM, select the provider from verified ancestry or the existing exact-target process inspector. Bind evidence to `agent_id`, actual process identity, the currently requested workspace/session and invocation provenance; a legacy `home_directory` or tmux name is historical location evidence, not authority to reject a verified relocated seat. Merely finding an executable, version, authentication, environment of a controller, or another seat's process is insufficient. Existing target inspection must remain target-scoped.
2. One verified provider selects its adapter even when the legacy DB preference differs. Report the stale preference as observation; it cannot block or cause a profile rewrite. Multiple contradictory live provider identities fail with an explicit ambiguity result. Missing live identity cannot be disguised as a known provider.
3. Cold startup uses an explicit launch intent for this invocation, or a verified last-runtime observation of this same seat. Last-runtime evidence must carry actual provider provenance, host/process/runtime identity and observation ordering; profile-only, stopped generic MCP, foreign-seat, conflicting or unverified observations cannot qualify. Explicit intent conflicting with a still-live target is not permission to replace it. No qualifying evidence returns a typed missing-selection result without launching. No preference, global provider default or installed-account fallback is permitted.
4. Apply the same selection result at bootstrap, start/restart planning, queue-work dispatch and provider-sensitive read models. Queue scheduling uses the selected exact current provider observation; it must not silently fall through to a process-wide Codex runner when selection is absent. Adapter invocation continues only under the existing claimed-work and protected tool boundaries.
5. Provider changes do not change memory project, credential ownership, enabled state or role/function authority. Unsupported providers return an explicit unsupported result and preserve the seat's recoverable work; this amendment does not implement new provider adapters.

## SC-2 — OS socket ownership and endpoint resolution

1. Normal local bridge startup requests loopback port `0` from the OS and keeps the returned listening socket open. Do not probe an available port and close it before binding, scan a fixed port range, or kill an unrelated holder to acquire a configured port. Read the actual port from the listening server object; port `0` itself must never be published.
2. Register the actual loopback endpoint, owning process and runtime instance through the existing runtime heartbeat and `control_plane_leases` endpoint lease. The runtime row and lease refer to the same bound endpoint/holder. Preserve existing transaction/fencing checks and reject stale-owner renewal. No second port table, registry, allocation daemon or persistent port list is introduced.
3. Bind precedes endpoint publication. Until lease registration succeeds, the instance is not discoverable/ready for ordinary consumers. On registration failure, close only the socket owned by this instance and return a typed startup failure. Cleanup is bounded and does not edit another runtime's row, revoke its lease, or release another process's socket.
4. Resolve each consumer by selected exact seat/runtime identity plus an active, unexpired lease and liveness evidence. Use the lease's actual endpoint; never synthesize an endpoint from profile port or fall back to a stale port after a lookup failure. An endpoint on another host is not local loopback reachability. Keep existing host/transport constraints and reject unsupported remote use.
5. Concurrent launches can receive different OS ports. Each published endpoint must resolve back to its own runtime/holder; a stale lease or delayed heartbeat cannot resurrect the replaced endpoint. Multiple eligible runtimes remain subject to existing kind/identity/concurrency rules; dynamic allocation is not permission to duplicate a seat's active work.
6. Existing generated Codex TOML and Claude `.mcp.json` per-seat `AUN_WEBHOOK_PORT`/`WEBHOOK_PORT` values are legacy projection, not explicit new fixed-infrastructure intent. The source launch/config-generation/sync paths must generate dynamic allocation and stop copying `channel_port`; classify static requests only from an explicit invocation-level compatibility option, never from the presence of an old generated environment value. Preserve the existing MCP alias (`aun` or `agent-comms`). Application of updated generated configuration is a separately scoped exact-target operation; no fleet config writes occur during source authoring.
7. Explicit external/static endpoint compatibility may remain only as explicit launch configuration with ownership checks and bind failure on collision. It is not the normal seat path and cannot restore profile-port authority or arbitrary holder cleanup. MCP stdio, the local webhook bridge and optional multi-bot SSE listeners must remain distinct transports; publish the endpoint consumers actually use.

Continuous native configuration generation also requires fresh same-seat runtime
and account-root observations plus the matching endpoint lease. Desired provider,
physical home/workspace and channel port remain historical diagnostics. Generated
bridge intent is port 0; runtime readback compares the actual bound port. Stable
identity, enrollment, provider identity/token references and release authority stay
in desired state. The candidate binds the observed runtime/PID/start/root/lease
identity; sampling time is excluded from that identity to avoid a new candidate on
every observation. Validation re-observes the current holder before acceptance.

The canonical desired digest excludes `runtime_engine_preference`,
`canonical_home`, `canonical_workspace`, `channel_port`, and the three physical
projection keys `provider_repo_root`, `provider_config_root`, `daemon_checkout`.
A runtime-only update leaves desired revision, digest, provenance and outbox
unchanged; a stable policy change advances revision once. New dynamic seats may
leave those diagnostics unset (or port zero); stable enrollment, account identity
references, control references and release checks remain required.

The September diagnostics migration performs one atomic format transition only
for complete legacy rows whose positive revision and stored digest exactly match
the legacy canonical document. Each eligible row receives revision +1, the
stable-only digest and exactly one event through the existing trigger. All other
identity, runtime, credential reference, control/release and queue values and all
previous observed/outbox/restart history are preserved. Invalid or incomplete
legacy rows remain untouched and unavailable to strict readers. Reapplying the
migration is a no-op. The paired down migration rejects populated stable-format
history with `AUN_DESIRED_FORMAT_ROLLBACK_INCOMPATIBLE`; application must explicitly
cover this shared format transition, separately from any target seat restart.

## SC-3 — durable context and unfinished work

1. Resolve the logical memory project using the existing target-agent memory identity contract, never the controller CWD, provider name, new checkout basename or another agent's ambient identity. The primary memory namespace is `agent_id`; `project` is its subordinate filter, as defined in Wasurezu SSOT-7. The same seat/project remains the recovery partition across Codex/Claude and host-local process replacement. Host path changes are adapter/location changes, not an instruction to invent a new memory project.
2. Recover existing durable objective, decisions, unfinished work and next action through Kusabi/Wasurezu. Bind the returned recovery receipt to the requested seat/project and the new runtime identity. A receipt for a different seat/project, missing required durable fields, unreadable memory provider or stale/mismatched receipt cannot satisfy memory-ready.
3. Reuse Wasurezu `continuation-equivalent-state/v1`: `identity.agent_id`, `identity.memory_project`, `work.objective`, `work.active_task_ids`, `work.next_actions`, `work.blockers`, decision `summary_digest`, artifact/source references, and effect replay policy. Reuse `recovery-pack-v1` and `host-invocation-context-v1` for delivery. Verify that the selected pack is included as data in the target host invocation; a successful `recover_context` transport call or text containing the project name is insufficient. The new runtime must obtain its own receipt; the old runtime receipt does not transfer.
4. The fixture seeds durable records through the existing memory boundary, replaces provider and host-local runtime observations, then retrieves and compares the same record identifiers/content digests. A second seat in the same project and a second project under the same seat must remain excluded. Test both Codex→Claude and Claude→Codex with one shared isolated durable store and different workspace basenames. Existing per-host interruption tests use separate stores and do not prove this replacement predicate. Use synthetic context only; no owner conversation bodies or credentials in fixtures or logs.
5. A preexisting queue claim remains byte-for-byte owned and fenced through recovery. Recovery displays unfinished work and next action; execution may resume only through existing ownership/reconciliation rules. Never clone, clear or mark completed a queue item as a migration convenience.
6. Bind the actual memory child launch to the requested stable `AGENT_MEMORY_AGENT_ID` and project through existing provider/config adapters. A global or ambient `arc`/controller identity cannot override an explicit target seat; the returned identity and target invocation consumption must be verified, not merely the generated config text. Conflicting fixed global binding returns an explicit mismatch until the admitted target binding is supplied. Do not rewrite global credentials/config or copy auth as the repair.
7. Use current AUN memory identity/recovery seams first. If proving continuity requires a Kusabi code change, report the exact missing contract and request the already-authorized bounded second-repo path supplement from the controller before editing that repo. AUN-only green tests cannot claim full SC-3 until the actual boundary receipt exists.

Source for this memory contract: Wasurezu release `f7fcd0f181e032e740036d8ee31733c18019d31d`, `docs/design/core/SSOT-7_RUNTIME_AGENT_BINDING.md:20–57`, `src/kusabi-checkpoint-recovery.ts:41–154`, `src/restart-pack.ts:65–107`. AUN baseline gaps are `bin/aun/bootstrap.ts:1394–1402` (project substring check) and `core/runtime-memory-ready-refresher.ts:76–115` (ready evidence without recovery). They must not be used as whole SC-3 proof.

## Observable acceptance and first-implementation fixture commitments

All rows are REQUIRED. These are fixture commitments, not implementation test results.

| ID | Normative decision and fixture specimen | Pass/fail observation |
|---|---|---|
| P01 | SC1 verified Codex with legacy Claude preference, and converse | Selected adapter equals actual provider; profile write count equals 0 |
| P02 | SC1 missing, contradictory, foreign-seat and generic-MCP-only evidence | Explicit reason code; launch/invocation count equals 0 |
| P03 | SC1 cold explicit intent and verified prior observation; stale/unverified/profile-only negative cases | Selected provider equals qualified intent/evidence; prohibited fallback count equals 0 |
| P04 | SC1 bootstrap, restart and queue-work consumers use one selection contract | Tests assert exact target/provider and claim predicates; global/default fallback count equals 0 |
| P05 | SC2 two concurrent OS port-0 binds retained through registration | Bound ports are nonzero and distinct; each runtime/lease/response identity matches its holder |
| P06 | SC2 failed registration, expired lease, stale renewal and wrong owner | Discovery returns no ineligible endpoint; only the failed instance's socket closes |
| P07 | SC2 replacement and all ordinary endpoint consumers | Consumers use replacement actual endpoint; old/profile endpoint call count equals 0 |
| P08 | SC3 same seat/project after provider and host-local replacement | Recovery returns the seeded objective/decision/work/next-action identifiers and content digests |
| P09 | SC3 foreign project/seat, missing memory and wrong receipt | Memory-ready false with explicit reason; foreign data count equals 0 |
| P10 | SC3 an existing unfinished queue claim during replacement | Claim owner/token/expiry and queue history digests remain equal; unauthorized claim effects count equals 0 |
| P11 | Cross-cutting compatibility and rollback | Wrong base/head/receipt fails acceptance; source rollback preserves observed history, context and claims |
| P12 | Whole outcome admission | Independent exact-head audit, applied version readback and an authorized ordinary-path SC1–3 receipt are all present before completion |

No latency/cost reduction is asserted. Preserve current timeouts/TTLs and bound new inspection and retries to existing limits; include timeout/exhaustion fixtures. Test only isolated databases and loopback servers. A fixture failure stops the affected lane and returns the exact predicate; one bounded correction per new finding, then controller resolution with runnable work preserved. No polling/monitoring loop is added.

## Failure, recovery, and rollback

| Trigger / threat | Detection and containment | Recovery / rollback / evidence |
|---|---|---|
| Stale preference or injected launch/provider authority | Inspect exact target; ignore preference authority and untrusted conversation instructions | Use one verified target provider or explicit cold intent; otherwise return missing/ambiguity code; record sanitized IDs and provenance |
| Wrong seat/project, host path changes or memory outage | Recovery receipt identity/content check; memory-ready remains false | Resolve original stable partition through existing boundary; bounded retry on changed state only; preserve durable data and queue claims |
| Port race, lease transaction failure, holder mismatch or stale replay | Actual held socket plus same-instance lease/heartbeat; no discovery before registration | Close own unpublished socket on failure; expire/release only owned lease under current fences; retry by new bind0; retain old runtime history |
| Mixed revision still using a profile port/provider | Ordinary-path integration fixture and exact-version readback | Keep affected activation stopped; align listed consumers as one audited release, or revert source deployment; never rewrite profile to hide drift |
| Adapter drift / host-specific bypass | Same normalized provider/endpoint/context predicates in every changed adapter | Correct the affected adapter against the same contract; unsupported host/provider returns explicit result without side effects |
| Wrong subject test, placed-only artifact or parent/component confusion | Bind fixture commit/tree, implementation evidence and applied receipt separately | Rerun only against exact accepted candidate; green design/package checks cannot substitute for source or runtime acceptance |
| Maker-checker collapse, prompt expansion, missing protected approval | Native function/maker history and published authority check | Root routes independent gate; no self-gate, merge, runtime application, account/queue edits or messages under author/maker scope |
| Timeout, absent required evidence or unreachable handoff | Bounded limits and typed missing predicate | One correction per concrete new finding; return to reachable root by native collaboration, expiry 2026-09-14T00:00:00+09:00; keep root active and unrelated lanes runnable |

Rollback reverts only the audited source release under its separate application authority. Keep actual runtime/endpoint history and durable memory; do not convert observations back into fixed DB desired values. If the previous consumer version cannot resolve dynamic endpoints, stop that affected activation rather than write profile ports or send to stale endpoints. No live mutation is authorized by this authored design.

## Delivery and terminal boundary

Implementation order: (1) provider selection plus all callers and adversarial tests; (2) socket/lease/publication/consumer chain with concurrency and rollback tests; (3) memory identity plus continuity/claim fixtures through the existing boundary; (4) source/spec reconciliation, exact-head independent audit; (5) separately bounded application and ordinary-path receipt. The parent outcome remains open until every P01–P12 predicate has the required proof tier.

Maker: `codex-cto/restore_executor` only after independent design acceptance and the exact path handoff. Author cannot implement or independently gate this amendment. Worktree is `/Users/yuji/Developer/agent-comms-mcp-seat-continuity-20260913`, baseline above. Product changes, synthetic fixture DBs/loopback servers, focused tests, commits and draft PR are implementation-scope operations. Live DB/profile/schema/queue/credentials, other seats, external test messages, merge/deploy and forced restart are forbidden. Do not edit the original live checkout. The accompanying DesignPack carries the exact path/command/trace ledger and evidence destinations.

## Exact implementation supply

The following allowlist is conditional on independent same-digest design acceptance and the controller's exact implementation handoff. It is not author permission to edit product code. New modules are limited to pure shared selection (`core/seat-runtime-selection.ts`) and retained listener/endpoint lifecycle (`core/runtime-endpoint.ts`); they must reuse existing runtime rows, lease tables and adapters. Existing `core/aun-configuration-desired-state.ts` and bootstrap B3/B8 must not reintroduce profile provider/port equality or write-back during ordinary replacement. Tests of those consumers must demonstrate zero legacy profile edits.

Allowed implementation files:

- `core/tmux-runtime-inspector.ts`
- `tests/tmux-runtime-inspector.test.ts`
- `core/seat-runtime-selection.ts`
- `core/runtime-endpoint.ts`
- `core/runtime-inventory.ts`
- `core/runtime-current-resolver.ts`
- `core/runtime-heartbeat.ts`
- `core/runtime-memory-ready.ts`
- `core/runtime-memory-ready-refresher.ts`
- `core/runtime-memory-ready-identity.ts`
- `core/runtime-cleanup.ts`
- `core/bot-status-db.ts`
- `core/bot-lifecycle.ts`
- `core/aun-configuration-desired-state.ts`
- `core/aun-configuration-reconciler.ts`
- `core/state-daemon/index.ts`
- `core/state-daemon/adapter-registry.ts`
- `core/startup-safety.ts`
- `bin/state-daemon.ts`
- `bin/aun/bootstrap.ts`
- `bin/aun/start.ts`
- `bin/aun/run-queue-work.ts`
- `server.ts`
- `scripts/restart-bot.sh`
- `scripts/sync-mcp-config.sh`
- `scripts/startup-safety-preflight.ts`
- `tests/seat-runtime-continuity.test.ts`
- `tests/runtime-heartbeat.test.ts`
- `tests/runtime-memory-ready.test.ts`
- `tests/runtime-memory-ready-refresher.test.ts`
- `tests/runtime-memory-ready-identity.test.ts`
- `tests/runtime-cleanup.test.ts`
- `tests/norm-022-runtime-endpoint-lease.test.ts`
- `tests/runtime-current-resolver.test.ts`
- `tests/state-daemon-queue-work-scheduler.test.ts`
- `tests/state-daemon-adapter-registry.test.ts`
- `tests/aun-bootstrap.test.ts`
- `tests/startup-safety.test.ts`
- `tests/contract/test_seat_runtime_continuity.test.ts`
- `tests/contract/test_aun_bootstrap_clean_host.test.ts`
- `tests/contract/test_aun_configuration_endpoint_rebind.test.ts`
- `tests/contract/test_aun_configuration_restart_gate.test.ts`
- `docs/spec/seat-runtime-continuity.md`
- `docs/spec/norm-022-runtime-endpoint-lease-supervisor-adapter-impl.md`
- `docs/spec/aun-runtime-supervisor-adapter-contract.md`
- `docs/operations/aun-bootstrap.md`
- `docs/agent-com-message-queue-spec.md`
- `docs/SSOT.md`

SC1 callpath: existing bootstrap exact-target collector → shared selection → bootstrap / server lifecycle command builder / restart script / `bin/state-daemon.ts` queue selection / `core/state-daemon/index.ts` adapter mapping. SC2 callpath: held Bun server socket → actual port/URI → `heartbeatRuntimeInstance` / existing endpoint lease → status, lifecycle, cleanup and memory-ready consumers. SC3 callpath: `resolveRuntimeMemoryReadyProject` → existing Kusabi recovery response and host invocation pack → new-runtime-bound identity/readiness evidence; no readiness on transport-only or project-substring proof.

Fixture destinations: P01–P04 extend bootstrap, current-resolver, adapter/queue, startup-safety tests and `tests/seat-runtime-continuity.test.ts`; P05–P07 extend heartbeat/lease/cleanup/memory-ready and configuration endpoint-rebind tests; P08–P10 use `tests/contract/test_seat_runtime_continuity.test.ts` plus bootstrap/memory-ready identity tests. That new contract test must exercise the actual existing memory boundary with one synthetic durable store; a stub-only test may prove AUN response validation, but cannot discharge the memory continuity predicate. P11 uses restart-gate/rollback tests and exact-head readback. P12 uses independently produced code audit and separately authorized ordinary-path applied receipt, not a self-produced fixture PASS. If the existing memory boundary requires second-repo edits, the exact missing path supplement is a controller transition, with all other implementation runnable.

Focused verification commands (fixture database setup must be isolated; no production connection inheritance):

```sh
bun test tests/seat-runtime-continuity.test.ts tests/runtime-heartbeat.test.ts tests/runtime-current-resolver.test.ts tests/norm-022-runtime-endpoint-lease.test.ts tests/startup-safety.test.ts
```

```sh
bun test tests/aun-bootstrap.test.ts tests/state-daemon-queue-work-scheduler.test.ts tests/state-daemon-adapter-registry.test.ts
```

```sh
bun test tests/runtime-memory-ready.test.ts tests/runtime-memory-ready-refresher.test.ts tests/runtime-memory-ready-identity.test.ts tests/runtime-cleanup.test.ts
```

```sh
bun test tests/contract/test_seat_runtime_continuity.test.ts tests/contract/test_aun_bootstrap_clean_host.test.ts tests/contract/test_aun_configuration_endpoint_rebind.test.ts tests/contract/test_aun_configuration_restart_gate.test.ts
```

```sh
git diff --check
```

```sh
git rev-parse HEAD
```

Receipt destination: `/Users/yuji/Developer/codex/control-artifacts/seat-continuity/20260913/`; bind test logs to implementation base/head/tree, command, isolated fixture configuration, per-predicate assertions and exit result. Required final receipts additionally bind the independently audited commit, actual applied checkout/process version, seat/project/runtime/endpoint identities and SC1–3 ordinary-path observations. No conversation or credential content is recorded.

SC3 ordinary readiness uses evidence for the exact selected local MCP runtime UUID. B5 may separately keep a sealed-provider receipt; it must independently validate the native stored input for the actual MCP UUID before recording ordinary readiness. Evidence lookup separates known runtime kinds, then requires the exact selected UUID so sealed and ordinary views cannot shadow each other. A newer invalid same-kind or unknown-runtime record still denies; no older-success fallback is introduced. A UUID rewrite or a metadata-only mapping never substitutes for current provider PID/start/session/workspace, child ancestry and lease verification.

SC3 logical project resolution uses explicit `agents.metadata.memory_project`, or exactly one currently valid native context receipt for the selected local MCP runtime. The same-seat/project receipt must pass the existing exact runtime/lease/provider readiness checks. No absolute path, local workspace row, or basename selects a memory namespace. Missing or multiple verified projects fail explicitly; bootstrap must carry its explicit target project before ordinary readiness can discover it.
