import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_LIVE_RUNTIME_GRACE_SECONDS,
  heartbeatAgentStatus,
  markAgentOfflineIfNoOtherLiveRuntime,
  markAgentRuntimeStopped,
} from '../core/agent-status-lifecycle'

const REPO_ROOT = join(import.meta.dir, '..')

describe('agent status lifecycle', () => {
  test('heartbeat revives clobbered inactive status without overwriting active states', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      },
    }

    await heartbeatAgentStatus(db, 'aun')

    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual(['aun'])
    expect(calls[0].sql).toContain('last_seen_at = now()')
    expect(calls[0].sql).toContain("status IN ('offline', 'disconnected', 'restarting')")
    expect(calls[0].sql).toContain("THEN 'online'")
    expect(calls[0].sql).toContain('ELSE status')
  })

  test('shutdown only marks offline when no other fresh running runtime exists', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        return { rows: [], rowCount: 0 }
      },
    }

    const marked = await markAgentOfflineIfNoOtherLiveRuntime(db, {
      agentId: 'aun',
      runtimeInstanceId: 'short-lived-runtime',
    })

    expect(marked).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual(['aun', 'short-lived-runtime', DEFAULT_LIVE_RUNTIME_GRACE_SECONDS])
    expect(calls[0].sql).toContain('NOT EXISTS')
    expect(calls[0].sql).toContain('runtime_instance_id <> $2')
    expect(calls[0].sql).toContain("status = 'running'")
    expect(calls[0].sql).toContain('last_seen_at > now() - make_interval(secs => $3)')
  })

  test('runtime stop helper and unregisterAgent guard live-runtime offline writes', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      },
    }

    await markAgentRuntimeStopped(db, 'runtime-a')
    await markAgentOfflineIfNoOtherLiveRuntime(db, {
      agentId: 'aun',
      runtimeInstanceId: 'runtime-a',
    })

    expect(calls[0].sql).toContain('UPDATE agent_runtime_instances')
    expect(calls[0].sql).toContain("status = 'stopped'")
    expect(calls[1].sql).toContain('UPDATE agents')

    const serverSource = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf8')
    const start = serverSource.indexOf('async function unregisterAgent()')
    const end = serverSource.indexOf('\nasync function ', start + 1)
    const body = serverSource.slice(start, end === -1 ? undefined : end)
    expect(body.indexOf('UPDATE agent_runtime_instances')).toBeLessThan(body.indexOf('markAgentOfflineIfNoOtherLiveRuntime'))
    expect(body.indexOf('if (markedOffline)')).toBeLessThan(body.indexOf("pgNotify(client, 'agent_events'"))
  })
})
