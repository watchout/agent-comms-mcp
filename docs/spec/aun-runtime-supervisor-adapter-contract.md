# AUN Runtime Supervisor Adapter Contract

> Issue: #602
> Status: proposed
> Slice: runtime supervisor adapter contract + conformance tests
> Last updated: 2026-06-02

## Purpose

Full reboot recovery must not inherently depend on tmux, launchd, Claude Code,
Codex CLI, or any specific session application.

AUN core owns desired runtime state, identity, endpoint evidence, queue
readiness, wake-up semantics, and health/readiness definitions. The runtime
supervisor adapter owns host-specific process/session control.
In short: runtime supervisor adapter owns host-specific process/session control.

The local tmux/launchd path is only the first adapter, not the architecture.

## Boundary

| Owner | Responsibility |
|---|---|
| AUN core | desired state, `agent_id`, runtime kind, endpoint identity, queue readiness, wake-up policy, health/readiness classification, GO/NO-GO policy |
| Runtime supervisor adapter | host process/session inspect/start/stop/restart/wake implementation, supervisor-specific IDs, local process evidence, logs/attach handles |
| Runtime adapter | Codex/Claude/OpenClaw/runtime invocation and typed result parsing after a queue row is claimed |
| Connector/projection adapter | Discord or other provider delivery/read/write evidence |

Core must consume adapter evidence. Core must not shell out directly to tmux,
launchd, systemd, Kubernetes, Nomad, Docker, MDM, or managed runner lifecycle
commands by default.

## Required Evidence Shape

Every supervisor adapter report must provide this logical shape. Implementations
may encode it as TypeScript, JSON, DB rows, or another structured form, but the
fields are required for conformance.

```ts
type RuntimeSupervisorReport = {
  runtime_kind:
    | 'codex'
    | 'claude_code'
    | 'openclaw'
    | 'state_daemon'
    | 'http_service'
    | 'stdio'
    | 'other'
  supervisor_kind:
    | 'none'
    | 'process'
    | 'tmux'
    | 'launchd'
    | 'systemd'
    | 'kubernetes'
    | 'nomad'
    | 'docker'
    | 'docker_compose'
    | 'mdm_desktop_agent'
    | 'managed_runner'
    | 'other'
  endpoint_identity: {
    endpoint_kind:
      | 'tcp'
      | 'unix_socket'
      | 'stdio'
      | 'http'
      | 'streamable_http'
      | 'remote_url'
      | 'none'
    endpoint_id?: string
    endpoint_uri?: string
    host_id?: string
    agent_id: string
    runtime_instance_id?: string
    connector_instance_id?: string
    fingerprint?: string
  }
  desired_state: 'disabled' | 'stopped' | 'ready' | 'running'
  observed_state:
    | 'unknown'
    | 'not_found'
    | 'starting'
    | 'ready'
    | 'running'
    | 'degraded'
    | 'stopped'
    | 'failed'
  capabilities: Array<{
    name: 'inspect' | 'readiness' | 'wake' | 'start' | 'restart' | 'stop' | 'logs' | 'attach'
    supported: boolean
    requires_approval?: boolean
    evidence?: Record<string, unknown>
  }>
  paths?: Array<{
    role: 'program' | 'working_directory' | 'artifact' | 'log' | 'config' | 'other'
    path: string
    exists?: boolean
    executable?: boolean
    volatile?: boolean
  }>
  health?: {
    ok: boolean
    readiness: 'ready' | 'not_ready' | 'unknown'
    failure_codes?: string[]
  }
}
```

## Capabilities

Capabilities are typed. The presence of a supervisor does not imply every
operation is allowed.

| Capability | Meaning | Required policy |
|---|---|---|
| `inspect` | Read observed state and endpoint evidence | valid without mutation |
| `readiness` | Classify GO/NO-GO for the runtime endpoint | valid without mutation |
| `wake` | Surface exact queue work through a bounded runner or approved wake path | must not call `next`, `inbox`, or FIFO drain |
| `start` | Start a stopped runtime | requires adapter support and approval when it mutates host state |
| `restart` | Restart an existing runtime or daemon | requires adapter support plus explicit approval evidence |
| `stop` | Stop a runtime | requires adapter support, fencing/ownership evidence, and approval |
| `logs` | Return operator log evidence | read-only |
| `attach` | Return an operator handle | must not become queue processing authority |

An adapter that only supports `inspect` and `readiness` is valid. It cannot be
used for wake, start, stop, or restart.

## Failure Codes

Conformance reports must fail closed with stable codes:

| Code | Meaning |
|---|---|
| `MISSING_ENDPOINT_IDENTITY` | Desired state lacks endpoint identity evidence. |
| `MISSING_OBSERVED_ENDPOINT_IDENTITY` | A ready/running desired state has no observed endpoint identity. |
| `AGENT_IDENTITY_MISMATCH` | Observed endpoint belongs to a different `agent_id`. |
| `RUNTIME_KIND_MISMATCH` | Observed runtime kind differs from desired runtime kind. |
| `VOLATILE_RUNTIME_PATH` | Program, working directory, artifact, log, or config path points at `/tmp`, `/private/tmp`, or another disposable path. |
| `PROMPT_DRIVEN_RECOVERY_FORBIDDEN` | Recovery evidence depends on TUI prompt injection, `next`, `inbox`, or FIFO drain. |
| `CAPABILITY_UNSUPPORTED` | Requested non-restart capability is unsupported by the adapter. |
| `RESTART_CAPABILITY_UNSUPPORTED` | Restart was requested but the adapter does not support restart. |
| `RESTART_APPROVAL_REQUIRED` | Restart has adapter support but lacks explicit approval evidence for the exact scope. |
| `OBSERVED_RUNTIME_FAILED` | Adapter reports a failed observed runtime. |

## Local Adapter Boundary

Local development adapters may use tmux and launchd. Those adapters are local
host adapters only.
tmux/launchd are local-dev adapter examples only.

Enterprise deployments must be able to provide adapters for:

- systemd
- Kubernetes
- Nomad
- Docker Compose
- Docker
- MDM-managed desktop agents
- managed runner services
- direct process or stdio-only runtimes

tmux session name, launchd label, process ID, pod name, unit name, container ID,
or allocation ID is supervisor evidence. It is not AUN identity, queue
authority, channel ownership, or proof that pending work can be processed.

## Queue Wake-Up Semantics

Queue wake-up is an AUN core policy, not a session-app side effect.

- TUI prompt injection is forbidden as a recovery success path.
- `next`, `inbox`, and FIFO drain are not recovery mechanisms.
- Wake capability must name a bounded path such as exact `queue_id` runner
  invocation, exact batch policy, or a typed adapter wake that cannot process
  unrelated rows.
- Stale queue cleanup remains dry-run first and exact-ID scoped.
- Active rows are not bulk terminalized to make readiness green.

## Restart Semantics

Restart requires all of the following:

1. exact desired runtime state and endpoint identity
2. adapter evidence that `restart` is supported
3. ownership/fencing evidence appropriate to the supervisor
4. explicit approval evidence for the exact `agent_id`, supervisor kind, and
   restart intent
5. CP-70/CP-80 readiness evidence for the activation scope

Without these, restart is NO-GO. state_daemon restart is not a repair mechanism
for queue backlog, loop prompts, projection fallback, or missing runtime
identity.

## Relationship To #603, #667, And #668

#603 and PR #667 provide a local LaunchAgent readiness diagnostic. That is
valuable local evidence, but it is not the general architecture.

PR #668's recovery runbook consumes supervisor evidence as part of the
GO/NO-GO packet. The runbook does not define the adapter architecture by
itself.

This contract is the architecture boundary used by both: LaunchAgent readiness
is one adapter's evidence, and full recovery consumes normalized supervisor
evidence regardless of host supervisor.

## Tests Required

Implementation slices must include conformance coverage for:

1. adapter that only supports inspect/readiness is valid for readiness.
2. adapter without restart capability cannot be used for restart.
3. missing endpoint identity fails closed.
4. volatile path evidence becomes NO-GO.
5. prompt-driven `next`, `inbox`, TUI prompt injection, or FIFO drain is not a
   recovery mechanism.
6. state_daemon restart requires explicit adapter capability and approval
   evidence.
7. core conformance code does not shell out to host-specific lifecycle tools.

## Non-Goals

- This contract does not implement a production supervisor adapter.
- This contract does not restart state_daemon.
- This contract does not call launchctl bootstrap/kickstart.
- This contract does not activate Discord or perform live Discord writes.
- This contract does not process queue rows, call `next`, call `inbox`, or drain
  FIFO.
- This contract does not add schema.
- This contract does not invoke live Codex, Claude, or other runtime CLIs.
