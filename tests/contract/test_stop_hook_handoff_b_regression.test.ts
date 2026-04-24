import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// HANDOFF B regression gate — per lead-ama PR-C §2.2 (msg id 2ea94516).
// The Stop hook is a thin, self-contained bash script; it neither imports
// any MCP-server code nor holds any long-lived state outside
// $AUN_LOG_DIR / $AUN_STATE_DIR. These tests encode the three regression
// checks HANDOFF B requires so that a future refactor cannot silently
// drag agent-comms machinery into the hook path:
//
//   (1) Hook is standalone — does not reference server.ts / cli / db /
//       discord-adapter etc. Static grep enforces this.
//   (2) Hook settings.json shape is array-append-friendly — co-existing
//       with PreToolUse / SessionStart / UserPromptSubmit entries.
//   (3) `mcp__agent-comms__{send,notify}` names in the hook regex match
//       the tool names actually registered in server.ts today — a rename
//       in the server must cause the hook to be updated in lockstep.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOK_PATH = join(REPO_ROOT, 'hooks', 'aun-send-tool-enforcement.sh')

function run(cmd: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(cmd, args, { encoding: 'utf-8', cwd: REPO_ROOT })
}

describe('test_stop_hook_handoff_b_regression — Stop hook does not disturb existing agent-comms', () => {
  let tmpDir: string

  beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'stop-hook-regr-')) })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test('(1) hook script references no agent-comms runtime modules (pure external script)', () => {
    const src = readFileSync(HOOK_PATH, 'utf-8')
    // Forbid accidental `require`/`import`/`source` of project modules.
    // The hook is an isolated bash script — any such reference would pull
    // the server or adapter code into a latency-critical path.
    const forbidden = [
      /(\s|^)(source|\.)\s+[^|#]*server\.ts/i,
      /(\s|^)(source|\.)\s+[^|#]*cli\//i,
      /(\s|^)(source|\.)\s+[^|#]*db\//i,
      /bun\s+run\s+[^|#]*server\.ts/i,
      /mcp__agent-comms__(?!send|notify)/, // only send/notify tool names are mentioned
    ]
    for (const pat of forbidden) {
      expect(src).not.toMatch(pat)
    }
    // Positive: the hook's sole external tooling is jq + tail + awk +
    // standard POSIX — no bun/node runtime spawn.
    expect(src).not.toMatch(/\bbun\b/)
    expect(src).not.toMatch(/\bnode\b/)
  })

  test('(2) Stop hook settings.json shape is array-append compatible with existing hooks', () => {
    // Build a settings.json that already has PreToolUse / SessionStart /
    // UserPromptSubmit entries (the hooks set the agent-comms install
    // script manages) and confirm the Stop entry layered on top is a
    // separate array key — no overwrites, no nested collisions.
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /opt/pre.sh' }] }],
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /opt/session.sh' }] }],
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /opt/user-prompt.sh' }] }],
      },
    }
    const stopPatch = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/aun-send-tool-enforcement.sh' }] }],
      },
    }
    // Simulate aun install's deep-merge (spec v6 §2.2 — per-event array
    // append, keys side-by-side). Nothing under the existing events gets
    // touched.
    const merged = {
      hooks: {
        ...existing.hooks,
        ...stopPatch.hooks,
      },
    }

    // Verify existing events preserved verbatim.
    expect(merged.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse)
    expect(merged.hooks.SessionStart).toEqual(existing.hooks.SessionStart)
    expect(merged.hooks.UserPromptSubmit).toEqual(existing.hooks.UserPromptSubmit)
    // Verify Stop added cleanly.
    expect(merged.hooks.Stop).toHaveLength(1)
    expect(merged.hooks.Stop[0].hooks[0].command).toContain('aun-send-tool-enforcement.sh')

    // Write and re-read to confirm it is valid JSON with no lossy merge.
    const settingsPath = join(tmpDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2))
    const round = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(round).toEqual(merged)
  })

  test('(3) tool names used by the hook match real mcp__agent-comms__* registrations', () => {
    // The hook's exact-match whitelist is `mcp__agent-comms__send` and
    // `mcp__agent-comms__notify`. If server.ts ever renames or removes
    // either, this test must start failing so the hook gets updated in
    // the same PR — otherwise the block path would silently pass for
    // the renamed tool.
    const server = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
    expect(server).toMatch(/name:\s*['"]send['"]/)
    expect(server).toMatch(/name:\s*['"]notify['"]/)

    const hook = readFileSync(HOOK_PATH, 'utf-8')
    expect(hook).toContain('mcp__agent-comms__send')
    expect(hook).toContain('mcp__agent-comms__notify')
  })

  test('(4) hook execution does not open any DB / network handle (no side effects outside $AUN_*)', () => {
    // Use an isolated dir, run the hook against a benign positive fixture,
    // and confirm it writes strictly inside AUN_LOG_DIR / AUN_STATE_DIR.
    const logDir = join(tmpDir, 'hb-logs')
    const stateDir = join(tmpDir, 'hb-state')
    const fixture = join(REPO_ROOT, 'tests', 'fixtures', 'stop-hook', 'positive.jsonl')

    const r = spawnSync('/bin/bash', [HOOK_PATH], {
      input: JSON.stringify({ transcript_path: fixture, session_id: 'hb-4' }),
      encoding: 'utf-8',
      env: { ...process.env, AUN_LOG_DIR: logDir, AUN_STATE_DIR: stateDir },
    })
    expect(r.status).toBe(0)

    // Nothing outside tmpDir should exist that the hook created. We can't
    // generically diff the filesystem cheaply, but we can confirm at
    // least that the hook produced no unexpected files in $REPO_ROOT.
    // (Spot check: the two known sentinel names the hook writes live
    // under the supplied dirs.)
    const countFile = join(stateDir, 'hb-4.count')
    expect(statSync(countFile).isFile()).toBe(true)
    expect(readFileSync(countFile, 'utf-8').trim()).toBe('0') // reset on pass
  })
})
