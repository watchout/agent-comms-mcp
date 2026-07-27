import { describe, expect, test } from 'bun:test'
import { bootstrap } from '../../bin/aun/bootstrap'
import type { BootstrapExecutionPorts, BootstrapStageOutcome } from '../../bin/aun/bootstrap-types'
import { MemoryBootstrapStateStore } from '../../core/aun-bootstrap-state'

describe('aun bootstrap idempotency', () => {
  test('second identical successful run performs only fresh B1 identity and B8 readback', async () => {
    const store = new MemoryBootstrapStateStore()
    const calls: string[] = []
    const pass = (name: string, result: BootstrapStageOutcome = { ok: true }) => async () => { calls.push(name); return result }
    const ports: BootstrapExecutionPorts = {
      lockAndSnapshot: pass('B0'), dependencyPreflight: pass('B1', { ok: true, resolvedRuntime: 'codex' }),
      migrateDatabase: pass('B2', { ok: true, mutation: {
        kind: 'db', owner_key: 'db:first-run', before_digest: null, intended_after_digest: 'after', actual_after_digest: 'after', rollback_action: 'fixture',
      } }), ensureAgentProfile: pass('B3'), ensureMcpRegistration: pass('B4'),
      ensureMemoryReadiness: pass('B5'), installAndStartDaemon: pass('B6'), runQueueSmoke: pass('B7'),
      readbackReady: pass('B8'), rollbackMutation: pass('rollback'),
    }
    const run = async (command: string, args: string[]) => command === 'codex' && args.join(' ') === 'mcp get wasurezu --json'
      ? { exitCode: 1, stdout: '', stderr: 'not configured' }
      : { exitCode: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' }
    const input = { agentId: 'idempotent-agent', runtime: 'codex' as const, home: '/tmp/idempotent', repoRoot: process.cwd(), env: { HOME: '/tmp/idempotent' } }
    const first = await bootstrap(input, { stateStore: store, ports, run })
    expect(first.status).toBe('READY')
    calls.length = 0
    const second = await bootstrap(input, { stateStore: store, ports, run })
    expect(second.status).toBe('IDEMPOTENT_READY')
    expect(calls).toEqual(['B1', 'B8'])
    expect(second.mutation_manifest_sha256).not.toBe(first.mutation_manifest_sha256)
    expect(second.mutation_manifest_sha256).toBeDefined()
    calls.length = 0
    const third = await bootstrap(input, { stateStore: store, ports, run })
    expect(third.status).toBe('IDEMPOTENT_READY')
    expect(calls).toEqual(['B1', 'B8'])
    expect(third.mutation_manifest_sha256).toBe(second.mutation_manifest_sha256)
  })
})
