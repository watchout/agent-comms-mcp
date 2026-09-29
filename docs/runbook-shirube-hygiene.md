# Runbook — Shirube hygiene in agent-comms-mcp

## Deploy

The sole version pin is the resolved commit in `.github/workflows/hygiene.yml` (`uses:` with a tag annotation). The reusable workflow fetches its own scripts at the same callee commit. No copied tools or credentials are distributed.

This first adoption is report_only. Inspect failed and skipped steps individually; a non-required check is not a passing check. Existing findings are expected. Do not add continue-on-error or hide exit codes.

The implementation seat opens the configuration PR. Devauditor reviews it; suite-lead obtains the owner's exact-head decision for this initial workflow addition and another author merges. Main evidence is the `hygiene / hygiene` job log line `shirube tools: watchout/shirube@<resolved SHA>` matching the workflow pin. A draft PR run is not main evidence.

## Upgrade and rollback

Open a separate PR changing only the `uses:` SHA and tag annotation to the reviewed tag's resolved commit. Suite-lead applies the published standing authorization only to qualifying upgrades/rollbacks. The initial adoption itself still needs exact-head approval.

For rollback, restore the preceding reviewed SHA and tag annotation in a separate PR. After merge, read the main job's tools identity and record the run URL below. Re-upgrade by the same path. If rollback intentionally holds an old version, obtain the owner's published hold decision; do not silently claim synchronized rollout.

The first upgrade is the separately reviewed jscpd scan-set correction, delivered by changing the workflow pin. Baseline support and generated baseline files follow in a later release. This adoption contains no `.hygiene/*` baseline. Required-check registration and AB-14 rejection/acceptance rehearsal follow only after the later version's main checks all pass and owner D3 is published.

Owner-only removal of a future required check: remove `hygiene / hygiene` from the main branch protection contexts through GitHub settings/API; record the decision and readback. This is a documented recovery path, not a rehearsal performed here.

## Recovery

| Failure | Detection / containment / recovery | Residual risk |
|---|---|---|
| Callee cannot be fetched | Read checkout failure; verify public repo/tag and SHA. Correct pin in a reviewed PR; no secret workaround | Not observed until a main run succeeds |
| Tool identity mismatch | Verification step must fail; stop rollout and restore a known reviewed pin | Never count unobserved identity as success |
| Existing code findings | Keep raw failure and skipped steps; route code reduction separately (#970) | report_only does not enforce merge protection |
| Install or configuration failure | Preserve log and fix only authorized config; ask arc if scope must expand | Later checks may not have executed |
| Version drift across consumers | Suite-lead compares the pins in its existing #24 record; mark distribution incomplete until all main runs match | Automated drift-check is a later release |

Old `.shirube/runtime` remains frozen until W3/W5/RR retirement. Its copies are not updated by this adoption. Scope-check removal and the bootstrap dependency correction are separate PRs; V1 freeze must be checked before the latter.

## History

| date | version source | change | evidence |
|---|---|---|---|
| 2026-09-29 | workflow pin in this PR | Initial report_only configuration prepared | #977; review, owner decision, merge and main identity readback pending |

Upgrade, rollback and re-upgrade rows will contain their actual run URLs after execution. No rehearsal has been claimed.
