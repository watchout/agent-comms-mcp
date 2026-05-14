# codex-aun MCP Surface

Status: scaffold
Date: 2026-05-14

This document records the first runtime adapter surface for `codex-aun`.

The goal is to make Codex and Claude Code peers over the same AUN MCP lifecycle. Runtime adapters differ in how they inject prompts and manage local sessions, not in the DB lifecycle tools they call.

## Names

```text
codex-aun   Codex runtime adapter / agent identity
claude-aun  Claude Code runtime adapter counterpart
aun         shared MCP service name
```

## Shared MCP Lifecycle

Both runtime adapters call the same tool surface:

```text
aun.inbox
aun.processing
aun.send
aun.done
aun.notify
aun.status
```

The existing implementation may expose unprefixed MCP tool names (`inbox`, `processing`, `done`, etc.) while the adapter profile records the public `aun.*` naming convention.

## Codex Runner Boundary

The Codex runner is planned as:

```text
poll aun.inbox
mark aun.processing
render prompt for Codex
call aun.send when replying
call aun.done when handled without reply
```

The runner must not own state-daemon behavior. state_daemon remains a DB observer and recovery layer.

## Source Layout

```text
runtime/
  types.ts
  codex-aun/
    adapter.ts
    mcp-profile.ts
    runner.ts
  claude-aun/
    adapter.ts
    mcp-profile.ts
```

This is intentionally a skeleton. It gives later implementation PRs a stable place to attach Codex-specific MCP setup and runner behavior without mixing it into chat adapters or state_daemon.

