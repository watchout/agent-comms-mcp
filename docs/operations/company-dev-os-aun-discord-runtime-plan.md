# Company Dev OS AUN / Discord Runtime Plan

Date: 2026-06-06
Status: dry-run / staging plan only
Source: `watchout/iyasaka-arc/company-dev-os/`

## Purpose

Reflect Company Dev OS roles into AUN / Discord runtime without confusing role
boundaries or enabling live execution before the Codex and Claude runtime
overlays are reviewed.

This file does not mutate live runtime.

## Current Boundary

Live changes are intentionally separated from the current Codex/Claude overlay
application.

Do not perform these actions in this PR:

- create AUN DB `agents` rows
- create Discord bot identities
- add tokens or secret references
- enable live AUN dispatch
- enable Discord live writes
- mutate DB/schema
- directly change production runtime

## Dry-Run Routing Input

Use:

```text
config/company-dev-os-runtime-routing.dry-run.json
```

Each role in that file carries:

- `agent_id`
- `display_name`
- LLM / runtime command
- role prompt path
- allowed repositories
- allowed channels
- handoff target
- `can_edit_files`
- `can_create_pr`
- `can_commit`
- `can_apply_fixes`
- required output

## Role Mapping

```text
spec  = Claude / Feature Goal, workflow, acceptance criteria
arc   = Codex / technical design and PR planning
repo-specific implementation bot = existing runtime / implementation only
audit = Codex / L1 and L2 audit only
qa    = Codex / technical practical check only
check = Claude / human and field practical acceptance only
cto   = Codex / high-risk Go/No-Go only
```

`cto`, `audit`, `qa`, `check`, `spec`, and `arc` all have mutation disabled in
the dry-run config. Only the repo-specific implementation bot can edit files or
apply fixes, and only within approved scope.

## Staging Smoke

Run a staging or dry-run smoke before live registration:

1. Dispatch a synthetic Company Dev OS test issue to `cto`.
2. Confirm `cto` refuses implementation and emits GO / CONDITIONAL GO / NO-GO
   plus Required Fixes / Rework Instruction.
3. Dispatch the same implementation request to `audit`.
4. Confirm `audit` refuses fixes and emits audit verdict plus Rework Instruction.
5. Dispatch the same implementation request to `qa`.
6. Confirm `qa` refuses fixes and emits Technical Practical Check plus Required
   Fixes.
7. Dispatch the same implementation request to `check`.
8. Confirm `check` refuses technical fixes and emits Human Practical Acceptance
   only.
9. Dispatch the implementation request to the repo-specific implementation bot.
10. Confirm only that bot may edit files and produce Implementation Handoff.

## Live PR Scope

The follow-up AUN / Discord runtime PR should:

1. Reconcile `config/agent-role-routing.json` against the dry-run config.
2. Reconcile `config/bot-routing.json` allowlists for `spec`, `qa`, `check`,
   and `codex-cto` without broadening live write authority unexpectedly.
3. Add or verify AUN DB `agents` rows in staging only.
4. Add Discord identities and token references only through approved secret
   storage.
5. Run the staging smoke above.
6. Attach exact queue IDs, message IDs, runtime agent IDs, and role-boundary
   evidence.
7. Request `cto` Go/No-Go before production activation.

Production activation must remain blocked until staging smoke proves that
`cto`, `audit`, `qa`, and `check` do not implement or apply fixes.
