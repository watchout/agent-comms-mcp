import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap } from '../../bin/aun/bootstrap'
import type { BootstrapExecutionPorts } from '../../bin/aun/bootstrap-types'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('aun bootstrap clean-host journal', () => {
  test('real CLI dry-run reaches PLANNED on a clean host and leaves no files', () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-plan-host-'))
    roots.push(home)
    const stubDir = join(home, 'bin')
    mkdirSync(stubDir)
    const stub = (name: string, body: string) => {
      const path = join(stubDir, name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`)
      chmodSync(path, 0o755)
    }
    stub('git', 'case "$*" in "rev-parse HEAD") echo c8eb30805a587a65a794499fa597935f2460c703;; "--version") echo "git version 2.50.0";; esac')
    stub('node', 'echo v20.20.0')
    stub('tmux', 'echo clean-host-session')
    stub('launchctl', 'exit 0')
    stub('codex', 'echo codex-cli 1.0.0')
    stub('ps', 'exit 1')
    stub('lsof', 'exit 1')
    const dbPath = join(home, 'agent-com.db')
    const result = Bun.spawnSync([
      process.execPath, 'bin/aun.ts', 'bootstrap', '--agent-id', 'clean-plan', '--runtime', 'codex', '--dry-run', '--json',
    ], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        HOME: home,
        AUN_HOME: join(home, '.aun'),
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: dbPath,
        CODEX_SANDBOX: 'workspace-write',
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: 'PLANNED', resolved_runtime: 'codex' })
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(join(home, '.aun')) ? readdirSync(join(home, '.aun')) : []).toEqual([])
  })

  test('writes only a mode-0600 redacted run record beneath AUN_HOME/bootstrap', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-clean-'))
    roots.push(home)
    const pass = async () => ({ ok: true })
    const ports: BootstrapExecutionPorts = {
      lockAndSnapshot: pass,
      dependencyPreflight: async () => ({ ok: true, resolvedRuntime: 'codex', evidenceRefs: ['token=must-not-leak'] }),
      migrateDatabase: pass, ensureAgentProfile: pass, ensureMcpRegistration: pass,
      ensureMemoryReadiness: pass, installAndStartDaemon: pass, runQueueSmoke: pass,
      readbackReady: pass, rollbackMutation: pass,
    }
    const result = await bootstrap({
      agentId: 'clean-host', runtime: 'codex', home, repoRoot: process.cwd(),
      env: { HOME: home, AUN_HOME: join(home, '.aun'), DISCORD_BOT_TOKEN: 'super-secret-value' },
    }, { ports, run: async () => ({ exitCode: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' }) })
    expect(result.status).toBe('READY')
    const path = join(home, '.aun', 'bootstrap', 'clean-host', `${result.run_id}.json`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const body = readFileSync(path, 'utf8')
    expect(body).not.toContain('super-secret-value')
    expect(body).not.toContain('must-not-leak')
  })
})
