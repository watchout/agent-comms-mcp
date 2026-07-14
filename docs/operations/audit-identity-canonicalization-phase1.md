# Audit Identity Canonicalization Phase 1

Cell: `AUDIT-IDENTITY-CANONICALIZATION-20260714-001`

This PR is implementation-only inside the isolated `agent-comms-mcp` worktree.
External paths are read-only for Phase 1. Do not edit `iyasaka-org`,
`codex-audit`, or `dev-auditor` local files until exact-head audit and a
protected-surface GO.

## Implemented Locally

- `l2auditor` is represented as a historical-only, disabled, non-routable
  identity in role routing and retirement tooling.
- `evidence_audit_gate` requires `canonical_seat=codex-audit` and routes only
  to `codex-audit`.
- `devauditor` is scoped to `scenario_verification_gate` and is rejected for
  `evidence_audit_gate` verdict routing.
- Default directory and mention views omit historical-only identities; explicit
  `--include-historical` exposes tombstones for diagnostics.
- Agent retirement is dry-run by default and disables connector, binding,
  workspace, runtime, and channel membership projections before final
  tombstone on execute.
- DB and application activation paths reject active connector/binding
  projections for disabled or historical-only agents.

## Read-Only External Patch Plan

These proposed edits are not applied in Phase 1:

| Path | Proposed change |
|---|---|
| `/Users/yuji/Developer/iyasaka-org/docs/shirube/function-bindings.yaml` | Current readback: `workspace_defaults.codex-audit=evidence_audit_gate`, `workspace_defaults.dev-auditor=evidence_audit_gate`. Proposed Phase 2 patch: keep `codex-audit` as `evidence_audit_gate`; change `dev-auditor` to `scenario_verification_gate`; ensure no `l2auditor` binding exists. |
| `/Users/yuji/Developer/iyasaka-org/scripts/shirube/generate-runtime-instructions.mjs` | Current readback: fallback workspace defaults also map `dev-auditor` to `evidence_audit_gate`. Proposed Phase 2 patch: emit `codex-audit` only for `evidence_audit_gate`; emit `dev-auditor` only for `scenario_verification_gate`; require explicit canonical seat for evidence audit instructions. |
| `/Users/yuji/Developer/codex-audit/.company-dev-os/bot-runtime.json` | Current readback conflicts with canonical seat: `agent_id=l2auditor`, `status=retired`, `new_work_allowed=false`, while the workspace instructions and MCP env identify `codex-audit`. Proposed Phase 2 patch: set profile identity to `codex-audit`, display name `codex-audit`, runtime engine `codex`, active function `evidence_audit_gate`, and remove retired `l2auditor` authority from active profile. |
| `/Users/yuji/Developer/codex-audit/AGENTS.md` | Current readback: `agent_id=codex-audit`, `active_function=evidence_audit_gate`. Proposed Phase 2 patch: add explicit `canonical_seat=codex-audit` and no-fallback wording for `l2auditor` / `devauditor`. |
| `/Users/yuji/Developer/codex-audit/CLAUDE.md` | Current readback: same Shirube binding as `AGENTS.md`. Proposed Phase 2 patch: same canonical-seat and no-fallback wording as `AGENTS.md`. |
| `/Users/yuji/Developer/codex-audit/.mcp.json` | Current readback: MCP env pins `AGENT_ID=codex-audit`, expected agent id, AUN DB URL, port `8840`, and Discord state dir. Proposed Phase 2 patch: add runtime-engine/readiness metadata only if supported by the profile format; do not copy secret material. |
| `/Users/yuji/Developer/dev-auditor/.company-dev-os/bot-runtime.json` | Current readback: `agent_id=devauditor`, `active_role=audit`, direct judge audit wording. Proposed Phase 2 patch: change function/profile wording to `scenario_verification_gate`; explicitly remove evidence-audit verdict authority. |
| `/Users/yuji/Developer/dev-auditor/AGENTS.md` | Current readback: `agent_id=dev-auditor`, `active_function=evidence_audit_gate`. Proposed Phase 2 patch: bind to `scenario_verification_gate` and reject `evidence_audit_gate` verdict requests. |
| `/Users/yuji/Developer/dev-auditor/CLAUDE.md` | Current readback: extensive legacy L1/L2 audit/judge instructions. Proposed Phase 2 patch: rewrite as scenario-verification-only failure/recovery reproduction guidance, preserving historical references where needed but removing active evidence-audit authority. |
| `/Users/yuji/Developer/dev-auditor/.mcp.json` | Current readback: MCP env pins `AGENT_ID=devauditor` and contains secret-bearing provider env material. Proposed Phase 2 patch: preserve or rotate secrets through the normal secret process only; do not copy secret values into diffs; ensure the surrounding profile does not imply evidence-audit authority. |

## Canonical Dry-Run Readback

Use canonical CLI only; do not use direct SQL for live readback.

```bash
bun cli/index.ts audit-route --active-function evidence_audit_gate --canonical-seat codex-audit
bun cli/index.ts audit-route --active-function evidence_audit_gate --canonical-seat devauditor
bun cli/index.ts audit-route --active-function scenario_verification_gate --agent-id devauditor
bun cli/index.ts directory --format json
bun cli/index.ts directory --include-historical --format json
bun cli/index.ts agent retire l2auditor --dry-run --reason "AUDIT-IDENTITY-CANONICALIZATION-20260714-001 live dry-run"
```

Expected live dry-run evidence:

- `audit-route --active-function evidence_audit_gate --canonical-seat codex-audit`
  passes and routes to `codex-audit`.
- `audit-route --active-function evidence_audit_gate --canonical-seat devauditor`
  fails closed with `CANONICAL_SEAT_MISMATCH`.
- `audit-route --active-function scenario_verification_gate --agent-id
  devauditor` passes and routes to `devauditor`.
- Default directory omits `l2auditor` and `cto`; channel
  `1487368919613444156` still shows `codex-audit` as an active member and
  omits `l2auditor`.
- `--include-historical` exposes `l2auditor` and `cto` as disabled,
  historical-only, new-work-blocked, blocked-sendability identities; historical
  role `pr_audit_l2` remains present as historical-only / no new work.
- `--include-historical` mention diagnostics show `l2auditor.queue_target=false`
  with hard block `historical_only`.
- `agent retire l2auditor --dry-run` reports only `l2auditor` dependencies:
  one connector instance, three channel connector bindings, one connector
  credential, one provider identity, three provider channel access rows, four
  channel memberships, and no UI/workspace/runtime instances.
