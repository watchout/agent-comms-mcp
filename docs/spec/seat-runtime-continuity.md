# Seat runtime continuity — bounded amendment

Status: ADOPTED D1–D4 on 2026-09-21; implementation and source tests are in progress. NP12 applied acceptance remains NOT_RUN. The earlier CH-SEAT-CONTINUITY-IMPLEMENT-20260913-001 admission applies only to its historical subject.

Owner adoption: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755364993 (raw SHA256 `8414bb149e2a8b9aee4fb62b87f11d6109d5bc9bf9beb67019e282e21bcc1791`). Implementation scope: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755382588 (raw SHA256 `26e3a3ff050f1522948abc03704d116e4296e27122ec8e5e80744c5f340c82a0`). Adoption does not certify this implementation or grant activation.
Current delta baseline: `9d7e6f5b06b0d9a4b13011760e543cfc8a795e14`, tree `9a002f1baf49fcbc8ac8f91db83165db3489a093`. Original continuity baseline: `0f772883db6f3b50772d3e4b82ce47795091f0a9` (historical; use the exact original source reference below for provenance).
Author: `codex-cto/restore_inventory`, `control_artifact_author`; later SC3 implementation executor. SC1/SC2 integration maker: `codex-cto/restore_executor`. Maker history is retained; neither maker provides the independent gate. This two-file v2 delta is authored by `codex-cto/execution_guide_review`, `control_artifact_author`; the 9d7 implementation maker remains Work and repo ownership remains codex-aun. This author does not independently gate this delta.

## Authority and outcome

Control source: [OD/CH-SEAT-CONTINUITY-20260913-001](https://github.com/watchout/agent-comms-mcp/issues/575#issuecomment-5650158508), body SHA-256 `068864d3f38656952d4b07ca6669e7547f7bdb17b9f560ad2bae68b5f54227b4`.
Owner: 「基本的な考え方として、LLMをいつどこで入れ替えても文脈が残るのが席を用意するということでしょう」
The requested outcome is implementation and applied behavior for a stable seat whose durable objective, decisions, unfinished work, and next action survive provider and host-local runtime replacement. Hidden model state is not promised. Manual fixed LLM/port profile edits are not an ordinary transition step.

This amendment resolves the conflicting startup-selection and static endpoint clauses in `docs/operations/aun-bootstrap.md` Runtime selection, `docs/agent-com-message-queue-spec.md` 13.5.1.2, and NORM-022 Runtime Lifecycle for this scope. The implementation must update those clauses and `docs/SSOT.md` together. Existing identity, protected authority, runtime-kind separation, queue claim/fence, and memory isolation contracts remain normative. This document does not activate production or grant merge authority.

## Current change authority and scope

The [two-file handoff](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5754173816)
(raw SHA256 `9dd8bd107e3e8338685201bcfea7cef9b2ac85290032944804182278941636d9`)
authorizes authoring and publishing this proposed docs delta only. It reuses the
[09:21 source mapping](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5753833850)
(raw SHA256 `ae513c3d9b4a3ef14bd1399b97ab62690a62f6c21e36bf6bf260381a97dc6826`)
and the [independently reviewed R08 proposal](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5723061539)
(raw SHA256 `55ea369e64e26ce5f6df6bda2c7b1068a41b19d2e31720a946a453ee634d9982`).
R08 is reused, not treated as adopted design or authority for new effects.

The [v2 acceptance ledger](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5753716854)
(raw SHA256 `c375849c4a8e50f1624b7f6ab3930bcdfc70213f22bcce42bce583da8ad2f81c`)
keeps AUN2-03/04/15 open. The target remains: provider, port and disappearing
execution state are not saved in the DB; identity, permissions, messages,
claims and history remain durable. At baseline 9d7 the implementation still
writes/reads runtime and lease observations; this document does not report that
mismatch as repaired product behavior. The target rules below apply to the
proposed v2 implementation after the concrete D1–D4 disposition, independent
review and a separately scoped implementation handoff.

## Stable ownership and observations

| Data | Owner and persistence | Ordinary replacement behavior |
|---|---|---|
| Seat `agent_id`, enabled/disabled status, authority refs, permissions, logical memory project, logical workspace/repository binding | Existing identity/profile and memory contracts | Retain the seat, project and logical repository; absolute host path is observed location and cannot rename the seat/project |
| Durable objective, decisions, unfinished work, next action | Existing Kusabi/Wasurezu partition and GitHub control source for authority | Retrieve by the same seat/project; authority is verified at its control source |
| Queue item, claim owner, claim token, expiry, completion/fencing history | Existing queue and lease contract | Preserve; a new runtime cannot clear, inherit, finish or reissue a claim merely because it replaced an LLM |
| Actual LLM provider, PID/start, physical host/workspace/session, endpoint/port, online/busy/stopped/liveness/last-seen | Request-local OS/process/socket observations; no new AUN DB persistence or durable observation cache | Re-observe each operation and replacement; existing historical bytes remain but never select a current target |
| Opaque runtime UUID and lease holder/fence/authority expiry | Existing durable logical identity and authority contract; not a physical process snapshot | Preserve referenced UUID rows/FKs and existing claim ownership; a new incarnation gets a new UUID, never the prior claim |
| `agents.runtime_engine_preference`, `agents.channel_port`, launcher port literals | Legacy compatibility data | Never select the ordinary actual LLM or endpoint; no automatic DB rewrite to make observation match these fields |
| Provider account and credential references | Existing account/provider authority | Preserve existing selection and isolation; no credential copying, new login, or provider switch inferred from available authentication |

`runtime_kind` is a runtime namespace (`local_process`, `bootstrap_bound_provider`, etc.), not an LLM brand. A generic AUN/MCP `local_process.runtime_engine` such as `TUI` is not evidence that the LLM is Codex or Claude. For the proposed v2 path, neither a sealed historical `bootstrap_bound_provider` row nor `runtime_engine` is a current provider observation. Obtain the actual provider from verified exact-target process identity and retain that observation only for the current operation. Do not overwrite the AUN runtime-kind namespace to encode the LLM. Retain separate runtime instances when existing kinds coexist.

The existing V2 native S0 `deterministic-s0` TurnRuntime is provider-free (`provider_dispatch=disabled`, `V1_mode=observe_only_no_traversal`). Its frozen runtime identity remains distinct from an LLM host. The selector preserves that exact native kind; LLM entries still require verified live provider observation for the same frozen runtime instance. Duplicate native runtimes and missing or foreign LLM observations remain denied.

The durable workspace binding identifies the logical repository/project, not an immutable host-specific absolute path. Existing `agents.home_directory` values remain historical bytes, not a current discovery or cold-launch input. A verified same-seat/project invocation at a new host-local path must not require a profile edit. Verify the target process against the explicit invocation/current runtime provenance and stable logical identity; never accept a foreign workspace merely because a caller supplied the same seat string. Preserve explicit memory project across path/basename changes.

## SC-1 — provider selection and cold start

1. For an existing seat with a live LLM, select the provider from verified ancestry or the existing exact-target process inspector. Bind evidence to `agent_id`, actual process identity, the currently requested workspace/session and invocation provenance; a legacy `home_directory` or tmux name is historical location evidence, not authority to reject a verified relocated seat. Merely finding an executable, version, authentication, environment of a controller, or another seat's process is insufficient. Existing target inspection must remain target-scoped.
2. One verified provider selects its adapter even when the legacy DB preference differs. Report the stale preference as observation; it cannot block or cause a profile rewrite. Multiple contradictory live provider identities fail with an explicit ambiguity result. Missing live identity cannot be disguised as a known provider.
3. Proposed D3: when no live provider can be verified, cold startup requires explicit provider intent for this invocation and the existing launch authority. Remove DB `metadata.provider_observation` / `SELECTED_HISTORY` as fallback, including same-seat historical observations. Explicit intent conflicting with a still-live target is not permission to replace it. No intent returns the existing typed missing-selection result with launch count 0. No preference, global provider default or installed-account fallback is permitted. This changes the historical cold-start contract and remains pending D3 disposition.
4. Apply the same selection result at bootstrap, start/restart planning, queue-work dispatch and provider-sensitive read models. Queue scheduling uses the selected exact current provider observation; it must not silently fall through to a process-wide Codex runner when selection is absent. Adapter invocation continues only under the existing claimed-work and protected tool boundaries.
5. Explicit invocation policy keeps its sandbox, cwd and allowed directories when its provider matches the current observation. A mismatching explicit provider policy fails before wake reservation or invocation; an observed provider cannot replace a stricter policy with adapter defaults.
6. Provider changes do not change memory project, credential ownership, enabled state or role/function authority. Unsupported providers return an explicit unsupported result and preserve the seat's recoverable work; this amendment does not implement new provider adapters.

## SC-2 — OS socket ownership and endpoint resolution

1. Normal local bridge startup requests loopback port `0` from the OS and keeps the returned listening socket open. Do not probe an available port and close it before binding, scan a fixed port range, or kill an unrelated holder to acquire a configured port. Read the actual port from the listening server object; port `0` itself must never be published.
2. After bind, create the logical runtime UUID anchor and acquire the existing authority lease in its fenced transaction. Persist only logical identity, holder, fence, authority validity and allowed durable fields; never persist endpoint/PID/provider/path/status snapshots in the runtime row or lease metadata. The request-local observation joins the committed lease by exact runtime UUID. Preserve transaction/fencing checks and reject stale-owner renewal. No second port table, registry, allocation daemon or persistent snapshot file is introduced.
3. Ordering is mandatory: retain bound socket → commit exact logical UUID/lease → reobserve the same holder/PID/start/socket → expose the endpoint for ordinary use. Socket discoverability before commit does not confer readiness. Failed or unknown commit gives no publication, claim or invocation; close only the socket owned by this attempted startup. Reconcile the exact logical transaction using the existing bounded idempotency/readback route; an unresolved commit remains UNKNOWN and cannot trigger another startup. Do not revoke another lease or close another process socket.
4. Resolve each consumer using the same request-local host observation AND active, unexpired exact-holder authority lease. Obtain the endpoint from the held socket/OS owner, never lease JSON, profile port or DB runtime physical columns. Recheck identity/fence immediately before effect. DB authority failure denies work even if the socket is visible. A remote host's loopback is not local reachability; unsupported remote inspection returns unavailable.
5. Concurrent launches can receive different OS ports. Each transiently exposed endpoint must resolve back to its own runtime/holder; a stale lease, old DB row or delayed observation cannot resurrect the replaced endpoint. Multiple eligible runtimes remain subject to existing kind/identity/concurrency rules; dynamic allocation is not permission to duplicate a seat's active work.
6. Existing generated Codex TOML and Claude `.mcp.json` per-seat `AUN_WEBHOOK_PORT`/`WEBHOOK_PORT` values are legacy projection, not explicit new fixed-infrastructure intent. The source launch/config-generation/sync paths must generate dynamic allocation and stop copying `channel_port`; classify static requests only from an explicit invocation-level compatibility option, never from the presence of an old generated environment value. Preserve the existing MCP alias (`aun` or `agent-comms`). Application of updated generated configuration is a separately scoped exact-target operation; no fleet config writes occur during source authoring.
7. Explicit external/static endpoint compatibility may remain only as explicit launch configuration with ownership checks and bind failure on collision. It is not the normal seat path and cannot restore profile-port authority or arbitrary holder cleanup. MCP stdio, the local webhook bridge and optional multi-bot SSE listeners must remain distinct transports; publish the endpoint consumers actually use.

Continuous native configuration generation also requires fresh same-seat runtime
and account-root observations plus the matching logical authority lease. These
physical observations remain request-local and are not persisted into a candidate,
outbox or DB receipt. Desired provider,
physical home/workspace and channel port remain historical diagnostics. Generated
bridge intent is port 0; runtime readback compares the actual bound port. Stable
identity, enrollment, provider identity/token references and release authority stay
in desired state. The candidate binds the observed runtime/PID/start/root/lease
identity transiently; no reversible physical tuple is copied into a durable
candidate. Stable source/config/permission identity remains durable. Validation
re-observes the current holder before acceptance.

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

## NP — Non-persistence boundary, discovery and compatible cutover (R08 reuse)

### NP1 — Durable identity versus transient observations

After the adopted cutover, AUN-owned PostgreSQL/SQLite writes must not add or
refresh actual provider/ancestry/session, PID/process start, physical host/path,
port/endpoint, or online/busy/stopped/last-seen observations. This includes system
copies in metadata, connector rows, readiness/native-delivery receipts, audit,
eventlog, outbox, generated DB projections and error serialization. Renaming or
encoding a snapshot is not compliance. Persist no alternative runtime snapshot
file. Retain owner-authored task/message content and its digest unchanged; the
boundary concerns machine-copied observations, not destructive redaction of
historical conversations because they contain a port or provider name.

Durable identity/project/logical workspace, enablement/enrollment, permissions,
credential references, desired release/configuration, task/message/Next, opaque
incarnation UUID, claim owner/token/expiry, lease holder/fence/expiry, effect
idempotency and completion/acceptance history remain. A lease's active/released
state or claim heartbeat is durable authority, not OS liveness. No blanket ban
on DB state updates may remove these controls. Runtime-only observation changes
must not advance desired revision/digest/outbox; genuine stable policy changes
still do so under the existing contract.

D2 scope is all AUN-owned sinks, including AUN copies of memory receipts. The
separate Kusabi/Wasurezu original receipt storage remains unchanged and is not
claimed compliant. AUN must read/revalidate the original native receipt through
the existing same-seat/project adapter, then persist only allowed logical IDs,
source/config identity, context/result digests, proof completion/validity and
reason codes. Do not copy physical receipt fields or recovery argv into AUN DB.
A prior saved ready row cannot substitute for fresh native evidence. Extending
the original memory product's storage contract is a separate concrete scope
judgment, not an assumed prerequisite that all Kusabi development is complete.

### NP2 — Existing host adapter, one-operation observation

Reuse held Bun sockets, the existing process inspector/ancestry and host adapter.
The proposed shared boundary is
`HostRuntimeObserver.inspect({agentId, runtimeInstanceId?, logicalWorkspace, expectedHost, intent?, deadline})`.
It returns `{observations, reasonCode}` in caller memory: seat/runtime UUID,
actual host/PID/start/provider ancestry/workspace/session, held transport/endpoint,
observation time and freshness bound. These are internal proposed interface
fields, not a claim of an already implemented public API. An adapter translates
OS I/O; the semantic core verifies identity, authority and freshness. Neither
model prose nor a caller-supplied `verified` flag grants trust.

D1 requires the existing `AGENT_COM_RUNTIME_INSTANCE_ID` to be generated and
passed by the managed launcher before exec. Inspect exact-seat environment
identity, process ancestry, canonical current workspace, PID/start and actual
listener ownership; never log the full environment/credentials. A post-start
assignment inside `server.ts` is not assumed visible to another process.
A new reader must discover independently from OS plus logical authority, without
DB physical rows or another caller's global cache. An unverifiable/unbound launch
is unavailable. A forged environment tuple, another seat's listener, ambiguous
holders or changed PID/start denies use. Existing provider-free native S0 keeps
its separate identity and never fabricates an LLM provider.

Use the existing per-operation deadline across enumeration and **all** candidates,
including the existing 3-second inspector ceiling; do not allocate a fresh full
budget to each candidate. No cross-operation cache, background daemon, monitor,
new retry loop or remote transport is introduced. Reobserve before a delayed or
irreversible action. Missing/timeout/clock reversal yields the existing typed
unavailable/ambiguity and zero dispatch; no saved DB/history fallback.

### NP3 — UUID/FK, writer/reader and daemon cutover

At 9d7, `message_queue.assigned_runtime_instance_id` and
`claimed_runtime_instance_id`, connector and lease holders reference
`agent_runtime_instances`; deletion can set these references to NULL. Preserve
all existing referenced rows, IDs and claim/fence/history bytes. A new incarnation
gets a new opaque UUID and a minimal logical anchor, not a reused row or claim.
The anchor records no actual physical/provider state; `runtime_kind` remains a
logical namespace. New anchors and lease acquisition use the existing atomic,
fenced path after socket bind. UUID publication before exec is identity supply,
not lease acquisition or permission to process work.

The acquisition and renewal boundary now uses an explicit process-held logical
receipt (`lease_id`, `fencing_token`). A new process inserts its UUID anchor and
acquires the lease in one transaction; an existing UUID is not an upsert target.
Only the acquiring server renews/releases that receipt. Its transaction uses a
dedicated connection and concurrent lifecycle callbacks share one in-flight
operation. The standalone `agent-com heartbeat` command observes current
endpoint authority; it does not renew another process's lease or update profile
liveness columns. All expiry conditions use advancing database wall time, not
PostgreSQL's transaction-start `CURRENT_TIMESTAMP`.

On 64-bit macOS, the MCP process start is read afresh with `proc_pidinfo`, including
microseconds; `ps lstart` seconds alone cannot distinguish a same-second UUID
replay. Missing kernel evidence denies observation. A grant rounded to
milliseconds cannot establish ownership of a later sub-millisecond start.
Other platforms' existing process-start observation precision remains an
unaccepted coverage gap; the macOS fixture is not a portability certificate.

Cleanup's transient plan binds the entire observed holder identity (excluding the
sampling timestamp). Before an effect it checks the same holder, zero active or
unknown work, and zero active endpoint leases. It terminates only that process;
logical anchors/history remain. Unproven tmux-session/orphan ownership produces
no effect. Audit stores logical action kinds and IDs only.

Native readiness preserves the original delivery's completion timestamp. It
re-reads native input and then rechecks the exact logical evidence at database
wall time before admission. The logical proof serializer validates identity,
UUID, pack reference, digests and completion time; machine source/reason/log IDs
cannot carry a raw exception or path. Operator-authored reason text and every
existing bypass scope constraint remain unchanged.

A new versioned migration must reconcile both database schemas and guarded
serializers. Existing source schemas already allow most physical columns NULL,
but `runtime_engine`/`status` defaults and SQLite `started_at NOT NULL DEFAULT`
and readiness `session_name`/`port`/`recovery_command` constraints require explicit
handling. Do not fill required fields with an actual observation or invent a
fake process time. Preserve logical UUID/agent/FK/lease constraints and all legacy
row values; an additive migration record may use a transactional SQLite table
rebuild only with exact before/after row/FK preservation and failed-migration
rollback evidence. No previously applied migration is edited, no history is
cleared, and no schema migration is executed by this docs change.

Close the actual column/JSON sink inventory before writing the migration. Use
explicit durable-field serializers plus DB-side guards for covered sinks; unknown
sink coverage stops that implementation slice. Guards reject new observation
values and physical changes to legacy rows. An unrelated allowed logical update
may retain byte-identical legacy values, but may not copy them into new records.
This is not satisfied by a substring scan of arbitrary task/message content.

All readers and writers change in the same compatible release:

| Path / seam in 9d7 | Required implementation delta | Acceptance trace |
|---|---|---|
| `server.ts`, `core/runtime-heartbeat.ts`, `core/agent-status-lifecycle.ts` | Stop physical/status heartbeat writes and connector/lease copies; create only logical anchors/authority state; preserve exact owned release fence | NP01/02/03/10 |
| `core/seat-runtime-selection.ts`, `core/runtime-endpoint.ts`, `core/runtime-current-resolver.ts`, `core/runtime-inventory.ts` | Discover using shared fresh host observation; read only logical DB authority; remove DB PID enumeration and historical provider fallback | NP03/04/05/06 |
| `core/state-daemon/index.ts`, `bin/state-daemon.ts`, `core/state-daemon/adapter-registry.ts` | Keep enrollment/enablement/channel membership durable; derive runtimeReady and provider from the same fresh observation in eligibility/dispatch/liveness/claim renewal. Remove `agents.runtime/status/runtime_engine_preference` as runtime truth; keep DB-time expiry and owner/token predicates atomically fenced | NP02/04/05/08 |
| `core/runtime-cleanup.ts`, `core/bot-status-db.ts`, `core/bot-health.ts`, `core/bot-lifecycle.ts` | Compose health in memory; DB/observer failure means UNKNOWN. Missing process does not prove no work; cleanup needs exact owned process and no active/unknown work | NP04/06/08/11 |
| `core/runtime-memory-ready.ts`, `core/runtime-memory-ready-identity.ts`, `core/runtime-memory-ready-refresher.ts`, `core/seat-context-recovery.ts` | Re-read native proof and reobserve actual host on each admission; strip AUN-owned copied physical payloads while retaining logical proof/history | NP01/02/07/10 |
| `core/aun-configuration-desired-state.ts`, `core/aun-configuration-candidate.ts`, `core/aun-configuration-reconciler.ts` | Retain existing digest exclusions; no persisted candidate/outbox physical tuple; current diagnostics stay transient | NP01/09/10 |
| `bin/aun/bootstrap.ts`, `bin/aun/start.ts`, `bin/aun/run-queue-work.ts`, `scripts/restart-bot.sh`, `scripts/sync-mcp-config.sh` | Supply pre-exec UUID/explicit intent at existing launch boundaries; all callers share observer/selector; no local fixed seat/path/port contract | NP04/05/06 |
| `db/migrate.ts`, `db/migrate-sqlite.ts`, new versioned migrations; every affected DB serializer | Logical anchors and optional physical fields, FK-preserving cutover, positive durable allowlists, legacy/mixed-writer guards | NP01/02/10/11 |

The table is being implemented by the independent `codex-aun` executor under [handoff 5755777052](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755777052) (body SHA256 `8b135ba67e36071b94c834e02f5b78e9d7c8b298936163c155b33af520c778a4`). The former subagents stopped; no additional bootstrap commit is pending. It does not imply that all paths or assertions are complete. The final evidence matrix records code coverage, actual test results and gaps separately. Current claim authority remains necessary even when host observation
succeeds. Renewal is scoped to exact work/holder/fence and fresh same-holder proof,
never a bulk inference from `agents.status`; observing a replacement does not
renew, clear or inherit its predecessor's claim. E7 shared slots, deferral metrics,
child/slot timeouts, credential/sandbox isolation and existing queue guards remain.

The ordinary unbounded receive/CLI/MCP claim stores the freshly authorized
runtime UUID in `claimed_runtime_instance_id` in the same UPDATE as owner/time/expiry,
with the exact lease/fence and database-clock expiry predicate. SQLite compares
parsed instants for both SQL-format historical authority times and ISO claim times. Queue-work advance,
result, error and finalize retain that incarnation; a replacement holder cannot
execute or finish an old incarnation's claim. Re-observe ownership before terminal
effects and retain logical owner/time/UUID evidence only. Provider-free S0 authority
is a separate pending contract and is not inferred from an LLM provider observation.

Stable profile enrollment updates only identity, UI identity, enablement and
credential/expected-account references. Physical provider/path/port/session flags
are rejected before mutation. Profile projection consumes an existing unambiguous
logical primary workspace binding; it never derives an ID from a physical path or
links runtime rows by saved status. Missing logical membership is an explicit
blocker, not permission to invent deployment identity.

Managed server shutdown releases its exact acquired lease while its process still
holds the observed socket, then closes the socket. Startup and shutdown do not
persist profile status, status_detail, provider, endpoint or liveness observations.

### NP4 — Replacement, legacy retention and rollback

Startup order is SC2.3. Replacement/restart preserves logical seat/project,
unfinished tasks/Next, prior claims and idempotency history. Reconcile pending,
completed and unknown effects through existing rules; unknown outcome stops the
affected replacement, with no replay or fallback model. Authority DB unavailable
means new claims/invocations 0 even if OS inspection works. Observer unavailable
means health UNKNOWN; it is not a reason to clear claims or kill a stale DB port.

D4 retains all pre-cutover physical/history bytes without refresh or forward copy.
Stop/deny old physical writers during the separately authorized cutover; mixed
writers get an explicit incompatible result, not a compatibility fallback that
persists observations again. Reader/writer/guard compatibility must be proven on
both PostgreSQL and SQLite before activation. Existing desired-format migration
and incompatible-down guards above remain required, not automatically applied.

Rollback keeps the persistence guard and restores only an independently verified
compatible source build under exact effect authority. Neither legacy fa94 nor
F522 is certified compatible by this proposal. If no compatible fallback exists,
stop new work and retain claims/history; prepare an exact recovery disposition.
Do not automatically restore a physical-writing release, remove the guard, renew
old operation windows or perform F→R. Historical C23 proposal/consumption remains
history and is not v2 deployment authority.

### NP5 — First-implementation assertions (12 existing R08 commitments)

These are test commitments, **NOT_RUN**, not new product success evidence. Every
row is required. NP12 is applied acceptance after source tests; it is not a
requirement to execute real tasks before permitting a reviewed implementation.
All captures use synthetic records and bind exact implementation head/tree,
command/environment, per-assertion results and raw evidence digest.

| ID | Existing requirement / source decision | Existing or required fixture; observable assertions |
|---|---|---|
| NP01 | AUN2-03; NP1/NP3 all sinks | Extend `tests/runtime-heartbeat.test.ts`; add `tests/contract/test_runtime_observation_nonpersistence.test.ts` (absent at 9d7). Startup→renew→readiness→configuration→error→stop→restart: SQL+params recorder and isolated DB readback show new physical/provider writes 0, including nested/copy sinks; deliberately injected old writer is rejected |
| NP02 | AUN2-04/07; durable identity/FK | Extend `tests/seat-runtime-continuity.test.ts`, `tests/queue-work.test.ts`: seeded identity/project/message/claim owner-token-expiry/fence/history digests equal before/after replacement; old runtime rows/FKs unchanged; new UUID cannot replay or finalize old attempt |
| NP03 | AUN2-05; SC2 exact ordering | Extend `tests/norm-022-runtime-endpoint-lease.test.ts`: held port-0 sockets distinct; bind/commit/fresh holder order recorded; before/unknown commit usable endpoint/invoke count 0; only owned failed socket closed |
| NP04 | AUN2-06/07; fresh identity | Extend `tests/runtime-current-resolver.test.ts`: wrong seat/host/cwd/PID start, PID reuse, duplicate holder, forged UUID and revoked/expired fence each yield dispatch 0; identity changed between observe/effect is rejected |
| NP05 | D3; SC1 cold provider | Extend `tests/seat-runtime-continuity.test.ts`: no-live+no-intent with tempting DB history gives launch 0; explicit valid intent selects exact provider; conflicting live intent rejects; native S0 stays provider-free |
| NP06 | D1; fresh-reader discovery | Extend `tests/norm-022-runtime-endpoint-lease.test.ts`: new independent reader discovers held socket from pre-exec UUID/OS+logical lease without runtime physical rows or prior process cache; reader restart discards observation; unbound UUID rejects |
| NP07 | D2; AUN2-10/11 | Extend `tests/runtime-memory-ready.test.ts` / `tests/seat-context-recovery.test.ts`: genuine original native receipt re-read; wrong project/PID-start/provider/pipe/expiry denies; saved ready row alone never admits; AUN DB copied physical payload count 0 |
| NP08 | AUN2-08/09; degraded authority | Extend `tests/state-daemon-queue-work-scheduler.test.ts` / `tests/runtime-heartbeat.test.ts`: OS-visible+DB-down and DB-present+observer-timeout give health UNKNOWN and new claim/invoke/cleanup 0; complete candidate enumeration shares original deadline |
| NP09 | AUN2-04; desired-state invariance | Reuse/extend `tests/aun-configuration-desired-state.test.ts` and `tests/contract/test_aun_configuration_runtime_diagnostics.test.ts`: only physical provider/port/path changes give revision/digest/outbox changes 0; stable policy change advances once |
| NP10 | D4; legacy/mixed writers | New non-persistence contract fixture plus existing migration/diagnostics fixtures: populated PostgreSQL and SQLite retain legacy rows/FKs/history byte-for-byte, new anchors have no snapshots; guarded metadata/audit/readiness writer negatives reject; reapply no-op; injected migration failure rolls back without data loss |
| NP11 | D4; recovery compatibility | Extend `tests/seat-runtime-continuity.test.ts` / `tests/contract/test_aun_configuration_restart_gate.test.ts`: compatible build accepted only under existing effect authority; old physical writer/F522 without compatibility proof denied; guard and claim/fence history preserved |
| NP12 | AUN2-15/21; exact proof tiers | Independent design/source review and current implementation test evidence for NP01–11, followed by authorized exact applied-version/ordinary-path readback. Draft docs, old C23/198-test sums or dry-run cannot supply this row; cross-product original receipt limitation stays explicit |

Proposed focused command after fixture authoring and an implementation handoff:

```sh
bun test tests/contract/test_runtime_observation_nonpersistence.test.ts tests/runtime-heartbeat.test.ts tests/seat-runtime-continuity.test.ts tests/norm-022-runtime-endpoint-lease.test.ts tests/runtime-current-resolver.test.ts tests/state-daemon-queue-work-scheduler.test.ts tests/queue-work.test.ts
bun test tests/runtime-memory-ready.test.ts tests/seat-context-recovery.test.ts tests/aun-configuration-desired-state.test.ts tests/contract/test_aun_configuration_runtime_diagnostics.test.ts tests/contract/test_aun_configuration_restart_gate.test.ts
```

The original design author did not execute product tests. The current independent
implementation packet is [trial-ready-003/RETURN.md](../verify/aun-v2-nonpersistence-20260921/trial-ready-003/RETURN.md).
Bind a private PostgreSQL cluster,
socket, role and explicit URL; `tests/helpers/postgres-test-database.ts` has
ambient/default fallbacks, so a different DB name alone is not isolation proof.
SQLite uses a newly created fixture DB, seeded legacy rows and loopback-only
processes. Record actual selected/skipped cases, failures and environment. Retain
existing bounded-admission/native-S0/E7 tests; rerun only affected scope under its
next exact handoff, without reducing whole-release required checks.

### NP6 — Concrete pending decisions and next implementation boundary

| Decision | Recommended proposal | Alternative and impact | Current disposition |
|---|---|---|---|
| D1 | Pre-exec immutable runtime UUID + existing per-call host inspection, fresh-reader proof | Preserve post-start-only UUID/unbound launches: an independent reader cannot safely locate that runtime without another transport; do not substitute DB physical discovery or invent a new daemon | ADOPTED by owner 5755364993; valid-UUID reuse rejection still requires implementation evidence |
| D2 | Cover all AUN-owned DB sinks and copied receipts; keep original Was/Kusabi receipt contract separately scoped | Include the original memory-product store too: requires a separate concrete cross-product design/implementation scope; no global completion claim until then | ADOPTED by owner 5755364993; original memory-product DB is outside this AUN change |
| D3 | Explicit intent when no live provider; remove DB historical-provider fallback | Retain `SELECTED_HISTORY`: conflicts with literal non-persistence and can select an obsolete provider; would require an explicit changed owner requirement | ADOPTED by owner 5755364993; no historical-provider fallback |
| D4 | Retain old data, guard new writes, allow only compatible rollback | Restore a physical-writing old release/remove guard: violates non-persistence; requires an exact exceptional recovery disposition, never automatic F522 | ADOPTED by owner 5755364993; compatible rollback still requires actual evidence |

The CTO collects these four exact judgments together; document authoring and
unrelated authorized work continue. No generic acknowledgment restarts a stopped
product operation. After applicable design disposition and independent review,
codex-aun binds the new exact subject, complete source/sink paths, test commands,
finite budget/stop rules and a non-maker checker in the existing handoff. This
section is not that implementation authorization. Preserve this maker's history.
The next actor receives a published commit and returns per-predicate implementation
evidence to #940; exhausted/unknown/forbidden effects stop only the affected slice
and return one concrete finding through the existing controller route.

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
| P03 | SC1 proposed D3 cold explicit intent; DB history/profile-only/no-intent negative cases | Selected provider equals explicit invocation intent; no-intent launch and historical fallback counts equal 0 |
| P04 | SC1 bootstrap, restart and queue-work consumers use one selection contract | Tests assert exact target/provider and claim predicates; global/default fallback count equals 0 |
| P05 | SC2 two concurrent OS port-0 binds retained through registration | Bound ports are nonzero and distinct; each transient socket observation/logical lease/response identity matches its holder |
| P06 | SC2 failed/unknown commit, expired authority, stale observation and wrong owner | Discovery returns no ineligible endpoint; only the failed instance's socket closes |
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
| Port race, lease transaction failure, holder mismatch or stale replay | Actual held socket plus committed exact-holder logical lease; no usable endpoint before commit and fresh check | Close own unpublished socket on failure; expire/release only owned lease under current fences; retry by new bind0; retain old runtime history |
| Mixed revision still using a profile port/provider | Ordinary-path integration fixture and exact-version readback | Keep affected activation stopped; align listed consumers as one compatible audited release; only D4-compatible rollback, never rewrite profile to hide drift |
| Adapter drift / host-specific bypass | Same normalized provider/endpoint/context predicates in every changed adapter | Correct the affected adapter against the same contract; unsupported host/provider returns explicit result without side effects |
| Wrong subject test, placed-only artifact or parent/component confusion | Bind fixture commit/tree, implementation evidence and applied receipt separately | Rerun only against exact accepted candidate; green design/package checks cannot substitute for source or runtime acceptance |
| Maker-checker collapse, prompt expansion, missing protected approval | Native function/maker history and published authority check | Root routes independent gate; no self-gate, merge, runtime application, account/queue edits or messages under author/maker scope |
| Timeout, absent required evidence or unreachable handoff | Bounded limits and typed missing predicate | Retain existing bounded attempts; return the exact finding to codex-aun/CTO via #940 and native collaboration. Historical 2026-09-14 expiry grants no current work; a new exact implementation handoff supplies its own finite deadline |

Rollback follows proposed D4: retain existing historical bytes and durable memory/claims, keep the persistence guard, and use a verified compatible build only under separate exact authority. A previous consumer that needs DB physical snapshots is incompatible. Stop the affected activation rather than restore stale ports or resume observation writes. No live mutation is authorized by this authored design.

## Delivery and terminal boundary

Implementation order: (1) provider selection plus all callers and adversarial tests; (2) socket/lease/publication/consumer chain with concurrency and rollback tests; (3) memory identity plus continuity/claim fixtures through the existing boundary; (4) source/spec reconciliation, exact-head independent audit; (5) separately bounded application and ordinary-path receipt. The parent outcome remains open until every P01–P12 predicate has the required proof tier.

Historical SC1–3 maker: `codex-cto/restore_executor`; current implementation baseline maker: Work. The next product executor is selected by repo lead codex-aun in an exact handoff after the applicable design disposition and independent review; this docs author is not its own checker. No historical worktree/actor assignment supplies current permission. Product changes, synthetic fixture DBs/loopback servers, focused tests, commits and draft PR are implementation-scope operations. Live DB/profile/schema/queue/credentials, other seats, external test messages, merge/deploy and forced restart are forbidden. Do not edit the original live checkout. The accompanying DesignPack carries the exact path/command/trace ledger and evidence destinations.

## Exact implementation supply

The following allowlist is conditional on independent same-digest design acceptance and the controller's exact implementation handoff. It is not author permission to edit product code. The following inherited paths are an impact inventory, not the complete v2 edit authorization. NP3 adds the concrete sink/schema/observer implications. Reuse existing logical runtime rows, authority lease tables and adapters; no physical runtime/endpoint observation may be written into them. The next handoff enumerates every affected existing/new path. Existing `core/aun-configuration-desired-state.ts` and bootstrap B3/B8 must not reintroduce profile provider/port equality or write-back during ordinary replacement. Tests of those consumers must demonstrate zero legacy profile edits.

Inherited implementation impact inventory (no current edit authorization):

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

SC1 callpath: existing bootstrap exact-target collector → shared selection → bootstrap / server lifecycle command builder / restart script / `bin/state-daemon.ts` queue selection / `core/state-daemon/index.ts` adapter mapping. SC2 proposed callpath: held Bun socket + current host observation → committed logical UUID/authority lease join → same fresh observer/selector in status, lifecycle, cleanup and memory-ready. In the proposed v2 implementation, `heartbeatRuntimeInstance` must stop persisting the physical observation. SC3 callpath: `resolveRuntimeMemoryReadyProject` → existing Kusabi recovery response and host invocation pack → new-runtime-bound identity/readiness evidence; no readiness on transport-only or project-substring proof.

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

Historical receipt root: `/Users/yuji/Developer/codex/control-artifacts/seat-continuity/20260913/` (not a product deployment path). New evidence destination is bound in the current #940 implementation handoff; bind test logs to implementation base/head/tree, command, isolated fixture configuration, per-predicate assertions and exit result. Required final receipts additionally bind the independently audited commit, actual applied checkout/process version, seat/project/runtime/endpoint identities and SC1–3 ordinary-path observations. No conversation or credential content is recorded.

SC3 ordinary readiness uses evidence for the exact selected local MCP runtime UUID. B5 may separately keep a sealed-provider receipt; it must independently validate the native stored input for the actual MCP UUID before recording ordinary readiness. Evidence lookup separates known runtime kinds, then requires the exact selected UUID so sealed and ordinary views cannot shadow each other. A newer invalid same-kind or unknown-runtime record still denies; no older-success fallback is introduced. A UUID rewrite or a metadata-only mapping never substitutes for current provider PID/start/session/workspace, child ancestry and exact logical lease verification against a current request-local observation; the physical tuple is not copied into AUN DB.

SC3 logical project resolution uses explicit `agents.metadata.memory_project`, or exactly one currently valid native context receipt for the selected local MCP runtime. The same-seat/project original receipt must be read and pass the exact logical-runtime/authority and fresh host/provider checks. A saved AUN readiness row alone cannot supply the current observation. No absolute path, local workspace row, or basename selects a memory namespace. Missing or multiple verified projects fail explicitly; bootstrap must carry its explicit target project before ordinary readiness can discover it.

For the proposed v2 implementation, the existing `aun memory-ready-bootstrap`
command must observe logical runtime/authority plus request-local provider/socket
and the actual host's connected memory binding, then read
the already accepted native receipt and records ordinary readiness through the
same strict helper as B5. It does not run bootstrap B2/B7/B8, migrate desired state,
change profiles/claims or restart a daemon. Optional runtime/session/port/project
arguments are expectations against the observed target, never overrides. Dry-run
performs only read-only planning and no native provider/MCP call or readiness write.
SQLite dry-run opens only an existing clean rollback-journal database with readonly/create-false flags. WAL header mode or any WAL/shared-memory/journal sidecar is rejected before opening: SQLite readonly alone can modify shared-memory bytes. It creates neither a missing database nor a replacement snapshot. Existing read-only guarantees remain. The proposed v2 non-dry-run path must obey NP1/NP3 sink restrictions; it is not claimed implemented by this sentence.

Ambient `AGENT_MEMORY_PROJECT` is target intent only when the accompanying memory
agent identity is the requested seat and no expected-seat binding contradicts it.
A foreign or unbound caller project cannot replace the target's stable DB/native
project. Explicit `aun start --project` supplies invocation intent; native/project
configuration remains scoped to that invocation and preserves shared account files.
