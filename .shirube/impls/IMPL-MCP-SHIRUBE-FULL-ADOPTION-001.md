# Shirube Full Adoption Overlay Implementation Handoff

IMPL-ID: IMPL-MCP-SHIRUBE-FULL-ADOPTION-001
SPEC-ID: SPEC-MCP-SHIRUBE-FULL-ADOPTION-001
CELL-ID: CELL-MCP-SHIRUBE-FULL-ADOPTION-001
Risk Tier: R3

## Implementation

This implementation completes the repository-local Shirube full adoption overlay for `watchout/agent-comms-mcp`.

Changes:

- Add `.shirube/enforcement-policy.yaml`.
- Add `.shirube/lifecycle-state.yaml`.
- Add full-adoption SPEC/CELL/IMPL/evidence artifacts.
- Add `scripts/shirube-full-adoption-check.mjs`.
- Add `.github/pull_request_template.md`.
- Update `.github/workflows/pr-checks.yml` to run the full-adoption gate and prevent CI-green-only auto-merge.
- Require a machine-verifiable `shirube-owner-decision/v1` PR comment before non-draft merge handling.
- Require `Layer 0 — machine gate` in GitHub branch protection required status checks.

## Boundary

This is a governance/enforcement adoption change. It changes active workflow behavior but does not change runtime, MCP/tool behavior, queue, state-daemon, provider delivery, DB schema, secrets, deployment, or AUN activation.

Branch protection settings are available and are used to require `Layer 0 — machine gate`. Rulesets are available but empty and not used for this PR because branch protection provides the active merge gate.

## Validation

Required validation:

```bash
git diff --check origin/main...HEAD
ruby -ryaml -rdate -e 'Dir[".shirube/**/*.yaml"].sort.each { |f| YAML.safe_load(File.read(f), permitted_classes: [Date, Time], aliases: true); puts f }'
node scripts/shirube-full-adoption-check.mjs --repo watchout/agent-comms-mcp --event <event.json> --changed-files <changed-files.txt>
node scripts/shirube-full-adoption-check.mjs --repo watchout/agent-comms-mcp --event <non-draft-event.json> --changed-files <changed-files.txt> --comments <owner-decision-comments.json>
gh api repos/watchout/agent-comms-mcp/branches/main/protection/required_status_checks
bash scripts/detect-breaking-changes.sh origin/main
bun test --timeout 30000
```
