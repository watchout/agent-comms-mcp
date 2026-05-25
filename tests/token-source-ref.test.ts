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

  test('returns null for unsupported, missing, or empty token refs', () => {
    expect(resolveTokenSourceRef(null)).toBeNull()
    expect(resolveTokenSourceRef('vault:secret/aun')).toBeNull()
    expect(resolveTokenSourceRef('local-env:MISSING', {})).toBeNull()
  })
})
