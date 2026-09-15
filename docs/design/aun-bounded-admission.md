# Bounded admission and reply redelivery

Status: implementation of independently admitted design generation 5; not a live release.
Control source: watchout/agent-comms-mcp#940. Design admission:
https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5600533790
(raw SHA256 f82e3a215f0341cc0e012609dd761a4bfdc7bfd67673d026f6fd9a872f9d035d).
Implementation handoff: #940/5600600067, raw SHA256
a73638ab595370177bca7f08b7898dc2c11dbcaa3a0172d31481dc45093c76bf.
Frozen design SHA256 7dbaa3b040a1cb23b0312ad04d06975f2b9ed4796718ab85365988b266f30364.
Reply amendment: #940/5592663591, raw SHA256
a7b7c6d8e4e3c5bfd7405965febf4bac3f167d3a8c603d4fe48520d45889be92.

## Boundary and storage

AUN owns deterministic transport, claim, invocation, result and host reply; Shirube owns
business acceptance. CLI is canonical. This is opt-in queue correctness, not a replacement
framework or a claim of fleet normalization. Message IDs/status vocabulary and existing lease
semantics remain unchanged. An expired lease is not a sticky admission policy.

`queue_admission_policies` owns an immutable policy/recipient/configuration digest, published
authority/source/cohort/role mappings, two task definitions, expiry, max_tasks=2 and WIP=1.
Statuses: PREPARED, ENABLED, HALTED, CLOSED. `queue_admission_tasks` binds ordinal 1|2 to
one genuine message/queue, exact payload/input/authority and claim/runtime fences; stages:
ENROLLED, INVOKING, RESULT_SAVED, FINALIZING, REPLIED, ACCEPTED, HALTED. Invocation and
finalizer counters are durable 0|1. There is no reset/reopen operation or third ledger table.

SQL `aun_admission_*` functions are the sole transition authority. A non-login owner owns
tables/functions; ordinary runtime, executor and controller principals are distinct. Revoke
PUBLIC execution and direct ledger mutation; SECURITY DEFINER uses a fixed search_path.
The policy pins actual principals, not a role name supplied by a prompt. A core-minted
transaction/backend/operation/row binding permits only that exact guarded mutation and is
consumed in the same transaction. Legacy queue-first writes use NOWAIT, never reversed waits.
Administrator bypass is outside the guarantee: live role/grant and worker tool-isolation
readback is mandatory; sharing superuser credentials with a worker is not admitted.

When the existing observation-v2 queue trigger is installed, its SECURITY INVOKER
function runs inside the admission owner's guarded queue update. The admission
migration therefore grants that fixed NOLOGIN owner SELECT on
`fleet_runtime_queue_observation_active` and SELECT/INSERT/UPDATE on
`fleet_runtime_queue_agent_revisions`, with no DELETE, sequence or owner-membership
grant. The epoch sequence, both tables, exact enabled queue trigger and its invoker
function must form a complete topology with the v2 active marker. Partial or
inconsistent topology refuses installation atomically. A schema with none of those
optional objects retains the existing installation/default and PostgreSQL 16
behavior; installing observation-v2 later requires reapplying this migration before
bounded use. Removal revokes only these dependency privileges and retains the
observation objects and history.

The shared PostgreSQL 17 bounded fixture installs the actual 2026-08-16 migration
before reapplying admission. Normal claim, invocation and result each increment the
recipient revision; revoking any required dependency must refuse the transition
without changing the queue, task, policy or revision. These restricted-owner tests
do not substitute for actual target-schema/principal readback at application.

The installed interface revision is `2026-09-08.v1`. Read-only
`aun_admission_capability()` returns a digest of the actual ordered SQL function
definitions, owners and ACLs. The reviewed policy's `guard_digest` pins that value;
PREPARE and every guarded transition reject drift. Loaded binding readback also
requires all six exact recipient/policy triggers enabled. This byte/interface
check is not proof of external authority or worker isolation.

## First deny

PREPARE uses a dedicated PostgreSQL 17 control connection with transaction_timeout=1s set
before BEGIN ISOLATION LEVEL READ COMMITTED. Missing capability is typed unsupported before
locks. No network/provider call or two-phase transaction is permitted inside this transaction.

1. Verify exact published authority/configuration and fresh external no-worker evidence.
2. LOCK TABLE agent_messages, message_queue, outbound_queue IN SHARE ROW EXCLUSIVE MODE NOWAIT.
3. A separate fresh READ COMMITTED statement refuses received/in_progress/read, incomplete
   done/finalizer work, unaccounted claim obligations and claimed projections. Proven completed
   history may remain: an exact same-recipient explicit record-no-reply terminal baton with a valid completion
   time and no runner/finalizer/reply/projection obligation, or a joined N1 successful internal
   no-op probe with exact message/run/recipient, completion times, cleared claims and zero effects.
   A done/no-op flag alone, malformed/foreign baton, retry/error/result awaiting finalization,
   mismatched probe, active projection or unknown obligation refuses. Legacy daemon/prose-derived batons do not discharge obligations (#950). Retained same-owner claim
   timestamps from normal no-reply closure are history; PREPARE never clears or rewrites them.
   Lock contention refuses. This follows the original frozen gen5 incomplete-work criterion;
   the former summary/SQL incorrectly treated every historical done row as incomplete.
4. Install fixed-template recipient/policy-pinned triggers and PREPARED in the same transaction.
5. COMMIT is first-deny. Pinned trigger arguments do not depend on snapshot-visible policy
   existence: missing/invisible/expired/HALTED/CLOSED policy denies, never legacy fallback.

Earlier committed claims cause refusal; uncommitted writers cause NOWAIT refusal. Earlier
SELECT FOR UPDATE, prepared SQL and old RR/Serializable snapshots cannot authorize a later
unguarded UPDATE. Precommit abort leaves no partial installation; postcommit restart and code
rollback retain deny. The temporary whole-three-table write exclusion is an explicit future
application impact. Historical rows are not retroactively enrolled, retagged or reset.

## Normal send, execution and reply

Normal notify creates and returns the ID; only then may trusted ENROLL bind the exact saved
sender/channel/content/recipient to the predefined slot. No preallocation/manual INSERT.
Normal send COMMIT classifies projections through message -> QA recipient queue or reply_to
-> original QA queue, including authoritative mentions/active_owner checks for missing fanout.
Sender and resolved outbound consumer are not ownership. Deferred constraint enforcement
handles insertion order and rejects missing/conflicting fanout or ambiguous correlation.

A guard-owned AUN_BOUNDED_ADMISSION record is appended to existing delivery_diagnostics
**array**, pinning policy/config/kind/original message/queue and HOLD_ENROLL or HOLD_REPLY_COMMIT.
Existing outbound attempts=0 and max_attempts=1 (original) or 3 (reply) reserve the
durable budget before enrollment. A reply remains one logical message/projection.
A partial unique index prevents duplicate protected projections. Lost notify stdout leaves
the visible projection held; no resend, inferred enrollment or successful-delivery claim.

ENABLE requires exact source/cohort/config/authority. CLAIM and BEGIN_INVOCATION lock policy
then slot/queue, stamp the existing exact claim and reserve invocation_attempts=1 before spawn.
Only validated queue_work_result_v1 ok:true can move INVOKING -> RESULT_SAVED/done. Failure,
timeout, malformed result or crash halts; an uncertain attempt remains consumed.
BEGIN_FINALIZE reserves finalizer_attempts=1 before host send. The existing trusted host's
normal send --queue-work-finalizer --close atomically stores reply, fanout, projection and
done -> replied plus exact slot/reply binding. The read-only child needs no DB/write tool.

Provider acquisition uses the same policy/task/outbound lock order and operation binding,
pending -> claimed/attempts0 -> 1 before any provider call. Originals need ENROLLED+ENABLED;
replies need committed REPLIED. Task/finalizer/original reservations cannot be reset.
Only a durably classified retryable reply outcome can reserve a later physical attempt
under the explicit protocol below; ambiguous crash/orphan is not retry permission.
Runner/finalizer/TTL/self-reclaim/requeue bulk queries exclude protected partitions; unbound
default retries remain unchanged. Denying an old mixed-partition transaction may abort it;
upgrade or exclude every such writer before live use rather than claiming no collateral effect.

ACCEPT requires independently verified task predicates, exact source/result/reply and a
nonmaker checker at the trusted control boundary and the exact reply's SENT receipt.
ok:true/done/replied/ACK is not acceptance.
Only after ACCEPT(1) may normal task2 be sent and enrolled. Its accepted finding is data;
policy/source/cohort/tool/plist/env/cutoff/role digests stay unchanged. ACCEPT(2) closes this
bounded run, not the team. Expiry denies new effects without killing running work; evidence-only
completion remains possible. At-most-one attempt is not exactly-once external completion.

## Bounded physical reply transport

The immutable policy additionally pins original_max_posts=1, reply_max_posts=3,
waits_ms=[10000,30000], post_timeout_ms=10000, transport_horizon_ms=120000,
persistence_max_writes=5, persistence_window_ms=20000 and one same-host receipt_dir/cohort.
The 120s horizon and 5-write/20s persistence limits are implementation choices, not owner
numerical claims or a provider deduplication guarantee. Both task slots use identical config.

The guard-owned diagnostic freezes delivery_id=out-ID, exact request/digest, destination,
explicit reference, content, allowed_mentions and nonce before reservation. No attachments,
oversize truncation, guessed latest reference, alternate channel or reply-to-send fallback.
The opt-in Discord REST instance uses retries=0, rejectOnRateLimit=true, timeout=10s and
disabled sweep timers. A one-use capability checks the exact POST route/digest/deadline
inside makeRequest, counts actual wire invocations and refuses a second invocation before I/O.
The ordinary SDK client and strict EventLog method are unchanged.

All bounded consumers use canonical same-UID directory0700, regular nonsymlink files0600,
16KiB maximum receipts without body/credentials. Exclusive O_EXCL/O_NOFOLLOW per-delivery
locks bind random token, host/cohort, PID and process-start identity. Hold through provider
and persistence. Never steal by age, lost DB connection or the consumer60s tick reset.
Recovery requires positive same-host prior-owner termination; PID reuse/unknown is blocked.
Atomic receipt writes fsync file, rename and fsync parent. No automatic receipt GC.

Explicit ended-owner recovery serializes only its fresh lock read/compare/unlink
using Bun's built-in SQLite `BEGIN EXCLUSIVE`, busy_timeout=0, on the persistent
`out-ID.reap.sqlite` in that same directory. This is a host-local mutex, not a
SQLite queue backend. Atomically create the regular same-UID0600/nlink1 main with
O_EXCL/O_NOFOLLOW, fsync file/parent and close its creation fd before SQLite opens;
never truncate, replace or remove it. Require stable directory/main inode, main
size <=16KiB, readwrite+NOFOLLOW (no create/URI/custom VFS), DELETE journal mode,
4096-byte pages, at most one page and no user schema. Local filesystem OS locking
is required; unknown/network filesystems are not an admitted deployment.

SQLite can initialize page1 and create its own `-journal` even without application
SQL writes. The exact main-path `-journal` alone may be absent or an engine-owned
empty/partial/cold/hot regular same-UID0600/nlink1 file on the same device, <=128KiB.
Allow SQLite's normal open/playback/finalization to recover it; application code
never deletes, resets or parses journal contents. WAL/SHM/superjournal/extra
companions, unsafe metadata, corrupt main or unsupported NOFOLLOW refuse recovery.
The own-UID0700 directory is the trust boundary, not protection from a malicious
same-UID process. Busy returns ADMISSION_RECOVERY_BUSY with no owner/receipt write;
other engine/path errors return ADMISSION_RECOVERY_MUTEX_INVALID and retain evidence.
No await or SQLite operation occurs between the fresh owner read and unlink.
Finally ROLLBACK and close release the OS lock, even on error; engine rollback may
delete a journal or truncate its empty main, but cannot undo the owner-file unlink.
A legitimate journal from another contender after close is not corruption.

Release this mutex before acquiring the existing O_EXCL delivery-owner lock.
Re-read and revalidate the exact approved receipt SHA, source/config/request/owner,
durable outcome and unused recovery token while holding the new owner lock,
before modifying any receipt or DB state. A stale contender cannot overwrite a
completed recovery's receipt, and cannot unlink a replacement owner. Crash after
mutex acquisition or old-lock unlink leaves only an engine-recoverable main/journal;
positive process-end evidence plus a fresh exact approved DB-only recovery is still
required. Crash after mutex close/before new O_EXCL leaves no permanent guard.
Post-new-owner mismatches retain existing fail-closed handling; DB loss, lock age
or busy is never owner-end evidence. These persistent main/journal effects and all
legacy writers must be explicitly admitted in a future nonlive application proposal.
BA-CORE-F06/DR08 includes deterministic two-process stale-reader and crash cuts,
actual empty-main journal/reopen evidence and invalid-file controls on Darwin/Ubuntu.

Under that lock, SQL locks policy→task→outbound, checks guard/config/roles/expiry/due/budget,
commits reservation and fsyncs INTENT before POST. Failed durability consumes the reservation
and forbids POST. Recheck authoritative state immediately before the provider seam; DB
unavailable pauses. Counters distinguish reserved attempts from observed physical calls.

HOLD→READY→RESERVED/IN_FLIGHT→RETRY_WAIT|ACK_PENDING_DB|NEEDS_ATTENTION→SENT are delivery
substates, not task states. Timeout/network/response loss/5xx/429 must fsync RETRYABLE before
another POST. Reply waits are at least failure+10s/30s and the maximum of header Retry-After
and JSON retry_after (fractional seconds round upward). Invalid429 waits stop. Global429
persists a bot not-before checked by every bounded sender. Clock rollback cannot shorten
deadlines. A full10s request must fit before first_attempt+120s and policy expiry; long waits
stop instead of sending early. Permanent4xx/malformed or wrong-destination ACK stop.

Valid ACK sets an immediate no-POST latch and fsyncs actual message/channel/author/nonce/
request/response hashes before DB writes. Stage1 stores outbound SENT; stage2 backfills the
logical message external ID. Both stages are idempotent/monotone; stage2 never resets stage1.
Journal cumulative writes before each attempt, at0/1/3/7/15s, maximum5 total/20s with1s
statement/lock timeout. Connectivity failure pauses; an existing tick may resume only the
same unexpired budget. No restart reset or new timer. Exhaustion is needs-attention.

Restart with ACK or matching DB SENT is DB-only. Durable RETRYABLE can resume only after
positive owner closure and fresh checks. INTENT without outcome, missing/corrupt receipt,
wrong incarnation or storage ambiguity never automatically POSTs. Simultaneous DB/disk
loss may leave UNKNOWN; retain the process no-POST latch, never promise receipt survival.
An actual known message ID may be verified through existing GET; no fuzzy history search.

`admission persist-receipt --policy-id ID --delivery-id out-ID --expected-digest SHA
--expected-revision N --receipt FILE --recovery-ref FILE --dry-run|--execute` is an explicit
DB-only5-write/20s episode, not send/reclaim/invoke/finalize authority. The fixed recovery
record requires policy_id,delivery_id,receipt_sha256,request_digest,source_head,recovery_token,
max_writes=5,window_ms=20000,authority_url,authority_sha256,prior_owner_end_evidence; unknown,
missing/type-invalid fields, token replay and expired/wrong-subject authority are rejected.
`admission status --policy FILE --delivery-id out-ID` may show the local receipt offline,
explicitly DB_STATE_UNKNOWN/effect_count0; local config is not write authority.

Cap/permanent/ambiguous/exhausted delivery records needs-attention and HALTs the policy.
One idempotent policy-locked system_error row goes to codex-cto with message_id=NULL,
author_id=system and existing TEXT payload. Store notice_queue_id and update referenced
deliveries, never enqueue agent_messages/outbound or another task/LLM/Discord alert.
DB outage retains local notice intent; bounded DB-only recovery reconciles that same row.
One durable notice is not proof of receipt/consumption. Old-code rollback keeps guards,
budgets/journal and HALT; incompatible consumers are deny-only, never reset to unbound.

DR01–12 in BA-CORE-F06 measure actual locked-SDK wire calls, stable request,10s/30s/rate limits,
cap/permanent failures, each DB persistence stage, reservation/INTENT/ACK crash boundaries,
two-owner exclusion, clock/global limits, receipt/storage corruption, one notice and ordinary
unbound regression. Use deterministic fake wire/clock and actual isolated PG barriers only.
Task/result/logical reply uniqueness remains; physical reply duplicates may occur within cap.

The isolated test database cleanup uses a DROP-only SQL deadline of 5 seconds and
an outer process deadline of 6 seconds, so the SQL error can return before an outer
kill. CREATE DATABASE retains its 2-second SQL/process limits; connect and lock
limits remain unchanged. This cleanup grace does not change PREPARE's 1 second,
the 30-second test/F06 cap, or any product invocation/wire/persistence budget.
Controlled owned-fixture probes distinguish a DROP that finishes after 2 seconds
but before 5 seconds from one that exceeds the SQL limit. The original C4 DROP
wait cause remains unknown unless separately measured; its full-suite FAIL stands.
F06 always settles all four overlapping A09 fixtures before returning on success
or exception. Main-path and A09 failures are retained individually or aggregated;
an early rejection must not leave the other fixture promises running after return.

## Commands, rollback and evidence

`aun admission prepare --policy FILE --dry-run|--execute`; `enroll --policy-id ID --ordinal 1|2
--message-id GENUINE --control-ref FILE --execute`; `status --policy-id ID --json`;
`enable --policy-id ID --expected-digest SHA --execute`; `accept --policy-id ID --ordinal N
--evidence FILE --execute`; `halt --policy-id ID --reason CODE --execute`.
Writes require exact published authority, trusted principal and expected revision/digest;
status is read-only. No force, reset, generic SQL editor or automatic owner decision.

The five `AUN_ADMISSION_{POLICY_ID,CONFIG_DIGEST,SOURCE_SHA,COHORT_DIGEST,RUNTIME_ID}`
values are immutable deployment inputs. Activation planning uses runtime enrollment
only for read-only row selection; it does not put queue/message IDs into the plist.
The canary overlay subject is this exact configuration digest in bounded mode;
the existing non-bounded Issue #917 subject gate is unchanged. All other canary
authority, expiry and rollback metadata remains required. Restore dry-run and
execution read back the guard and refuse affected enrolled work; old-source
rollback requires HALTED/CLOSED and both execution schedulers disabled.

The same validated `agentAllowlist` also bounds the daemon's startup memory
identity reconciliation. Only eligible seats in that list may reach the
per-seat resolver, identity audit, or refresh path. Null or omitted retains
the normal eligible fleet; an explicit empty list selects none at the helper
boundary. Existing canary admission validation and single-seat heartbeat
reconciliation are unchanged. This scope restriction is not a memory-ready
bypass and does not authorize startup or application.

GitHub-backed tasks retain mediated host posting. The host persists its writeback
receipt before its one normal reply attempt. D1-shaped effects cannot use the
bounded normal-reply short path: their separate invocation/effect completion
protocol remains mandatory, and is not authorized by these two task definitions.
Default D1 handling outside this policy is unchanged.

Code rollback retains guards/HALTED ledger; down migration refuses enrolled policies.
All actual DDL, roles/grants, execution-capable MCP/CLI/headless/outbound/reclaimer upgrades,
loaded versions/tools, sends, expiry and failure-only rollback need a later exact admission.
Failure-only rollback does not authorize intentional live fault rehearsal.

Mandatory proof preserves all 21 test IDs: CI public19 plus private F08/F10=2, and local
public15 plus private2=17. No required skip/zero-selected/unsupported substitution. PG16 keeps
the unfiltered suite and compatibility/default cases; PG17 measures actual two-connection
first-deny and commit-before-ID-return races. Private source stays out of this public repo/CI.
Independent raw-file/API readback joins clean candidate/base/tree/diff/test bytes and the
verified equal-tree merge checkout; procedural counters alone do not prove execution.
Frozen USE01–09 still require real applied version, tools, normal two-task use, nonmaker
acceptance, returned result, safe rollback mapping and same-configuration continuation.

Current source-only integration uses [I2](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5656920748)
(raw SHA256 `9eff608923ce62135e63192890dd101c24148e4078b689d3720229bc94f5c676`).
The [history classification correction](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5657070473)
(raw SHA256 `0cc4b37bd46297d8febb7d4eb6bf7967c30dc54f9566d1bf6d78e21a8736b5eb`)
keeps 18 legacy daemon batons plus 9 other unknown QA obligations blocked; the 2 explicit
lifecycle closures and 2 successful N1 records are supported candidates only. No live
history is modified, and this source change does not authorize application.


### Codex worker の明示 permissions 選択（既存隔離要件への適合）

既存 caller は従来の `--sandbox read-only`（または明示 legacy sandbox）を維持する。operator が `AUN_QUEUE_WORK_CODEX_PERMISSIONS_PROFILE`（fallback `STATE_DAEMON_QUEUE_WORK_CODEX_PERMISSIONS_PROFILE`）と既存 `*_CODEX_PROFILE` を明示した場合だけ、`--sandbox` と排他的に native `-c default_permissions="<name>"` と `--profile` を渡す。両 selector は ASCII 英数字で始まる 1–64 文字の英数字・`_`・`-`。空値・片方欠落・AUN/STATE の相反値・同時 sandbox 指定は child 起動および既存 launcher preflight の前で拒否する。queue payload は selector 権限を持たない。既存 `*_CODEX_EXECUTABLE` で実行ファイルを固定し、activation plan/restore が同じ executable/profile/permissions を渡す。

名称・argv テストは隔離証明ではない。native loader が解釈した実 profile bytes、全 config layers、argv、実 binary hash/version、model-accessible tool inventory、QA identity、role、read-only/no-network/dummy-secret-deny の観測を trusted application admission に束縛する。task1 ENABLE 前、および ACCEPT1 後 task2 ENROLL 前に同一 config/cohort を再確認し、不一致なら依存 effect を停止する。現実装に per-invocation profile-byte verifier が存在するとは主張しない。`supportsToolAllowlist:false`、claim/attempt charging、timeout、result/finalizer、host credential containment を維持する。Codex shell sandbox は MCP host の独立した権限・telemetry 境界の代わりにはならない。

### Exact CI subject collection (I6)

The existing CI subject collector reads the complete binary diff with a finite
16 MiB stdout limit and 15-second child deadline, including its other git
readbacks. Exceeding either bound or any git failure aborts collection; it never
hashes truncated output or emits a partial subject. Base, candidate/tested
head/tree/parents, test hashes and frozen design identities retain their existing
meaning. Actual workflow extraction is tested against a repository diff larger
than the former 1 MiB default, with a separate file-backed byte hash.

[I6](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5658354436)
(raw SHA256 `a018146fd84f020908bfcf1eddfd8609232e3fbdb5d339c854af42b132dc1916`)
binds the current C5 parent, existing donors, 124-path integration and four
CI/docs/overlay repair paths. The current-I-missing rejection retains I5 history.
Its one C6/full7/private2 allowance includes one additional isolated two-caller
specimen (21 cumulative; the former 20 remain consumed). This corrects CI setup
ENOBUFS before product tests; runtime/migration/selector behavior and all stage
thresholds are unchanged. No public event or actual application authority is
inferred from this local source handoff.


### Current source-supply window and local execution budget (I8)

[I8](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5658698015)
(raw SHA256 `596b59439ef15f1aca467f64a7c557723e6f6ff71aa9327c89b6eb1921c7e2ff`)
binds current local C7, public C5 and the same 126-path integration. Current
CI supply and independent consumer validity end at 2026-09-14 18:00 JST
(09:00 UTC). This is distinct from the finite 35-active-minute implementation
budget and its 13:10 JST local completion target; the local target is not a
CI expiry. Expiry checks remain mandatory. The current-I-missing rejection
retains I7 and earlier published history.

This three-path docs/overlay/test correction preserves every runtime, canary,
SQL and selector byte from C7. C7 full8/local15 passed; its private F08/F10
attempt failed before use-case execution because the owned cases parent was
missing. The raw failure is retained. I8 completes the owned fixture inputs
before one C8/full9/private2 measurement, with one isolated two-caller specimen23
(original20 plus21 and22 remain consumed). Source supply creates no public
event, merge, live application or provider authority.


### Canonical current binary patch identity (I9)

Current `binary_diff_sha256` hashes the complete bytes of
`git diff --binary --full-index <base>...<candidate_head>`. Explicit full-index
uses all40 hexadecimal characters in patch index object IDs. CI subject
collection, current consumer, private subject validation and current evidence
preparation use the same command. Existing16MiB/15-second collection limits and
failure propagation remain. Current abbreviated digests are not an alternative
accepted representation.

[I9](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5658996537)
(raw SHA256 `33e3c0ae8d6dd045fd1bf1dddc319dc880bb1505507967674fe7ac02011f0c7c`)
binds public/localC8 and five existing evidence-supply paths in the same126 union.
C8 CI34805584291 tested the exact candidate tree, but its7-character index
prefixes differed from local8-character prefixes. Both original abbreviated
hashes and the failed CI remain historical observations; they are not rewritten
as canonical acceptance. Same-object abbreviation7/8 checks must produce one
full-index digest while rejecting abbreviated consumer input.

The finite C9/full10/private2 correction allocates only local two-caller
specimen24; original20/21/22/23 remain consumed. Current source expiry remains
18JST, separate from40 active minutes and14:05 local target. Product runtime,
quality thresholds, source separation and protected application are unchanged.


### Current fixture execution correction (I10)

[I10](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5659450041)
(raw SHA256 `95df0abfbf75caeab73fb8ea70f64e22bb3b73a7f07feee71b0694db07661aab`)
binds public/localC9 and seven existing fixture/evidence-supply paths in the126
union. The BA16 diagnostic row uses the production `claimed_at::text` projection,
retaining exact microsecond fence comparison rather than converting the claim
incarnation to a JavaScript Date. LocalPG17 is not PG16 acceptance.

F06 retains its single required identity, every DR01–12/A09 assertion and the
30000ms total cap. Independent complete main fixtures use at most two workers
with their own UUID database, roles and receipt directory; existing four A09
fixtures may overlap (peak six). All launched work settles and every failure
is propagated. The parent-process DR10 receipt-write fault is exclusive after
both groups settle, including their failure, so its prototype injection cannot
affect another fixture. Atomic fixture/child/crash/race ordering is unchanged.

C9 CI34808107443 remains3153PASS/59SKIP/4FAIL: BA16 projection, aggregate F06
timeout, and two genuine performance failures whose cause is still unknown.
Eventlog100ms/10ms thresholds, full populations and SQLite product behavior
remain unchanged. C10/full11/private2 allocates only local two-caller specimen25;
prior24 remain consumed. Expiry18JST is distinct from45 active minutes and
15:10 local target. Current full/publicCI measurements do not waive prior FAIL.

The I10 focused specimen exposed a synchronous5-second `dropdb` wait that
blocked the parent event loop while another fixture connected. Fixture drop
therefore uses the same child command asynchronously and awaits completion;
its6-second child,5-second SQL and1-second lock limits are unchanged. No force
drop, retry, server wait-cause claim or cleanup failure waiver is introduced.
The original focused failure remains evidence; the unconsumed full11 is the
first current-source test after this one fixture correction.


### I11: synchronize the retry fixture with its persisted deadline

Published I11: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5659615988, raw body SHA-256 `ad63e6b996844fed6ef090004a92e9d11427e69ddd7a83b85ac763dc81096940`. C10's fixed clock padding remained 36/36/33 ms earlier than the actual persisted retry deadline. The existing product correctly returned RETRY_WAIT. After the unchanged early-denial checks and owned SQL adjustment, DR02–04 must read that row's RETRYABLE receipt, require a finite numeric next_not_before, and advance wall and monotonic clocks by the same delta to max(current wall + original required wait, persisted deadline). No arbitrary padding or product clock change is permitted. All original wire counts, minimum waits, cases, 30 s F06 cap, main concurrency 2 plus four A09 fixtures, exclusive DR10 settlement, and 100/10 ms performance gates remain.

Current I11 authentication retains all prior published bodies and rejects absent I11 even when I10 remains. One candidate C11, full12 with local specimen26, and same-head private2 are admitted; focused runs are zero. Actual PG16 CI and protected application remain separate. Earlier C9 CI performance failures and C10 failures remain evidence; a later local PASS does not explain their cause.


### I12: reuse the existing six fixture slots

Published I12: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5660175924, raw SHA-256 `79141cc6e279133e97107d071568825a28c44ac4e6008609f41756d0f71d29b7`. Actual C11 CI F06 exceeded30s: main32 settled in36.959s and exclusive completion in41.088s; one main failure's reason was not emitted. No product cause is inferred. Register four lazy A09 callbacks before all32 independent main callbacks in one bounded pool of six. Initially four A09 and two main fixtures run; each released slot admits the next main unit. All36 outcomes settle, including early and late failures, before the exclusive DR10 parent-prototype fault. A09 child/barrier semantics and original callbacks/assertions are unchanged. Keep the default two-worker helper behavior for its existing callers. Record sanitized per-unit errors without discarding them.

Every fixture keeps its isolated DB/roles/files. The shared scheduler changes only start order and slot reuse; it adds no fixture quota, no global state or product hook. Preserve the I11 five deadline synchronizations, original125 expect sites, one F06 test with30s total, existing child/SQL/lock/cleanup bounds, and100/10ms performance gates. One focused F06/pool/settlement/overlay run excludes two-callers. Then candidate12, fresh owned full13/local15 with specimen27, and same-head private2; publicCI19 requires separate publication. All actual older authority bodies and failed evidence remain immutable.


### I13 test fixture lifecycle correction (2026-09-14)

The current bounded authority is [I13](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5660385028), raw body SHA-256 `1db8a44146d83044628332843abb9a12ca29e50511eb547b451dc0164cd888bc`. I12's focused failure remains preserved; its cause is not established. Within test fixtures only, run each existing migration with the same argv, environment and count through awaited asynchronous spawn, draining both streams immediately and retaining child/stream failures. Migration start/end records distinguish that stage from connect, body and cleanup.

DR07 starts both output drains immediately and separately records actual child exit and each EOF. A separate test diagnostic file records write-entry, write-return and exit-request around the existing real receipt write and natural process.exit(23); it does not change receipt data, crash points or recovery evidence. All child and stream work settles before the existing exit assertion. The shared lazy pool remains at most six across all four A09 and 32 main fixtures; exclusive DR10 follows complete settlement. All original 125 F06 expectations, its 30-second total limit, SQL/connect/cleanup limits, clock predicates and product bytes remain unchanged. I13 permits one changed-input focused run, then candidate12/full13/local15/private2 only on success; prior evidence and all 17 earlier authority bodies remain intact.


### I16 fixture createdb lifecycle correction (2026-09-14)

The existing createdb helper now awaits asynchronous execFile before any caller connects. It keeps the same command, arguments, environment, 2000ms child timeout, SIGTERM, 2000ms SQL and1000ms lock timeout, UTF-8 collection, and existing1MiB default output bound. Both callers await its returned target. Already asynchronous dropdb is unchanged. The actual child callback result and collected streams determine success; failure remains propagated.

I15's valid zombie observations and pinned Bun af24e281 loop-switch source justify this bounded changed-input test, not a proven causal repair. Product currentBoundedOwner/releaseEndedOwner synchronous ps and normalCli remain real and unchanged. Original125 F06 expectations,30s/max6/all36+exclusive, I11 clock5 and actual migration/DR07 exit/EOF gates remain. One unsampled focused run precedes any candidate12/full13/private2. Historical failed and sampled evidence remains distinct. Current I16 authority provenance is bound by the exact published source in the consumer and its authenticated fixture.

Current complete I16: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5660841348, raw SHA256 `3eaa494a449cecf24bf74660d62c084ffc8b9ce030e2627fc60b7570c92e1873`. The original I16 publication remains unchanged historical evidence; this restores existing seven-path and selector input metadata without another test attempt.


### I17 complete-fixture process isolation (2026-09-14)

Current I17: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5660965716, raw SHA256 `233683e612ad2dff89a9b597e690509cef0ed225a4ac5a927b3eeb661fa3ae1e`. I16's actual failure remains open; isolated complete-case workers test a changed fixture topology, not a proved Bun or product repair. The parent keeps one BA-CORE-F06 and one 30000ms wall deadline covering worker startup, all four A09 plus32 main cases, all nested processes and cleanup, and the final exclusive DR10 case. One lazy pool has six slots globally; all36 outcomes settle before DR10, even after failures.

Each same-version Bun worker reconstructs the original callbacks from the exact current source and selects exactly one case. No callback serialization or cross-case database sharing is introduced. Each case retains its original assertions, internal A09 barriers and competing processes, DR08 held POST/disconnect race, DR07 real exit23 and both EOF requirements. The original125 F06 expectation sites and five persisted-deadline clock synchronizations remain. Parent-only DR09 boundary checks and DR12 ordinary SDK positive control run exactly once per aggregate. Shared-parent cross-case scheduling and the parent prototype context are deliberately no longer covered; DR10's original prototype fault remains inside its complete case, after all36 parallel workers settle. Product synchronous ps and mutex no-await behavior are unchanged.

Workers receive one finite recursion depth, exact case and current source digests, and the remaining parent deadline. Parent aggregation requires exactly one selected, non-skipped BA-CORE-F06 test in actual Bun JUnit with positive assertions, original callback/source identity, a post-callback-and-cleanup marker, real exit0 and both EOFs. Zero tests, wrong case/source, rejected streams, signals, nonzero exit and missing completion fail closed. Case registration and immutable original-source mapping join those actual results; an exit code or maker marker alone cannot pass. This retains the single parent test,30s total,global6 and all original predicates; no independent per-child timeout reset or assertion waiver is allowed.


### I18 current-day source-supply freshness (2026-09-15)

Current I18: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5671021604, raw SHA256 `d1cec773be207bb2c606ad2aa8cfeb78dc4ca4df481241b9c60ca3e7d1d165bb`. The earlier I8–I17 source-supply deadline expired on September 14 at 18:00 JST; it is retained as historical fact. C12 public CI passed with its consumer checked before that expiry. Today's bounded source correction admits only the overlay checker, its metadata tests and this explanatory document, from exact C12 `b79c2bda176bdbf45d26deb35743eca4aff4f3c9` / tree `89d0175872dd927910a4d6d6a217a17f84503763`.

Current CI supply and its independent consumer expire at 2026-09-15 18:00 JST (09:00 UTC). This is distinct from the 40-active-minute local bound and 07:10 JST completion target, and does not authorize any POC operational window, Ready, merge or live effect. Preserve actual Date.now() rejection at/after expiry, authenticated raw owner/handoff bodies, current-head checker provenance, full-index diff/tree/ancestry checks, and the original 126-path integration/seven-path repair history. The actual C12-to-successor delta is restricted to these three paths. A current-I18-missing rejection retains every earlier authority body including I17.

One metadata-focused run precedes one candidate13/full14/local15/private2 attempt. The only additional two-caller specimen is28, consumed within full14; prior27 and all failed diagnostic history remain consumed. There is no standalone F06 retry. All product/runtime and F06 fixture bytes, original intra-case assertions, 36+exclusive/37 workers, global six slots, one 30-second deadline and all quality/performance thresholds remain unchanged. Publication/current API consumer/publicCI19 require a separate bounded handoff.


### I19 measured fixture correction and current source supply (2026-09-15)

Current I19: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5672436570, raw SHA256 `5f18f25048f06b5ec533238f2d122a23196651d92c28123b76019c4a6c44c668`. It binds the C13 baseline `5cf098afae1b5a3aac3148179da24f92f8a98610` / tree `2d13a5beab7c152683bc6f39dbc21e6fae8ad5ad` to the three performance fixture corrections and three necessary source-supply metadata paths. The previous126 union gains only `tests/eventlog/eventlog-bot-to-bot-roundtrip.test.ts` (127 total); repair8 preserves the previous7 plus that test. Actual C13 delta is restricted to those six paths. Maker is `codex-cto/application_review`; earlier maker history remains and `goal_gap` is independent.

Actual C13 public failures34907372312 (F06 30s,35 spawned/29 accepted) and34907372555 (50-round p95 122.008106ms) remain FAIL. Same-source success34907372870 does not erase them or identify an environment cause. Fixture diagnostics retain the entire37-case/global6/36-then-exclusive/one30s clock, original intra-case assertions, N50 and the original p95 index/<100ms, and all delivery/total/burst checks. All measurements include added bookkeeping; parallel phase sums are not elapsed wall time. Fixture client query counts exclude the endpoint probe and migration-child SQL; their wall phases are still timed. SQLite transaction timings include nested SQL and must not be summed with SQL totals. No durability setting is changed. The measured three-role ACL equivalence supports batching only the same transport rights; per-case databases, all migrations, memberships, sequence/private-ledger restrictions and cleanup remain. Failure cleanup repair is not an explanation of the earlier p95 failure.

I19 retains actual wall-clock rejection and all raw owner/handoff, checker, exact-head/tree/full-index/ancestry and ambiguity checks. Missing I19 retains I1–I18 and fails closed. Source and consumer expire September15 18:00 JST, while this work expires10:50:22 JST and retains its original60-active-minute budget. Candidate limit15/full limit16 include at most2 new changed candidates/full runs; earlier C13/full14 history remains. Local specimen28 plus the completed performance-focused run is29 consumed; one remaining performance focus plus at most2 full runs cap it at32. Metadata-focused adds no F06. No new private2 run is allocated; unchanged private runtime guards and their prior proof require exact-source and independent delta joins. Current candidate metadata-focused runs against the committed HEAD.

These are temporary exact delivery bindings, not a new general product API. Public source/consumer/CI19, new-head protected application and actual useful QA work remain separately required. The existing C13 owner approval does not authorize installation of a changed head; no operational completion is claimed.


### I20 current source-supply freshness (2026-09-16)

Current I20: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5688909231, raw SHA256 `3b0d39b5c7a96201220154adc5a16b4f24b86e8831348b8bbf41aeacf001bbaa`. The I19 source/consumer deadline expired September15 at18:00 JST. Its historical source, tests, actual failures and accepted evidence remain unchanged. I20 admits only this document, `scripts/shirube-current-overlay-check.mjs` and `tests/shirube-current-overlay-check.test.ts`, from exact C15 `2730cb38e87eee4ca31cc15d496ef49effc25a2d` / tree `f837e3409a3a7fae6f4d96b803b56e140e9855d7` / full-index diff `3cec5a45bd416c949e396657063bc9458a44b3b94f2345568a933a029e0764b0`. The127 integration paths and repair8 remain fixed; other1100 tracked entries and all product, performance and private fixture bytes remain equal to C15.

Current source supply and its independent consumer expire September17 at18:00 JST (09:00 UTC). The distinct implementation window is40 active minutes, with September16 09:00 JST expiry and08:00 JST target. Actual Date.now(), strict before-expiry comparison, raw authenticated owner/handoff bodies, exact-head/tree/full-index/ancestry checks, current checker identity and malformed/duplicate-current-consumer rejection remain mandatory. The current-I20-missing negative retains every original23 API-shaped authority fixture, including I19. This is the existing finite source-supply mechanism; it provides no operational window, Ready, merge or live authority.

One new candidate C16 and one metadata command precede one fresh owned PostgreSQL17 full18 measurement, adding local F06 specimen33 to the original32. Preserve all original37 cases, global6,36-then-exclusive1, one30-second parent deadline, original assertions and the50-round p95 index/<100ms and durability constraints. Reusing the full16 fixture is forbidden: verify the new owned database has event_log0 after all migrations before the full run. All earlier full failures and budgets remain consumed. There is no standalone performance focus or correction round.

Run one additional original private stage on exact C16: exactly F08/F10,2 tests and675 assertions, with fresh owned inputs and unchanged private pins. C15 private PASS remains historical evidence: blob equality alone cannot replace privateSubject and JOIN_CHECKER equality of current candidate HEAD/tree/full-index/test/design identity across private, local and eventual publicCI. Capture original cleanup, restore/adapter cases and current source evidence. Maker remains `codex-cto/application_review`; `goal_gap` remains independent with all earlier maker history preserved. Public source/consumer/CI19 and protected new-head operation require their separate handoffs.
