import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveTokenSourceRef } from '../core/token-source-ref'

let tmp: string | null = null

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = null
  }
})

describe('token source references', () => {
  test('resolves local env token refs without storing raw secrets in DB', () => {
    expect(resolveTokenSourceRef('local-env:BOT_TOKEN', { BOT_TOKEN: ' token-1 ' })).toEqual({
      token: 'token-1',
      source: 'local-env:BOT_TOKEN',
    })
  })

  test('resolves mcp-json token refs using dotted selector paths', () => {
    tmp = mkdtempSync(join(tmpdir(), 'aun-token-ref-'))
    const file = join(tmp, '.mcp.json')
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        'agent-comms': {
          env: {
            DISCORD_BOT_TOKEN: 'token-2',
          },
        },
      },
    }))

    expect(resolveTokenSourceRef(`mcp-json:${file}#mcpServers.agent-comms.env.DISCORD_BOT_TOKEN`)).toEqual({
      token: 'token-2',
      source: `mcp-json:${file}#mcpServers.agent-comms.env.DISCORD_BOT_TOKEN`,
    })
  })

  test('resolves env-file token refs without storing raw secrets in DB', () => {
    tmp = mkdtempSync(join(tmpdir(), 'aun-token-ref-'))
    const file = join(tmp, '.agent-com-api-keys')
    writeFileSync(file, [
      '# comments are ignored',
      'export OTHER_TOKEN=ignored',
      'hotel_lead_token=\" token-3 \"',
      '',
    ].join('\n'))

    expect(resolveTokenSourceRef(`env-file:${file}#hotel_lead_token`)).toEqual({
      token: 'token-3',
      source: `env-file:${file}#hotel_lead_token`,
    })
  })

  test('resolves agent-com-api-keys refs from the configured key file', () => {
    tmp = mkdtempSync(join(tmpdir(), 'aun-token-ref-'))
    const file = join(tmp, '.agent-com-api-keys')
    writeFileSync(file, [
      'Kodama_token= token-4 ',
      'research_token=token-5',
    ].join('\n'))

    expect(resolveTokenSourceRef('agent-com-api-keys:Kodama_token', {
      AGENT_COM_API_KEYS_FILE: file,
    })).toEqual({
      token: 'token-4',
      source: 'agent-com-api-keys:Kodama_token',
    })
  })

  test('returns null for unsupported, missing, or empty token refs', () => {
    expect(resolveTokenSourceRef(null)).toBeNull()
    expect(resolveTokenSourceRef('vault:secret/aun')).toBeNull()
    expect(resolveTokenSourceRef('local-env:MISSING', {})).toBeNull()
    expect(resolveTokenSourceRef('env-file:/missing#TOKEN')).toBeNull()
    expect(resolveTokenSourceRef('agent-com-api-keys:MISSING', { AGENT_COM_API_KEYS_FILE: '/missing' })).toBeNull()
  })
})
