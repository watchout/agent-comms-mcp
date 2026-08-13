# Runtime checkout provenance alignment

SPEC-ID: `SPEC-MCP-RUNTIME-CHECKOUT-PROVENANCE-001`

Status: `IMPLEMENTATION_CANDIDATE_AWAITING_INDEPENDENT_AUDIT`

Control source: [watchout/ai-dev-framework Issue #576](https://github.com/watchout/ai-dev-framework/issues/576)

## Goal

Make a runtime heartbeat's row fields and Git metadata two projections of one
immutable checkout-evidence object, then fail closed whenever stored row and
metadata projections contradict each other.

## Requirements

- `REQ-RCP-001`: The server collects checkout path, commit, and dirty status
  once from `AGENT_COM_CHECKOUT_PATH` when it is set, otherwise from the
  immutable, decode-safe `SERVER_ROOT`. `process.cwd()` is not runtime identity
  authority. The selected checkout's actual Git HEAD is commit authority;
  `AGENT_COM_COMMIT_SHA` is accepted only as a validated full-SHA fallback when
  Git HEAD is unavailable and can never override a different checkout HEAD.
- `REQ-RCP-002`: `checkout_path`, `commit_sha`, `git_checkout_path`,
  `git_commit_sha`, and `git_dirty` are derived from that same frozen object.
- `REQ-RCP-003`: A row/metadata path or commit disagreement emits exactly the
  `runtime_checkout_evidence_mismatch` integrity reason even when no approved
  commit/root policy is active. `allowDirtyCheckout` and fleet drift exclusions
  cannot suppress this reason.
- `REQ-RCP-004`: Runtime inventory, connector inventory, and AUN fleet readiness
  propagate the integrity reason as a blocker.
- `REQ-RCP-005`: Aligned legacy single-projection evidence remains compatible,
  and existing clean/dirty checkout policy behavior remains unchanged.

## Acceptance criteria

| ID | Predicate | Evidence |
|---|---|---|
| `AC-RCP-001` | A cwd different from the server checkout cannot change the selected checkout path, commit, or dirty status. | `tests/git-checkout-evidence.test.ts` |
| `AC-RCP-002` | Server-root and explicit-checkout Git HEADs override a mismatched env SHA; a non-Git package accepts only a 40-character full-SHA fallback. | `tests/git-checkout-evidence.test.ts` |
| `AC-RCP-003` | Path and commit disagreements independently fail closed without an active drift policy; allowing dirty state does not bypass them. | `tests/fleet-checkout-drift.test.ts` |
| `AC-RCP-004` | Aligned clean, dirty, allowed-dirty, and legacy single-projection evidence retain their existing outcomes. | `tests/fleet-checkout-drift.test.ts` |
| `AC-RCP-005` | Runtime and connector inventory plus fleet readiness surface the mismatch blocker, and a drift exclusion cannot hide it. | `tests/runtime-inventory.test.ts`, `tests/aun-fleet-readiness.test.ts` |
| `AC-RCP-006` | `SERVER_ROOT` is derived with `fileURLToPath(import.meta.url)`, not undecoded URL pathname text. | `tests/git-checkout-evidence.test.ts` |

## Failure policy

Contradictory evidence is an identity-integrity failure. Operators must replace
or regenerate the heartbeat evidence from one checkout; they must not reinterpret
the dirty-checkout allowance or a bounded drift exclusion as an integrity
waiver.

## Non-scope

- Runtime restart, deployment, activation, live heartbeat readback, or live DB
  mutation.
- Database schema or migration changes.
- Provider, queue, state-daemon, credential, branch protection, or required-check
  changes.
- Audit verdict, owner approval, merge, or release.

## Required next gate

An independent audit role must inspect one exact head, rerun the focused tests,
and publish `PASS`, `REQUEST_CHANGES`, or `ESCALATE`. The implementation author
does not issue that verdict.
