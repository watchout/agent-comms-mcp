# LLM Runtime Adapter Boundary

Status: design baseline for post-Codex-runner expansion
Date: 2026-05-21
Scope: `state_daemon`, AUN runners, LLM runtime adapters

## Decision

Queue progress is controlled by deterministic AUN runners and DB state
transitions. LLM runtimes receive already-claimed work and return structured
results; they do not decide how to claim, repair, or close queue rows.

The adapter boundary is:

```text
claimed work envelope -> runtime-specific invocation -> normalized result
```

Current GitHub baseline:

- `aun receive-actionable` / `aun drain` own script-controlled receive.
- `aun codex-runner` owns the first Codex receive tick.
- `aun processing` and `aun done` own lifecycle transitions.
- `aun reply --no-close` owns ACK/progress.
- `aun reply --close --queue-id --message-id` owns final close.
- `state_daemon` plans `invoke_codex_runner` for eligible Codex rows.

This document does not replace those surfaces. It defines the adapter boundary
for adding Claude Code, OpenClaw, or other runtimes without creating parallel
queue semantics.

## Runtime Contract

Every runtime adapter must implement the same logical contract:

```text
input:
  queue_id
  message_id
  agent_id
  channel_id / thread_id
  requester
  canonical content
  lifecycle expectations

output:
  ok / failed
  summary
  optional reply body
  lifecycle action: ack | progress | result | close | needs_info | fail
  evidence / metadata
```

The adapter may use CLI stdin, SDK calls, JSONL events, or structured JSON
schema output internally. Those details must not leak into queue ownership.

## Proven Invocation Shapes

Local smoke investigation on 2026-05-21 confirmed the following viable scripted
entrypoints.

Codex CLI:

```text
stdin -> codex exec - --json -> JSONL events -> final agent_message
```

Observed constraints:

- Global flags such as sandbox and approval policy must be passed before the
  `exec` subcommand.
- `--json` emits machine-readable JSONL events.
- Schema-file based output should use a real file path; process substitution is
  not portable enough for runner contracts.

Claude Code:

```text
stdin -> claude -p -> JSON / structured_output
```

Observed constraints:

- Production daemon use should prefer bare/headless execution with explicit
  auth and settings.
- Non-bare local execution can work for diagnostics, but it loads local
  context and is not the production runner contract.
- JSON schema output should be normalized before it reaches AUN queue logic.

## Boundary Rules

Runtime adapters must not:

- call `next`, `receive-actionable`, `processing`, `done`, `reply`, `send`, or
  queue repair commands directly unless the adapter is itself the approved AUN
  runner surface for that operation
- parse or mutate `message_queue` state outside the runner API
- treat a successful LLM exit code as proof of final queue completion
- pass large work envelopes through argv
- use TUI text injection as the primary automation path
- invent a separate bot registry outside `agents`

Runtime adapters may:

- invoke a runtime-specific CLI or SDK
- stream or collect runtime events
- normalize output into the shared lifecycle result shape
- record runtime metadata such as session id, usage, model, and terminal reason

## State-Daemon Role

`state_daemon` remains a scheduler and observer:

- observe DB state
- plan actions from state and agent runtime
- invoke a configured runner adapter
- enforce duplicate suppression and active-claim guards
- report metrics and alerts

It must not format model prompts, parse model-specific output, or decide that a
runtime reply completed a request. Completion remains explicit through AUN
lifecycle and reply/close commands.

## Implementation Order

1. Keep the current `aun codex-runner` and `invoke_codex_runner` path as the
   first production-shaped implementation.
2. Add tests that pin Codex CLI invocation and output normalization before
   enabling live Codex execution beyond the current runner tick.
3. Add a Claude Code adapter as a separate runtime implementation behind the
   same normalized result contract.
4. Add fake-command adapter tests before live CLI tests.
5. Add opt-in live smoke tests for installed CLIs; CI should skip them by
   default.
6. Only after adapter smoke passes, allow `state_daemon` to schedule additional
   runtime adapters beyond Codex.

## Acceptance Criteria

- A runtime can receive one claimed work item without calling `inbox`.
- Codex and Claude can share the same logical envelope/result shape.
- Queue transitions are testable without invoking a live LLM.
- Live LLM tests are opt-in.
- Runtime timeouts leave a recoverable queue state.
- Final close is explicit and idempotent.
- Logs and metrics do not include full message bodies unless explicitly
  approved for a local diagnostic run.
