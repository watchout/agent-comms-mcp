# Destructive migration env flag — operational policy

> **Anchor**: [incident #339](https://github.com/watchout/agent-comms-mcp/issues/339)
> (2026-05-11 09:18-09:22 JST cascade) — `bun db/migrate.ts` from a dev-bot
> session ran `DROP COLUMN failed_reason` against the production DB and
> took every bot offline. PR #340 introduced a fail-closed gate at the SQL
> entry points; this document is its operational sibling. It is the SSOT
> for **where the env flag is allowed to be set, where it is forbidden,
> and how to flip it during a real deploy.**

## env flag overview

The flag is `AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED`. When the value is
exactly the string `'1'`, `db/migrate.ts` and `db/migrate-sqlite.ts` let
destructive SQL through (`DROP COLUMN`, `ALTER COLUMN`, `RENAME`,
`TRUNCATE`, `DROP TABLE`). Any other value — unset, empty, `'true'`, etc.
— means the gate blocks the statement and throws
`DestructiveMigrationBlockedError`. The check is strict (`=== '1'`) by
design (PR #340 spec §3.1).

Both backends import the same helper, share the same detection table, and
throw the same error type (PR #340 spec §1.5 adapter-symmetry invariant),
so the policy described in this document applies equally to the postgres
and the sqlite migrate paths.

## Where to set

**Production deploy launchd plist — only.**

Concretely, the `EnvironmentVariables` block of
`~/Library/LaunchAgents/<bot>.plist` on the production host(s) that own
the migration step. Setting the flag here keeps it scoped to the
production daemon process; it never reaches any dev-bot Claude Code
session, never reaches an interactive shell, and never reaches a CI job.

No other location is allowed. There is no global config.json key, no env
inheritance from a parent process, and no `.env*` file participating in
this flag.

## Where NOT to set

The following locations are **forbidden** even temporarily:

- **dev-bot launchd plists** (any of the 15 dev-bot agents)
- **interactive shells** (`export AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1`
  in zshrc / a terminal / a tmux pane)
- **`.env` / `.env.local` / `.env.example` / any `.env*` file** in this
  repo or any dependent repo
- **`config.json`** (the agent-comms-mcp config schema deliberately has
  no key for this flag)
- **CI environment** (GitHub Actions, local pre-commit, etc.)
- **process spawn via a dev-bot wrapper** that would re-export it to a
  child migration step

If a dev session legitimately needs to exercise destructive SQL, the
correct path is to point at an isolated dev database (Task B — see
[Issue #339](https://github.com/watchout/agent-comms-mcp/issues/339)
sub-task 2), not to grant the dev bot access to the gate.

**Why so strict?** Incident #339 happened because the dev-bot session
held the production `DATABASE_URL`. The `migrate.ts` step had no gate
and ran a destructive statement; the gate added in PR #340 only helps
if dev-bot environments cannot opt themselves into the bypass. That is
why the flag policy is fail-closed: anything other than an explicit set
on the production launchd plist counts as "do not allow."

## Operational checklist

When a destructive migration genuinely needs to ship to production:

1. **Confirm scope.** The migration must be paired (e.g. a
   `db/migrations/*.up.sql` plus `*.down.sql`) and reviewed under
   `route:ceo-approval`.
2. **Edit the production launchd plist** on the host that runs
   `bun db/migrate.ts`. Add (or confirm) the entry:

   ```xml
   <key>AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED</key>
   <string>1</string>
   ```

3. **Reload the agent**:

   ```sh
   launchctl unload ~/Library/LaunchAgents/<bot>.plist
   launchctl load ~/Library/LaunchAgents/<bot>.plist
   ```

4. **Verify the gate logged its state**: the daemon emits
   `[migrate] destructive migrations: ALLOWED (env)` at startup (PR #340
   §2.5). If it logs `BLOCKED (default, dev-bot safe)` instead, the flag
   did not reach the process — stop and investigate before re-running
   the migration.
5. **Run the migration** (`bun db/migrate.ts` on the production host).
6. **Roll back the flag** as soon as the migration step is complete:
   remove the env entry from the plist, unload + reload, and verify the
   startup log goes back to `BLOCKED`. The flag is not meant to be a
   long-lived setting.

For `route:ceo-approval` migrations, steps 1, 4, and 6 are not optional —
log the boot-line evidence in the merge thread (PR #340 post-merge
verification anchor).

## Related references

- [Issue #339](https://github.com/watchout/agent-comms-mcp/issues/339)
  — original incident report (2026-05-11)
- [PR #340](https://github.com/watchout/agent-comms-mcp/pull/340) — the
  fail-closed gate this document operationalizes (state machine, strict
  `'1'` compare, detection table, adapter symmetry)
- [PR #341](https://github.com/watchout/agent-comms-mcp/pull/341) —
  Task A: `agent.runtime` default flip to `'TUI'` (incident #339 sibling
  hotfix)
- `~/.claude/rules/governance-flow.md` §"Post-merge 全方位検証" — why a
  destructive migration always carries explicit boot-log evidence
  through the merge thread

## See also (forthcoming)

- **S1** — bot startup audit log of the gate state (separate PR, drafting)
- **Task B** — dev-DB separation so dev-bot sessions never see a
  production `DATABASE_URL` in the first place
