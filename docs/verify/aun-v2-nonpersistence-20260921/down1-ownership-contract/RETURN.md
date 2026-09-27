D-OWN-1 is implemented for CELL-AUN-940-TRIAL-READY-20260921-003 / R3.

Authority: [suite-lead conditional same-cell implementation](https://github.com/watchout/agent-comms-mcp/pull/968#issuecomment-5773161834), body SHA256 `d96e08ae362935bd5478466578297de5d071961dbc15d44247042bcb9c88eaf8`; [published arc contract](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5773292758), body SHA256 `8849fb477a9cd9efff9947fb979e6a6b95d14197470b0c70fe2fcacc8b8805f4`.

Resolve and heartbeat no longer compare process start to acquired_at. UUID/lease/holder/fence/expiry and request-local identity reobservation remain required. The spec was updated before implementation. Darwin process-start observation remains useful for comparing successive observations; the historical interval arithmetic helpers remain only for existing fixture/unit arithmetic, never runtime ownership proof.

UUID reuse fails on transactional anchor acquisition before it can obtain a worker lease. The real child binds a port-0 socket, probes pre-publication 503, and executes product heartbeat + publish. The successful predecessor records bind → COMMIT → reauthorization → publication. Its actual replacement receives RUNTIME_ENDPOINT_REGISTRATION_FAILED / RUNTIME_UUID_ALREADY_REGISTERED, exits 1, publications 0, work 0, and leaves the old lease byte-identical. No artificial replay delay or clock-window adjustment is used.

server.ts now completes startup acquisition before connecting MCP/HTTP transports or starting shared listeners/sweepers and inbox GC. Disabling runtime heartbeat is a typed failure. The actual server replay test includes a pending work row: both reused-UUID and disabled-authority startup exit 1, close the held socket, leave the pending row and old lease unchanged and never enter shared startup. The existing normal lifecycle test still verifies boot, READY, restart and orphan-claim recovery.

NP04-a/b test UUID mismatch/ambiguity, holder/fence/expiry rejection, and the real PostgreSQL active-scope unique index. NP04-d drives a published endpoint with identity/fence changes during authorization and observes handler effects 0. NP04-e statically excludes acquired_at reads/interval helpers from all four resolvers and varies historical acquisition times across process-start boundaries without changing selection or renewal.

Known design limit (not a deviation): a D1-violating launcher that reuses UUID while the old lease is active cannot be distinguished by observation alone. Fresh UUID per exec and acquisition refusal before work are the mitigations; no physical tuple/digest is persisted. A copied in-memory lease receipt is not a new startup acquisition.

Local evidence (Bun 1.4.2, Node 24.20.0, macOS, owned socket-only PostgreSQL 17.9 and isolated SQLite):

| Version | PASS | FAIL | Filtered | Assertions | Seconds |
|---|---:|---:|---:|---:|---:|
| v01-authority | 12 | 0 | 0 | 96 | 23.725744 |
| v02-regression | 59 | 1 | 0 | 404 | 39.324127 |
| v03-startup | 15 | 0 | 0 | 122 | 28.801962 |
| v04-direct | 138 | 0 | 0 | 1004 | 112.468888 |
| v05-np04-standalone | 1 | 0 | 13 | 24 | 2.56468 |

v02's one failure is retained: the historical dual-run fixture started an unleased MCP and relied on the old parallel startup to enter its Discord configuration branch. Its fixture now supplies a real observed process/new UUID and owned PG lease. SQLite dedup remains in its original database; every original assertion is unchanged. v03 and v04 pass. The five additional authority cases and two contract-authorized name replacements are mapped in preservation.json; no SKIP was added. The earlier 142+24 and 59 regression denominators and historical public 59-SKIP multiset remain obligations for full-suite verification, not claims inferred from these selected suites.

submitted-sources.json covers every source observed in the final local execution. All five executions verified source-before/after equality; their complete logs, JUnit, source manifests, migration logs and metadata are in raw-evidence.tar.xz with individual hashes. The archive also retains the prior CI01 cancellation race log: run35704417529 completed six standalone cases and started full for 36 seconds before cancellation; run35704417990 had no test start. Neither is counted as a completed green full.

This packet is local maker evidence only. Public same-HEAD full 2 runs, six standalone/full cases, maker-external cycle3, owner exact-head R3 disposition and NP12/live trial remain pending at commit time. Public results are to be pinned to the immutable submitted HEAD/tree in #940 and PR968. No live/shared database, provider, queue, approval label, merge or additional agent operation was performed.

PR958: retained OPEN, no close/merge. PR963: retained OPEN, no close/merge.
next_action: none (continue authorized public verification before handoff).
