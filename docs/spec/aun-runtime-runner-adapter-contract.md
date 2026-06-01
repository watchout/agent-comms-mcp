# AUN Runtime Runner Adapter Contract

Date: 2026-06-01
Status: CP-40B implementation contract

## Purpose

AUN receive runners must use the same queue, conversation, baton, and turn
state machine regardless of whether the runtime is Codex, Claude Code,
OpenClaw, or another adapter.

Runtime-specific code may only own:

- process launch
- environment/argv construction
- stdin/stdout/stderr IO
- timeout handling
- parsing runtime output into the typed runner result

Runtime-specific code must not choose queue claim order, baton ownership,
close/no-reply/retry semantics, or recovery action.

## Invocation Shape

Every adapter receives one `RuntimeRunnerInvocation`:

- `contract_version`
- `runtime_kind`
- `agent_id`
- exact `queue_id`
- `message_id`
- `requester`
- `database_url`
- `ack_content`
- `queue_context`
- nullable `baton_context`

The exact `queue_id` is mandatory. An adapter must not drain FIFO rows to reach
the intended request.

## Result Shape

Every adapter returns one `RuntimeRunnerResult`:

- `ok`
- numeric `code`
- optional raw `stdout` / `stderr`
- typed `typed_result`

`typed_result` is the control-plane evidence used by deterministic code. Free
form runtime prose is not a lifecycle outcome.

## Current Implementation

The Codex adapter implements this contract first:

- `buildCodexRuntimeRunnerInvocation` normalizes legacy Codex runner input into
  the runtime-neutral contract.
- `buildCodexRunnerCommand` passes `--queue-id <id>` to `aun codex-runner`.
- `ExecFileCodexRunnerInvoker` parses stdout into `typed_result`.

Claude and future runtimes must implement the same contract before scheduler
activation. They may differ in launch command and output parser only.

## Required Tests

- Codex and Claude invocation shapes share the same normalized queue/baton
  contract.
- Codex runner command includes exact `--queue-id`.
- Adapter stdout is reduced to typed runner evidence.
- State daemon dispatch passes the row payload through the adapter boundary.
- Existing targeted receive and final close contracts remain green.
