import { describe, expect, test } from 'bun:test'
import { bootstrap } from '../../bin/aun/bootstrap'
import type { BootstrapExecutionPorts, BootstrapReasonCode, BootstrapStageOutcome } from '../../bin/aun/bootstrap-types'
import { MemoryBootstrapStateStore } from '../../core/aun-bootstrap-state'

const HEAD = 'c8eb30805a587a65a794499fa597935f2460c703'
const fakeRun = async (command: string, args: string[]) => command === 'codex' && args.join(' ') === 'mcp get wasurezu --json'
  ? { exitCode: 1, stdout: '', stderr: 'not configured' }
  : { exitCode: 0, stdout: `${HEAD}\n`, stderr: '' }

function ports(failMethod: keyof BootstrapExecutionPorts, code: BootstrapReasonCode): BootstrapExecutionPorts {
  const ok = async (): Promise<BootstrapStageOutcome> => ({ ok: true })
  const resolved = async (): Promise<BootstrapStageOutcome> => ({ ok: true, resolvedRuntime: 'codex' })
  const failing = async (): Promise<BootstrapStageOutcome> => ({ ok: false, reasonCodes: [code] })
  return {
    lockAndSnapshot: failMethod === 'lockAndSnapshot' ? failing : ok,
    dependencyPreflight: failMethod === 'dependencyPreflight' ? failing : resolved,
    migrateDatabase: failMethod === 'migrateDatabase' ? failing : ok,
    ensureAgentProfile: failMethod === 'ensureAgentProfile' ? failing : ok,
    ensureMcpRegistration: failMethod === 'ensureMcpRegistration' ? failing : ok,
    ensureMemoryReadiness: failMethod === 'ensureMemoryReadiness' ? failing : ok,
    installAndStartDaemon: failMethod === 'installAndStartDaemon' ? failing : ok,
    runQueueSmoke: failMethod === 'runQueueSmoke' ? failing : ok,
    readbackReady: failMethod === 'readbackReady' ? failing : ok,
    rollbackMutation: ok,
  }
}

describe('aun bootstrap failure injection matrix', () => {
  const cases: Array<[keyof BootstrapExecutionPorts, BootstrapReasonCode, string]> = [
    ['migrateDatabase', 'NO_GO_DB_MIGRATION', 'B2_DB_MIGRATION'],
    ['ensureAgentProfile', 'NO_GO_IDENTITY_MISMATCH', 'B3_AGENT_PROFILE'],
    ['ensureMcpRegistration', 'NO_GO_MCP_REGISTRATION', 'B4_MCP_REGISTRATION'],
    ['ensureMemoryReadiness', 'NO_GO_MEMORY_RECOVERY', 'B5_MEMORY_READINESS'],
    ['installAndStartDaemon', 'NO_GO_DAEMON_START', 'B6_ORDINARY_DAEMON_INSTALL_START'],
    ['runQueueSmoke', 'NO_GO_DUPLICATE_CLAIM', 'B7_QUEUE_SMOKE'],
    ['readbackReady', 'NO_GO_READY_PREDICATE_FALSE', 'B8_READY_READBACK'],
  ]
  for (const [method, code, stage] of cases) {
    test(`${stage} failure is terminal NO_GO with exact code`, async () => {
      const store = new MemoryBootstrapStateStore()
      const result = await bootstrap({
        agentId: `failure-${stage.toLowerCase()}`, runtime: 'codex', home: '/tmp/failure', repoRoot: process.cwd(), env: { HOME: '/tmp/failure' },
      }, { stateStore: store, ports: ports(method, code), run: fakeRun })
      expect(result.status).toBe('NO_GO')
      expect(result.stage).toBe(stage)
      expect(result.reason_codes).toEqual([code])
      expect(result.next_action.deliver_via).not.toContain('--resume')
    })
  }
})
