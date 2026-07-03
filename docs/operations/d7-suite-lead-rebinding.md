# D7 Suite-Lead Rebinding

Control source:

- `watchout/iyasaka-arc#23`
- Owner ruling record: https://github.com/watchout/iyasaka-arc/issues/23#issuecomment-4864339397
- D7 assignment: https://github.com/watchout/iyasaka-arc/issues/23#issuecomment-4863645025
- D7 owner decision: https://github.com/watchout/iyasaka-arc/issues/23#issuecomment-4863673059
- Binding issue: https://github.com/watchout/agent-comms-mcp/issues/837
- Function binding definition: `watchout/iyasaka-arc#21:docs/shirube/function-bindings.yaml`

## Binding

```yaml
schema_version: shirube-v3-local-runtime-binding/v1
agent_id: "agent-com-dev"
role_alias: "agent-com"
active_function: "coordination_recorder"
workspace: "/Users/yuji/Developer/agent-comms-mcp"
memory_project: "iyasaka-arc"
scope: "iyasaka-arc suite CONTROL_STATE / WAVE-plan board"
function_bindings_ref: "watchout/iyasaka-arc#21:docs/shirube/function-bindings.yaml"
```

## D7 Conditions

1. Full function swap, not addition: agent-com drops AUN
   `implementation_executor` scope.
2. Durable rebinding: this PR records the session binding and role-routing
   separation, with the old AUN implementation assignment cleared.
3. Clean session start: suite-lead work starts from the suite board and
   `iyasaka-arc#23`, not residual AUN-dev context.

## Role Separation

- `suite_lead`: `agent-com-dev`, `coordination_recorder` only.
- AUN implementation owner: `codex-aun`.
- The existing channel primary / adapter-owner role may remain transport
  plumbing and must not be interpreted as implementation authority.

## Forbidden For Suite-Lead

- AUN/product/runtime implementation.
- Design work owned by ARC.
- Audit, QA, CTO judgment, owner approval, merge, release, production publish.
- DB schema changes, live queue mutation, secrets, branch protection, or deploy
  settings.

## Next Action

```yaml
next_action:
  actor: independent audit
  action: audit the rebinding PR for D7 condition fidelity and role separation
  deliverable: audit result comment on the PR
  completion_evidence: audit URL plus owner exact-head decision URL before merge
  blocking: true
```
