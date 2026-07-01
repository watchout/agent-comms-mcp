# AUN Runtime V2 Policy

Issue: https://github.com/watchout/agent-comms-mcp/issues/792

`aun runtime-v2` is guarded by a checked-in policy file at
`config/aun-runtime-v2-policy.json`.

The policy is deterministic and fail closed:

- unknown agents are rejected before DB access;
- environment variables cannot add allowed agents;
- imported options cannot add allowed agents;
- policy-listed non-kodama agents are dry-run only in PR-A;
- `kodama` is the only live-capable runtime-v2 agent in PR-A.

Plan output includes policy metadata:

- `policy_id`
- `policy_version`
- `policy_source`
- `policy_agent_mode`
- `allowed_agent_ids`
- `live_agent_ids`

The policy metadata is required on the public `aun runtime-v2 plan --json`
surface as well as the execution-path plan object. `aun runtime-v2 claim
--dry-run --json` also carries the same policy metadata because it is derived
from the read-only planner.

The initial PR-A policy allows dry-run planning for common Company Dev OS
control-plane identities:

- `kodama`
- `arc`
- `agent-com-dev`
- `codex-aun`
- `auditor`
- `codex-audit`
- `codex-cto`
- `qa`
- `check`
- `spec`

Only `kodama` appears in `live_agent_ids`.

The first policy explicitly excludes historical aliases such as `l2auditor`
and `devauditor`. Additional repo-specific bots or new physical identities
require a separately gated policy change and CTO approval.

PR-A does not add scheduler, LaunchAgent, GitHub puller, Discord recovery,
fleet rollout, or live non-kodama DB consumption behavior.

Excluded or unknown agents must reject before DB access on the runtime-v2
execute, plan, and claim dry-run surfaces. A missing or unreachable DB must not
mask policy rejection for excluded identities such as `l2auditor` or
`devauditor`.
