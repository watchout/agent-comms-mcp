# AUN one-command bootstrap

> Mutable operational configuration is DB-owned. Bootstrap is the first fenced
> reconciliation, not a permanent snapshot authority. After B8, the
> state-daemon continuous reconciler owns later desired revisions. See
> [AUN configuration reconciliation](./aun-configuration-reconciliation.md).

`aun bootstrap` turns an already-started Codex or Claude runtime into a
provider-registered, ordinary-receive-capable AUN seat. It is deterministic,
idempotent, rollback-capable, and fail-closed. It does not enable Shirube D1, release
the D1 kill switch, add a protected target, or perform an external-effect
smoke.

## Commands

Plan without changing provider configuration, the database, an agent profile,
or launchd:

```bash
aun bootstrap --agent-id <id> --runtime auto --dry-run --json
```

Apply the plan:

```bash
aun bootstrap --agent-id <id> --runtime auto --json
```

If auto-detection is impossible, explicitly choose the runtime. An explicit
choice still fails if live process identity contradicts it:

```bash
aun bootstrap --agent-id <id> --runtime codex --json
aun bootstrap --agent-id <id> --runtime claude --json
```

Failed runs are terminal and must never be resumed. After resolving the
reported predicate and verifying rollback, start one new run. `--resume` is
retained only for a non-terminal journal interrupted before a terminal result.
`NO_GO_BOOTSTRAP_BUSY` is the exception to the new-run instruction: it reports
the exact `blocking_run_id`, and its `next_action` points to
`--resume <blocking_run_id>` so an interrupted same-run lock generation has a
reachable recovery transition.
Rollback targets only mutations owned by the exact run:

```bash
aun bootstrap --agent-id <id> --runtime <resolved> --rollback <run_id> --json
aun bootstrap --agent-id <id> --runtime <resolved> --json
```

Inspect the latest bootstrap status without printing journal contents:

```bash
aun status
```

## B0–B8 lifecycle

| Stage | Required proof |
| --- | --- |
| B0 lock and snapshot | One per-agent lock, exact repository head, redacted pre-state journal |
| B1 dependency preflight | Read-only Bun, Node, Git, tmux, launchd, selected provider executable/version/config scope, parsed/canonical provider-native Wasurezu JSON, and unambiguous live provider identity checks; an absent SQLite database is not created |
| B2 database migration | Successful migration, successful identical rerun, and a digest of the resulting SQLite artifact family or PostgreSQL schema |
| B3 agent profile | Exact agent/runtime/workspace/tmux/port tuple; locked desired-state/outbox preimage; any exact new event held at `available_at='infinity'`; durable private rollback artifact |
| B4 MCP registration | `codex mcp add` or `claude mcp add`, followed by exact provider-native get/list tuple readback; the one recognized disabled legacy Codex tuple is upgraded through fenced backup/remove/add/readback |
| B5 memory readiness | Exact live runtime receipt plus a real MCP `initialize` → `tools/list` → Wasurezu `recover_context` call |
| B6 ordinary daemon | Durable checkout, exact plist bytes/mode plus independent launchctl domain/label/load/PID state, one ordinary receiver, matching runtime identity, safe D1 values |
| B7 queue smoke | Bootstrap enqueues/observes only; a separate OS process runs canonical `receive` → `processing` → `record-no-reply`, with one terminal result, one winner under same-row contention, and zero external effect |
| B8 READY readback | Identity, MCP, memory, process, endpoint, queue progression, and safe-D1 evidence agree |

The command emits `READY` only after B8. `IDEMPOTENT_READY` means an identical
prior run was found and a fresh B8 readback passed without a new profile, MCP
registration, daemon, migration, port lease, or smoke row. Any missing or
stale proof returns an exact `NO_GO_*` code and a new-run instruction after
verified rollback. A
failed idempotent readback never falls through to B2–B7 and therefore cannot
repeat setup mutations.

## Safe defaults

Every daemon plan created by bootstrap contains these exact values:

```text
SHIRUBE_D1_ENABLED=0
SHIRUBE_D1_KILL_SWITCH=1
SHIRUBE_D1_TARGET_ALLOWLIST=[]
STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED=0
```

Changing any of them requires a separate protected owner gate. Bootstrap
never treats a live process, an open port, or a placed config file as READY by
itself.

## Runtime selection

`--runtime auto` accepts either:

1. one exact agent-profile provider that agrees with one verified current
   process identity; or
2. one verified current process identity when no profile exists.

Version output is dependency evidence only and never selects a provider.
Conflicting Codex/Claude evidence returns `NO_GO_RUNTIME_AMBIGUOUS`; missing
live identity returns `NO_GO_RUNTIME_UNDETECTED`.

For an existing PostgreSQL-backed Codex target, `agents.metadata.codex_home`
is the sole provider-root authority. It must be an absolute normalized real
directory and must equal `ordinary_projection.provider_config_root`. Caller
`CODEX_HOME`, TUI, and tmux values are evidence-only and cannot fill or
override it. Clean hosts initialize the canonical real `${HOME}/.codex` root.
Every target Codex command receives that selected root.

Codex configuration is changed only through `codex mcp add aun` and read back
with both `codex mcp get aun --json` and `codex mcp list --json`. Claude configuration uses the existing `aun init`
registration shape through `claude mcp add --scope user --transport stdio`
and is read back with strict `claude mcp get aun` and `claude mcp list`
parsing. Name-only, malformed, disabled, disconnected, duplicate, wrong-scope,
wrong-command, wrong-argument, wrong-agent, wrong-database, wrong-port, and
wrong-repository entries are rejected without being overwritten. The sole
upgrade exception is exactly one disabled user-scope `aun` stdio tuple using
`/Users/yuji/.bun/bin/bun run
/Users/yuji/.agent-comms/state-daemon/current/server.ts`, with null env and no
duplicate. Bootstrap creates a same-filesystem private `0700` run directory
and `0600` exclusive/fsynced backup of `config.toml`, proves native absence,
adds the intended tuple, and verifies exact get/list state. Failure restores
the original bytes atomically under path/realpath/device/inode/owner/mode/
size/hash/link-count fences. READY deletes and fsyncs the terminal backup.
Any enabled, duplicate, or unrecognized tuple is zero-mutation
`NO_GO_PROVIDER_ADAPTER_MISMATCH`. The bootstrap journal stores hashes
and redacted identities, not provider configuration bodies or credentials.

The selected provider's configured `wasurezu` stdio transport is also invoked
directly. READY requires successful MCP initialization, discovery of the
`recover_context` tool, and a non-error recovery response for the exact
project. A prewritten or CLI-flag-only memory receipt is not sufficient.

For PostgreSQL, the provider and daemon use the normalized `DATABASE_URL`.
For SQLite, bootstrap records and passes the exact `AGENT_COM_DB=sqlite` and
`AGENT_COM_SQLITE_PATH` tuple to both the provider and LaunchAgent. The queue
smoke always uses that same database tuple.

PostgreSQL rollback never drops a shared database or reverses shared schema
migrations. It retains the captured endpoint/migration/schema ledger; expires
exact-run memory evidence, stops exact-run runtime rows, expires exact-run
queue rows, proves no run-owned row remains active, and proves non-run rows did
not change. A retained shared-schema delta reports `PARTIAL_ROLLBACK_NO_GO`.
For SQLite, a pre-existing database is backed up
with its realpath, device/inode, mode, byte digest, and post-state DB/WAL/SHM
artifact digest. Restore is atomic and allowed only under those fences. A
run-created SQLite database removes the exact DB, WAL, and SHM artifacts and
verifies all three are absent.

## Desired-event isolation

B3 locks the exact `agents` row and captures complete row/outbox preimages.
The trigger-created event set is derived by exact ID, and the one run event is
committed with `available_at='infinity'`, `delivered_at=NULL`, and
`attempt_count=0`. A normal concurrent reconciler therefore sees zero
delivery. B8 consumes only that recorded event ID—never a latest-event query.
On a B5–B8 failure, mutations roll back in strict reverse order, including B4
before B3. B8 re-holds a consumed event before B3 restores the controlled
desired/profile projection, removes only the run and compensating event IDs,
and restores the derived revision/digest/timestamps without firing the watched
trigger. Unrelated agent runtime fields are preserved.

## Journal, resume, and rollback

Each non-dry run is stored at:

```text
${AUN_HOME:-~/.aun}/bootstrap/<agent_id>/<run_id>.json
```

Directories are private and run files are mode `0600`. The journal records
stage results, each stage's canonical native-readback digest and seal digest,
and a digest-fenced mutation manifest. A terminal failed run rejects re-entry;
the mutation manifest digest and stage seal digests are calculated from the
same redacted projection that is durably written, so secret-bearing preimages
cannot make a persisted journal fail its own digest or seal gate.
For a non-terminal interrupted journal, resume is accepted only when the agent,
repository/workspace realpaths and head, provider executable/version/config
scope, intended AUN tuple template, provider-native Wasurezu tuple, home/AUN
state root, database endpoint, memory project, safe defaults, passed-stage
evidence, and mutation manifest match. B0 and B1 are rerun. Every other passed
stage is independently read back before it is skipped, including the database
schema/artifact digest, exact provider tuple, Wasurezu tuple and durable
recovery receipt, runtime identity, plist plus launchctl load identity, and
queue terminal identity. A missing or changed stage seal returns
`NO_GO_RESUME_REVALIDATION` before the next mutation. Rollback runs in reverse
order and refuses
cross-run or unowned deletion. If any recorded rollback cannot be verified,
the terminal status is `PARTIAL_ROLLBACK_NO_GO`, never success.
An interrupted B2, B3, B4, B6, B7, or B8 stage whose protected effect may have
occurred without a complete mutation receipt is also
`PARTIAL_ROLLBACK_NO_GO`; an empty recorded manifest is not proof that rollback
succeeded across that crash window.
Each surface is durably marked `attempting` before rollback starts, then
`verified`, `failed`, or `skipped`, with start/completion timestamps, evidence,
and the final native-readback digest. The run also records lock-release
authorization before unlocking and the observed release timestamp afterward.
If recovery encounters an interrupted release marker, it does not write the
recovered release receipt until it owns the newly published exact same-run
lock. It then reloads the journal under that ownership before saving, preventing
a competing resume from reverting a live resume with a stale snapshot.

Run-owned memory evidence is expired with a rollback reason rather than
deleted, so its audit history remains available. Provider registration and
LaunchAgent rollback both require native absence/unloaded readback before the
mutation is marked verified.

Before B6, plist existence/bytes/mode and launchctl domain/label/load/PID are
captured independently. A loaded same-label job with no plist is treated as
pre-existing ambiguous state and stops without writing. A pre-existing
unloaded plist is restored to its exact original bytes/mode and remains
unloaded on rollback. A run-created job is booted out and both its plist and
launchctl entry must be absent. PID, label, agent, ownership-token, or plist
digest drift blocks rollback without mutation.

Timeouts are cancellation-aware. Bootstrap sends `SIGTERM`, waits at most five
seconds, then sends `SIGKILL` if necessary and waits for confirmed process
close. Success, nonzero, timeout, SIGTERM, and SIGKILL paths all receive an
exact target readback. If a provider, profile, database, or daemon target
changed despite failure, the observed mutation is durably journaled and its
rollback/native final readback is completed (or marked recovery-required)
before the per-agent lock is released. An unresolved target returns
`NO_GO_POST_MUTATION_READBACK`; process exit alone is never proof of no change.

## Operational boundary

Run bootstrap only on the seat being installed. Do not use it as a fleet
activation command. Merge, distribution inclusion, D1 activation, protected
target changes, and production rollout remain separate owner decisions.
