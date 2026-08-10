import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR } from '../../../bin/state-daemon'

const REPO = join(import.meta.dir, '..', '..', '..')
const ENTRY = join(REPO, 'bin', 'state-daemon.ts')
const UNREACHABLE_DATABASE_URL = 'postgresql://127.0.0.1:1/argv_must_fail_before_connect?connect_timeout=1'

describe('state-daemon direct entry rejects diagnostic argv before DB effects', () => {
  test.each([
    ['status', '--json'],
    ['queue-readiness', '--agent-id', 'codex-audit', '--json'],
  ])('%p exits nonzero with canonical CLI guidance, not a connection error', (...argv) => {
    const child = spawnSync(process.execPath, [ENTRY, ...argv], {
      cwd: REPO,
      env: {
        ...process.env,
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
      },
      encoding: 'utf8',
      timeout: 5_000,
    })

    expect(child.error).toBeUndefined()
    expect(child.status).not.toBe(0)
    expect(child.signal).toBeNull()
    expect(child.stderr).toContain(STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR)
    expect(child.stderr).toContain('bun cli/index.ts state-daemon readiness --format json')
    expect(child.stderr).toContain(
      'bun cli/index.ts state-daemon queue-readiness --agent-id <id> --format json',
    )
    expect(child.stderr).not.toMatch(/ECONNREFUSED|connect ECONN|Connection refused/i)
  })
})
