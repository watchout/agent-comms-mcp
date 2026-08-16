import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postToOutbound } from '../scripts/heartbeat-poll'

const roots: string[] = []
const priorControlPath = process.env.AGENT_COM_PROVIDER_EFFECTS_CONTROL_FILE

afterEach(() => {
  if (priorControlPath === undefined) delete process.env.AGENT_COM_PROVIDER_EFFECTS_CONTROL_FILE
  else process.env.AGENT_COM_PROVIDER_EFFECTS_CONTROL_FILE = priorControlPath
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function controlPath(mode: 'allowed' | 'forbidden'): string {
  const root = mkdtempSync(join(tmpdir(), 'heartbeat-provider-effects-'))
  roots.push(root)
  const path = join(root, 'control.json')
  writeFileSync(path, JSON.stringify({
    schema_version: 'agent-comms/provider-effects-control/v1',
    epoch: `heartbeat-${mode}`,
    provider_effects: mode,
    expires_at: '2099-01-01T00:00:00.000Z',
  }), { mode: 0o600 })
  return path
}

describe('heartbeat provider-effects producer fence', () => {
  test('forbidden epoch writes only typed audit evidence and no outbound row', async () => {
    process.env.AGENT_COM_PROVIDER_EFFECTS_CONTROL_FILE = controlPath('forbidden')
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      },
    }

    const result = await postToOutbound(client as any, 'internal heartbeat evidence')

    expect(result).toEqual({
      outboundQueued: false,
      outboundSkipReason: 'provider effects forbidden by host control',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('INSERT INTO audit_log')
    expect(calls[0].sql).not.toContain('INSERT INTO outbound_queue')
    expect(JSON.parse(String(calls[0].params?.[3]))).toMatchObject({
      code: 'PROVIDER_EFFECTS_FORBIDDEN',
      surface: 'heartbeat-poll',
      provider_effects_control: {
        epoch: 'heartbeat-forbidden',
        mode: 'forbidden',
      },
    })
  })

  test('stable allowed epoch preserves one outbound insert', async () => {
    process.env.AGENT_COM_PROVIDER_EFFECTS_CONTROL_FILE = controlPath('allowed')
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      },
    }

    expect(await postToOutbound(client as any, 'provider heartbeat')).toEqual({
      outboundQueued: true,
      outboundSkipReason: null,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('INSERT INTO outbound_queue')
  })
})
