# AUN Host Runtime Invocation Adapter Contract

Date: 2026-06-01
Status: proposed CP-40D implementation contract
Issue: https://github.com/watchout/agent-comms-mcp/issues/644

## Purpose

CP-40B defines the runtime-neutral runner adapter boundary. This contract
defines the host CLI invocation layer below that boundary.

AUN must not use live TUI prompt injection as the primary receive, restart,
audit, or recovery path. The control plane should invoke supported runtimes
through explicit command adapters, pass bounded structured inputs, parse
structured event/result streams, and write typed evidence back to AUN.

Runtime-specific host adapters may own:

- feature detection for the installed runtime CLI
- argv and environment construction
- stdin/file prompt delivery
- stdout/stderr/event stream parsing
- timeout and process termination
- degraded fallback evidence

Runtime-specific host adapters must not own:

- queue claim order
- baton ownership
- turn ledger lifecycle
- completion outcome semantics
- retry/quarantine policy
- governance bypass, merge authorization, or Discord/state daemon activation

## Local Research Snapshot

This contract is based on the issue #644 research packet and a local CLI check
on 2026-06-01:

- `codex-cli 0.135.0`: `codex exec --help` includes `--json`,
  `--output-schema`, `--output-last-message`, `--sandbox`, `--cd`,
  `--add-dir`, `--ephemeral`, `--ignore-user-config`, and `--ignore-rules`.
- `Claude Code 2.1.159`: `claude --help` includes `-p/--print`,
  `--output-format stream-json`, `--json-schema`, `--input-format
  stream-json`, `--permission-mode`, `--allowedTools`, `--disallowedTools`,
  `--mcp-config`, `--strict-mcp-config`, `--bare`,
  `--no-session-persistence`, and `--max-budget-usd`.

These CLIs change quickly. Implementations must feature-detect the actual
installed executable at runtime and must not rely only on this snapshot.

## Data Shapes

### RuntimeInvocationProfile/v1

```ts
type RuntimeInvocationProfile = {
  profile_id: string
  runtime: 'codex' | 'claude' | 'custom'
  runtime_version_detected?: string
  cwd: string
  allowed_dirs: string[]
  prompt_delivery: 'stdin-json' | 'stdin-text' | 'prompt-arg' | 'session-resume'
  output_stream: 'jsonl' | 'json' | 'text'
  final_output_schema_ref?: string
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' | 'host-specific'
  approval_mode?: string
  allowed_tools?: string[]
  disallowed_tools?: string[]
  mcp_config_ref?: string
  env_allowlist: string[]
  secret_policy: 'none' | 'single-invocation-env' | 'external-secret-store'
  max_turns?: number
  max_budget_usd?: number
  timeout_ms: number
  degraded_tui_fallback_allowed: boolean
}
```

### RuntimeRunnerInvocation/v1

This envelope is the host adapter input. It is created by deterministic runner
code after CP-40A/CP-40B receive selection and before the runtime process is
launched.

```ts
type RuntimeRunnerInvocation = {
  invocation_id: string
  queue_id?: number
  message_id?: string
  agent_id: string
  task_kind: 'receive' | 'reply' | 'audit' | 'restart' | 'recovery' | 'maintenance'
  trusted_instruction: string
  policy_refs: string[]
  untrusted_context_refs: string[]
  context_pack_refs: string[]
  expected_result_schema_ref: string
  runtime_profile_ref: string
}
```

`trusted_instruction` is control-plane-authored text. Queue bodies, GitHub issue
or PR bodies, commit messages, tool output, retrieved docs, and Discord/chat
content are untrusted context and must be passed through files/stdin with
provenance, not interpolated into shell commands.

### RuntimeRunnerResult/v1

```ts
type RuntimeRunnerResult = {
  invocation_id: string
  runtime: string
  exit_status: number
  started_at: string
  finished_at: string
  final_message?: string
  final_structured_result?: unknown
  schema_valid: boolean
  event_counts: Record<string, number>
  tool_calls: Array<{ name: string; status: string; redacted_args_hash?: string }>
  file_changes?: Array<{ path: string; action: string }>
  degraded: boolean
  degradation_reasons: string[]
}
```

This result is evidence for deterministic completion code. Free-form stdout or
runtime prose is not a lifecycle decision.

## Invariants

1. A host runtime adapter must receive a `RuntimeInvocationProfile/v1` and a
   `RuntimeRunnerInvocation/v1` before launching a process.
2. The adapter must build argv as an argument array. It must not interpolate
   untrusted context into a shell string, environment variable name, file path,
   branch name, command flag, or prompt argument.
3. `trusted_instruction`, policy references, task metadata, untrusted context,
   and expected result schema must remain separate until the runtime boundary.
4. Structured output is the primary success path. If the requested schema is
   missing, malformed, or unsupported, the adapter fails closed unless an
   explicit degraded mode is allowed for that task.
5. Feature detection is mandatory. Unsupported required flags fail closed;
   unsupported optional flags may downgrade only with `degraded: true` and a
   stable degradation reason.
6. Default privilege is least privilege: read-only sandbox unless the task
   profile explicitly requires writes. `danger-full-access` requires explicit
   profile evidence and is never implied by runtime kind.
7. Secrets may enter the runtime only through `env_allowlist` and the selected
   `secret_policy`. The result must record the redacted env policy, not secret
   values.
8. Timeouts are mandatory. A timeout produces typed evidence and must not be
   reported as a schema-valid runtime success.
9. Non-zero exit, malformed JSON/JSONL, missing final message, and schema
   mismatch are typed parser outcomes, not free-form stderr summaries.
10. TUI prompt injection is compatibility fallback only. It must set
    `degraded: true`, record `degradation_reasons`, and must not count as a
    successful scheduler activation, recovery, merge authorization, or final
    delivery proof.
11. The adapter result must record command evidence: runtime executable,
    version detection result, redacted argv, schema hash/ref, stream parser
    outcome, event counts, tool call names/statuses, timeout, and degraded
    fallback reason.
12. The adapter must never authorize queue final close, baton transfer,
    retry/quarantine, state daemon restart, Discord activation, dangerous tool
    approval, or PR merge. It only returns evidence to deterministic code.

## Runtime Mapping

### Codex

The Codex adapter must prefer non-interactive structured execution:

```bash
codex exec --json --output-schema <schema-file> --output-last-message <file> \
  --sandbox <mode> --cd <cwd> [--add-dir <dir>...] [--ephemeral] -
```

Rules:

- Pass the invocation envelope through stdin or a profile-managed JSON file.
- Use `--json` as the event stream when available.
- Use `--output-schema` for final structured result validation when available.
- Use `--output-last-message` to capture final prose as evidence only.
- Use `--ignore-user-config` and `--ignore-rules` only when the profile requires
  hermetic execution; missing support must be feature-detected.
- Map AUN sandbox values to Codex `--sandbox` values explicitly:
  `read-only`, `workspace-write`, or `danger-full-access`.

### Claude Code

The Claude adapter must prefer non-interactive structured execution:

```bash
claude -p --output-format stream-json --json-schema '<schema-json>' \
  --permission-mode <mode> --allowedTools '<rules>' --disallowedTools '<rules>' \
  --mcp-config <config> --strict-mcp-config [--bare] '<trusted-prompt>'
```

Rules:

- The prompt argument may contain only control-plane-authored trusted
  instructions and references. Untrusted context must be delivered through
  stdin/files with provenance or through an MCP/tool context that preserves
  trust labels.
- Use `--output-format stream-json` as the primary event stream.
- Use `--json-schema` for the final structured result contract.
- Use `--input-format stream-json` when the profile requires streaming input.
- Use `--bare`, `--no-session-persistence`, and `--strict-mcp-config` when the
  profile requires hermetic execution and the installed CLI supports them.
- Map AUN sandbox/approval policy to Claude `--permission-mode`,
  `--allowedTools`, `--disallowedTools`, and MCP config constraints explicitly.

### Custom Runtimes

Custom runtimes must implement the same profile, invocation, and result shapes.
They may use different launch commands, but they must still provide feature
detection, structured output parsing, typed failure evidence, and the same
least-privilege/security invariants.

## Failure Codes

Implementations must surface stable codes for these failure classes:

- `RUNTIME_PROFILE_REQUIRED`
- `RUNTIME_PROFILE_INVALID`
- `UNSUPPORTED_RUNTIME`
- `RUNTIME_EXECUTABLE_NOT_FOUND`
- `RUNTIME_VERSION_UNSUPPORTED`
- `RUNTIME_FLAG_UNSUPPORTED`
- `SCHEMA_REQUIRED`
- `SCHEMA_LOAD_FAILED`
- `OUTPUT_SCHEMA_MISMATCH`
- `STREAM_PARSE_ERROR`
- `FINAL_MESSAGE_MISSING`
- `RUNTIME_TIMEOUT`
- `RUNTIME_NONZERO_EXIT`
- `UNSAFE_ARGV_CONTEXT`
- `SECRET_POLICY_VIOLATION`
- `SANDBOX_POLICY_VIOLATION`
- `TUI_FALLBACK_NOT_ALLOWED`
- `DEGRADATION_NOT_RECORDED`

### State-daemon failure disposition and row fairness

The host adapter gate runs before a runtime process exists. A failure returned
by this gate is therefore a deterministic admission/configuration failure, not
a provider attempt. The state daemon must classify the following prelaunch
codes as `retryable=false`:

- `RUNTIME_PROFILE_REQUIRED`
- `RUNTIME_PROFILE_INVALID`
- `UNSUPPORTED_RUNTIME`
- `RUNTIME_INVOKER_UNCONFIGURED`
- `RUNTIME_FLAG_UNSUPPORTED`
- `SCHEMA_REQUIRED`
- `SANDBOX_POLICY_VIOLATION`

The same non-retryable disposition applies after launch to parser evidence that
cannot change without a new invocation: `OUTPUT_SCHEMA_MISMATCH`,
`STREAM_PARSE_ERROR`, and `FINAL_MESSAGE_MISSING`. `RUNTIME_TIMEOUT` and
`RUNTIME_NONZERO_EXIT` remain retryable because external runtime/provider state
may change. This classification is deterministic code; stderr prose must not
choose retryability.

For a non-retryable host-runtime failure on a still-`pending` row, the daemon
must perform one compare-and-set terminal transition:

- `status='failed'`
- `failed_reason=<exact failure code>`
- `done_at=<failure timestamp>`
- claim and heartbeat fields cleared
- `runner_error.retryable=false` with runtime/profile, invocation source,
  failure timestamp, and exact pending-row fence
- `queue_work_runner_error_recovery.attempts=0`, `max_reclaims=0`, and
  `last_action='failed_non_retryable'`

The transition is a typed failure, not `done`, `replied`, or a successful
fallback. It must not launch a runtime process and must not expose secret
configuration values in the durable detail. A compare-and-set miss is recorded
as a stale skip and must not overwrite a newer lifecycle state.

The stale-row sweep owns row fairness. Terminalizing one deterministic failure
must return control to the same sweep so subsequent rows in the fetched batch
are evaluated. A terminal row is not eligible for a later stale-pending sweep,
and the agent-level duplicate-suppression reservation is released so another
row for that agent is not blocked by the failed row. Alert delivery is
observability only and must not turn this expected typed result into a thrown
sweep-wide failure.

## Tests Required For Implementation

1. Profile validation rejects missing `profile_id`, unsupported runtime,
   missing `cwd`, empty env allowlist policy, and non-positive timeout.
2. Codex command builder emits an argv array containing `codex`, `exec`,
   `--json`, `--output-schema`, `--output-last-message`, `--sandbox`, `--cd`,
   and `-` for stdin prompt delivery.
3. Claude command builder emits an argv array containing `claude`, `-p`,
   `--output-format`, `stream-json`, `--json-schema`, `--permission-mode`, and
   the configured MCP/tool constraints.
4. User-controlled queue body, GitHub issue body, branch name, commit message,
   and retrieved docs do not appear as shell command text or argv flags.
5. Feature detection fails closed when a required flag is absent.
6. Optional unsupported flags downgrade only with `degraded: true` and a stable
   degradation reason.
7. Codex JSONL parser records event counts, final message evidence, schema
   validity, non-zero exit, malformed JSONL, missing final message, and timeout.
8. Claude stream-json parser records event counts, tool call names/statuses,
   final structured result, schema validity, malformed stream events, non-zero
   exit, missing final result, and timeout.
9. Schema mismatch returns `schema_valid: false` and does not advance lifecycle.
10. Secret policy tests prove only allowlisted env names are passed and values
    are redacted from evidence.
11. TUI fallback tests prove fallback result is degraded and cannot be accepted
    for scheduler activation, recovery success, merge authorization, or final
    delivery proof.
12. Existing CP-40B adapter tests remain compatible: queue/baton context shape,
    exact `queue_id`, and typed runner result are unchanged.
13. Missing schema/output-last-message configuration terminalizes the exact
    pending row once as `failed` / `SCHEMA_REQUIRED`, persists
    `retryable=false`, and launches no runtime process.
14. A second stale pending row in the same batch is still evaluated after the
    first row is terminalized for `SCHEMA_REQUIRED`.
15. A second sweep does not retry or re-alert the terminalized row.
16. Timeout and non-zero runtime exits remain pending/retryable and are not
    collapsed into deterministic configuration failure.

## Implementation Plan

1. Add pure profile validation and command builder helpers for Codex and Claude.
2. Add feature detection helpers that parse `--help` output into supported flag
   sets and runtime version evidence.
3. Add parsers for Codex JSONL and Claude stream-json event streams.
4. Add typed failure/result mapping for timeout, non-zero exit, malformed stream,
   missing final result, and schema mismatch.
5. Wire the helpers into the CP-40B adapter implementation behind a disabled or
   explicit profile gate.
6. Keep TUI injection as degraded fallback only for legacy profiles.

Implementation tests should use fixture executables and recorded event streams.
CI must not depend on live model calls.

## Non-Goals

- This contract does not enable scheduler activation.
- This contract does not reconnect Discord or declare production recovery.
- This contract does not implement CP-50 turn ledger tables or CP-60 completion
  outcome tables.
- This contract does not grant an LLM authority over queue close, baton
  transfer, retry/quarantine, merge, or restart.
- This contract does not require real Codex or Claude model calls in CI.

## Acceptance

- AUN has a documented host CLI invocation profile for Codex, Claude, and custom
  runtimes.
- The preferred Codex path is `codex exec --json --output-schema`.
- The preferred Claude path is `claude -p --output-format stream-json
  --json-schema`.
- Unsupported flags, malformed streams, schema mismatch, timeout, and non-zero
  exit become typed evidence.
- Untrusted context cannot alter shell argv or bypass runtime policy.
- TUI injection remains available only as degraded compatibility evidence.

## Governance

This docs-only contract is a proposed implementation contract and does not
change runtime behavior. It is suitable for normal spec audit/merge.

Later implementation PRs that add code only to command builders/parsers can use
the normal code audit route. Later PRs that enable scheduler activation,
production Discord traffic, dangerous sandbox profiles, or lifecycle state
mutation from runtime results require the applicable operational approval route.
