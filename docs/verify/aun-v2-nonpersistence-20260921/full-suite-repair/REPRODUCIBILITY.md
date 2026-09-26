# Same-head reproducibility correction

cell_id: CELL-AUN-940-TRIAL-READY-20260921-003
risk_class: R3
active_function: implementation_executor
TRIAL_READY: false

Control source: https://github.com/watchout/agent-comms-mcp/pull/968#issuecomment-5771036749
Body SHA256: `e38534af8a7e10f6f90240ac67c9fbbb4d5799b8373cc3af6c900abe9e952ad0`.
Supporting Work: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5770944759
Body SHA256: `ad355b705666b16dc98ac15684da45bec61e98d56b21c7cb97c67902ac97c5b0`.

Completion means two public full runs with zero failures on the same repaired
head, all six specified cases passing individually and in the full suite,
followed by one maker-external cycle-3 acceptance. A local or single green
public run does not meet that criterion. No unchanged-head retry was requested
by this maker during this correction.

## Observed failures before this change

All five public runs below used candidate `5ee250824cc4ce4d2af5077487705e838fcd03ba`.
Their complete logs, JUnit and subject/version records are retained in
`repair-evidence.tar.xz`, with byte hashes in `repair-runs-manifest.json`.

| Run | PASS | FAIL | Existing SKIP | Total | JUnit assertions |
|---|---:|---:|---:|---:|---:|
| 35673274041 | 3317 | 0 | 59 | 3376 | 18352 |
| 35680471064 | 3316 | 1 | 59 | 3376 | 18347 |
| 35680471141 | 3312 | 5 | 59 | 3376 | 18330 |
| 35685462036 | 3311 | 6 | 59 | 3376 | 18325 |
| 35685462331 | 3315 | 2 | 59 | 3376 | 18339 |

NP04's actual replacement process was incorrectly resolved in three red runs.
The other five failures were the clean SQLite dry-run, NORM-022 healthy and
multi-channel cases, and AC-CFG-1/2. This is not an owner-overlay failure.

## Competing hypotheses and distinguishing observations

1. Manual fixture grants precede the conservative end of the observed process
   start interval. The five positive cases manually create/update leases without
   the ordinary heartbeat acquisition boundary. Record DB time, observed start,
   upper bound and actual wait, then perform their original assertions.
2. Holder/process/workspace residue or duplicate logical identity contaminates
   the result. NP04 records original and replacement PID/workspace and the fresh
   OS observation. Each fixture keeps its private DB/workspace and ephemeral
   socket; the five positive cases additionally confirm the same real holder
   before and after the grant boundary.
3. The Linux start timestamp's interval does not contain the actual process
   birth. NP04 records the wall-clock bounds around replacement spawn, the old
   lease, the resolution already returned, and Linux target `/proc/PID/stat`,
   uptime and btime. Sampling occurs after resolution; there is no added delay
   before resolving the immediate replacement.
4. Order dependence. Public CI executes each of the six cases in a separate Bun
   process before its unchanged full-suite command. A JUnit check requires
   exactly one executed passing case per standalone command. A selected failure
   stops that run; no passing selected result substitutes for the full suite.

Retaining the five complete public logs grows the binary diff beyond the old
16 MiB command-output buffer. Subject recording now streams the same complete
`git diff --binary --full-index` bytes through a private temporary file into
SHA256, preserving its checksum and cleanup without truncation. This is an
evidence-collection capacity change, not a test or authority gate change.

No production guard, assertion, test timeout or skip/only selection in source
was relaxed. The new fixture wait is only at manual grant sites; spawning a
replacement itself never waits for the authority window. The existing 30-second
test limit and six cases' expected results are retained.

## Local results on the changed input

Bun 1.4.2, macOS, owned PG17.9 on a private UNIX socket and isolated SQLite:

| Version | PASS | FAIL | Filtered | Assertions |
|---|---:|---:|---:|---:|
| repro-sqlite-v1 | 1 | 0 | 25 | 6 |
| repro-norm-healthy-v1 | 1 | 0 | 10 | 2 |
| repro-norm-multi-v1 | 1 | 0 | 10 | 3 |
| repro-cfg1-v1 | 1 | 0 | 5 | 8 |
| repro-cfg2-v1 | 1 | 0 | 5 | 9 |
| repro-np04-v1 | 1 | 0 | 8 | 8 |
| repro-four-files-v1 | 52 | 0 | 0 | 244 |

All seven runs used unchanged source manifests. `RUNS.md` / `runs.json` retain
all preceding measurements separately. On macOS the manual-grant waits were
zero because kernel microsecond starts were already older than the DB clock.
These results do not distinguish the Linux-only precision hypothesis or
establish public full-suite reproducibility.

## Remaining

Linux diagnostic/standalone execution; two green public full runs on the repaired
head; one external cycle-3 acceptance; owner exact-head R3 decision; NP12/live
application and actual trial. If NP04 proves a production observation/authority
defect, stop rather than change a guard under the fixture-only instruction, and
return the diagnostic log once for a concrete next handoff.

PR#958: retained without close/merge/absorption declaration.
PR#963: retained as an ancestor without close/merge.

next_action: none (continue the authorized changed-input public measurement).
