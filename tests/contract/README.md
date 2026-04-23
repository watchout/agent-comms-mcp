# Contract tests — lightweight-redesign-v3

Contract tests for the spec v3 / ADR-001 lightweight redesign
(`iyasaka-arc/agent-comms-mcp/specs/review/2026-04-23-lightweight-redesign-v3.md`).

Each test is bound to a specific spec section and a specific PR in the rollout
chain. PR #1 ships the scaffold (this file + 8 test files); test_6 is executable
as the PR #1 merge gate, the other 7 are `describe.todo` stubs that are filled
in as each follow-up PR lands.

## Rollout chain

PR #1 (env flag + scaffold) → PR #2 (thin MCP) → PR #3 (receiver) →
webb-dev pilot → PR #4 (send) → PR #5 (orchestrator) → PR #6 (scripts).

## Test → spec § / PR mapping

| Test file | Spec §contract_test | Owner PR | Status after PR #1 |
| --- | --- | --- | --- |
| `test_1_receiver_alive.test.ts` | test_1 | PR #3 (receiver、silent_exit 核) | stub (`describe.todo`) |
| `test_2_inbound_e2e.test.ts` | test_2 | PR #6 (scripts) | stub (`describe.todo`) |
| `test_3_outbound_e2e.test.ts` | test_3 (+ CTO INFO-B: send-processor 死亡 recovery) | PR #4 (send) | stub (`describe.todo`) |
| `test_4_b2b_no_discord.test.ts` | test_4 | PR #4 (send) | stub (`describe.todo`) |
| `test_5_silent_exit_negative.test.ts` | test_5 | PR #3 (receiver、silent_exit 核) | stub (`describe.todo`) |
| `test_6_migration_dual_run.test.ts` | test_6 | **PR #1 (merge gate)** | **executable** ✅ |
| `test_7_mcp_tool_compat.test.ts` | test_7 (+ CTO INFO-B: stdio peer 切断中 DB ops) | PR #2 (thin MCP) | stub (`describe.todo`) |
| `test_8_orchestrator_respawn.test.ts` | test_8 | PR #5 (orchestrator) | stub (`describe.todo`) |

## test_6 (PR #1 merge gate) — what it covers

`test_6_migration_dual_run.test.ts` verifies the spec v3 §3 migration path:

- **(a)** server.ts with `AGENT_COM_LEGACY_DISCORD_GATEWAY=1` enters the legacy
  Discord init block; stderr does not emit the "disabled" log.
- **(b)** server.ts with `AGENT_COM_LEGACY_DISCORD_GATEWAY=0` skips the block;
  stderr emits `agent-comms: AGENT_COM_LEGACY_DISCORD_GATEWAY=0, legacy Discord
  WebSocket disabled`.
- **(c)** Partial unique index `uq_agent_messages_discord_id` dedups a second
  INSERT of the same `discord_message_id`, leaving exactly 1 row.
- **(d)** The inferior (child) process that attempted the duplicate INSERT
  logs a duplicate-key / UNIQUE constraint error on stderr.

Mock Discord delivery is simulated via direct `agent_messages` INSERTs; real
Discord clients are forbidden for this test (§3.5). The DB backend is SQLite
(default), exercised via a fresh temp DB per run. The test is bound to a
30-second budget (§4.1).
