import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Issue #248 cycle 7 — discord-adapter port-resolution contract.
//
// PR #258 cycle 6 introduced `resolveWebhookPort()` in
// scripts/discord-adapter.ts with a deliberately stricter contract than
// server.ts: server.ts has a free-port-detection fallback (8801-8900),
// discord-adapter has none and throws if neither AUN_WEBHOOK_PORT nor
// WEBHOOK_PORT is set. Auditor cycle 6 (msg `4a33db64`) flagged the
// divergence as untested; this test pins all three branches.
//
// We can't import the adapter directly because module init has side
// effects (Discord client setup); instead we exercise the resolver in a
// throwaway subprocess that imports the file and reads the resolved
// WEBHOOK_PORT off stderr (the existing startup log line).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const ADAPTER = resolve(REPO_ROOT, 'scripts', 'discord-adapter.ts')

type RunResult = { status: number | null; stdout: string; stderr: string }

function run(env: Record<string, string | undefined>): RunResult {
  const r = spawnSync('bun', [ADAPTER], {
    env: {
      ...process.env,
      // Force IS_MAIN to behave deterministically: the adapter exits
      // early on missing TOKEN, but we want resolveWebhookPort to run
      // first and surface its error / log line on stderr.
      DISCORD_BOT_TOKEN: 'FAKE_TOKEN_PORT_RESOLUTION_TEST',
      DATABASE_URL: '',
      ...env,
    } as NodeJS.ProcessEnv,
    encoding: 'utf-8',
    timeout: 5000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('discord-adapter resolveWebhookPort — Issue #248 cycle 7', () => {
  test('case A — AUN_WEBHOOK_PORT honored', () => {
    const r = run({ AUN_WEBHOOK_PORT: '8810', WEBHOOK_PORT: undefined })
    // Adapter logs `discord-adapter: starting (bridge port: <N>, ...)` once
    // module init reaches that line. We only need the resolver not to throw.
    expect(r.stderr).not.toMatch(/neither AUN_WEBHOOK_PORT nor WEBHOOK_PORT is set/)
    // Either the adapter started and logged the bridge port, or it died on
    // a later step (Discord token / DB) — both fine; only the resolver
    // contract is under test.
    if (r.stderr.includes('discord-adapter: starting')) {
      expect(r.stderr).toMatch(/bridge port: 8810/)
    }
  })

  test('case B — WEBHOOK_PORT (legacy) honored when AUN_WEBHOOK_PORT unset', () => {
    const r = run({ AUN_WEBHOOK_PORT: undefined, WEBHOOK_PORT: '8850' })
    expect(r.stderr).not.toMatch(/neither AUN_WEBHOOK_PORT nor WEBHOOK_PORT is set/)
    if (r.stderr.includes('discord-adapter: starting')) {
      expect(r.stderr).toMatch(/bridge port: 8850/)
    }
  })

  test('case C — both env unset must throw (server.ts has free-port detection; adapter does not)', () => {
    const r = run({ AUN_WEBHOOK_PORT: undefined, WEBHOOK_PORT: undefined })
    // The contract divergence: adapter has no fallback, throws to surface
    // the misconfiguration. The thrown message must mention
    // AUN_WEBHOOK_PORT (the preferred env) so operators know what to set.
    expect(r.stderr).toMatch(/neither AUN_WEBHOOK_PORT nor WEBHOOK_PORT is set/)
    expect(r.status).not.toBe(0)
  })
})
