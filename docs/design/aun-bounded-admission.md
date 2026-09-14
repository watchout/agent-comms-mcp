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
