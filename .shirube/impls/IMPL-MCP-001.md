# Registry Schema Policy Impl Handoff

IMPL-ID: IMPL-MCP-001
SPEC-ID: SPEC-MCP-001
CELL-ID: CELL-MCP-001
Risk Tier: R2 policy/design pilot
SSOT: #799
Depends: #798
Work Order: #800

## Objective

Implement the warn-only policy/design artifacts for `CELL-MCP-001: registry schema policy`.

This Impl is intentionally documentation-only. It must not change runtime behavior, MCP/tool behavior, queue/runtime/state-daemon behavior, active workflows, required checks, branch protection/rulesets, deployment, secrets, DB migrations, package metadata, or AUN activation.

## Allowed Paths

- `.shirube/**`
- `docs/**`
- `README.md`

## Forbidden Paths

- `.env`
- `secrets/**`
- `bin/**`
- `cli/**`
- `core/**`
- `db/**`
- `adapters/**`
- `entrypoints/**`
- `server.ts`
- `.github/workflows/**`
- `deploy/**`
- `package.json`
- `bun.lock`

## Implementation Steps

1. Add `.shirube/specs/SPEC-MCP-001.md` with stable requirement IDs and acceptance criteria for registry schema policy.
2. Update `.shirube/cells/CELL-MCP-001.yaml` to reference `SPEC-MCP-001` and keep the `shirube-cell/v1` canonical shape.
3. Add `docs/shirube-registry-schema-policy.md` defining registry classes, common fields, source-of-truth boundaries, approval boundaries, forbidden operations, evidence expectations, and post-merge expectations.
4. Add `.shirube/evidence/CELL-MCP-001.md` recording changed files, commands run, validation results, scope confirmation, conveyor availability, and next gate.
5. Do not modify runtime, workflow, package, DB, deployment, or secret paths.

## Required Source Alignment

Use these sources as read-only references:

- `docs/SSOT.md`
- `docs/agent-com-message-queue-spec.md`
- `docs/design/aun-normalization-roadmap.md`
- #722
- #799
- #800

Preserve these boundaries:

- GitHub remains durable source of truth for governance evidence.
- AUN may notify, accelerate, and collect evidence, but must not be the only decision record.
- Queue IDs, ACKs, Discord projection, TUI visibility, green CI, or unverified runtime are not completion evidence by themselves.
- Runtime, queue, state-daemon, provider delivery, and AUN activation remain blocked until later explicit Cell approval.

## Validation Commands

Run and record:

```bash
git diff --check
ruby -e 'require "yaml"; Dir[".shirube/**/*.yaml"].sort.each { |f| YAML.load_file(f); puts "ok #{f}" }'
bun test tests/contract/test_aun_cli_real_invocation.test.ts
bash scripts/detect-breaking-changes.sh origin/main
```

Run Shirube conveyor check in warn-only mode if available. If it is not available in this repo, do not add dependencies or workflows just to run it; record it as unavailable.

## Stop Conditions

Stop and report instead of proceeding if the work requires:

- runtime code changes
- MCP/tool behavior changes
- queue/runtime/state-daemon behavior changes
- DB migrations or production DB access
- workflow or required-check changes
- branch protection/ruleset changes
- secret access or secret mutation
- AUN activation or live multi-agent automation
- force push

## Handoff

Open a draft PR against `main` with:

```text
CELL-ID: CELL-MCP-001
SPEC-ID: SPEC-MCP-001
IMPL-ID: IMPL-MCP-001
Risk Tier: R2 policy/design pilot
SSOT: #799
Depends: #798
```

Stop for Shirube command review. Do not claim rollout completion and do not activate runtime/AUN behavior.
