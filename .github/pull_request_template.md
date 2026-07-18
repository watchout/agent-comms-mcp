## Shirube Metadata

CELL-ID:
SPEC-ID:
IMPL-ID:
Risk Tier:
Exact Head SHA:

## Control Source

- Issue / comment / handoff / spec:

## Scope

- <what this PR changes>

## Non-Scope

- <what this PR does not change>

## Allowed paths

- <paths this PR may change>

## Forbidden paths

- <paths this PR must not change>

## Protected surfaces

Declare whether this PR touches auth, DB, workflow, deploy, secret, required checks, branch protection, rulesets, runtime, queue, state-daemon, provider delivery, MCP/tool behavior, or AUN activation.

```text
touched:
declared:
```

## Validation

- [ ] `git diff --check`
- [ ] YAML parse for `.shirube/**/*.yaml`
- [ ] Existing lightweight smoke checks
- [ ] Relevant tests:

## Owner Decision

Owner approval must name the exact head SHA before ready-for-review or merge handling.
For non-draft handling, exactly one `merge-method:merge`, `merge-method:squash`, or
`merge-method:rebase` label must match the owner decision. Only an explicitly matched
`merge-method:squash` selection is eligible for repository auto-merge.

```text
verdict:
actor:
exact_head_sha:
merge_method: merge | squash | rebase
decision_ref:
```

For non-draft or merge handling, post a separate owner decision comment and make `decision_ref` equal that comment URL:

```yaml
shirube_owner_decision:
  schema_version: shirube-owner-decision/v1
  target_repo: watchout/agent-comms-mcp
  target_pr: <PR number>
  exact_head_sha: <current PR head SHA>
  verdict: APPROVED_EXACT_HEAD
  merge_method: merge | squash | rebase
  actor: <GitHub comment author>
  decision_ref: <this GitHub comment URL>
```

## Post-Merge Evidence

```text
required:
merge_commit:
merged_at:
smoke_or_NA:
next_step:
```
