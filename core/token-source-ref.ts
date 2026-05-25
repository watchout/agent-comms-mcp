import { readFileSync } from 'node:fs'

export type TokenSourceEnv = Record<string, string | undefined>

export interface TokenSourceResolution {
  token: string
  source: string
}

function firstColon(value: string): [string, string] | null {
  const index = value.indexOf(':')
  if (index <= 0) return null
  return [value.slice(0, index), value.slice(index + 1)]
}

function readPath(root: unknown, selector: string): unknown {
  const parts = selector.startsWith('/')
    ? selector.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    : selector.split('.')

  let current = root
  for (const part of parts) {
    if (!part) continue
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function resolveMcpJson(rest: string): TokenSourceResolution | null {
  const hashIndex = rest.indexOf('#')
  if (hashIndex <= 0 || hashIndex === rest.length - 1) return null

  const filePath = rest.slice(0, hashIndex)
  const selector = rest.slice(hashIndex + 1)
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  const value = readPath(parsed, selector)
  if (typeof value !== 'string' || !value.trim()) return null
  return { token: value.trim(), source: `mcp-json:${filePath}#${selector}` }
}

export function resolveTokenSourceRef(ref: string | null | undefined, env: TokenSourceEnv = process.env): TokenSourceResolution | null {
  const sourceRef = typeof ref === 'string' ? ref.trim() : ''
  if (!sourceRef) return null

  const parsed = firstColon(sourceRef)
  if (!parsed) return null
  const [scheme, rest] = parsed

  if ((scheme === 'local-env' || scheme === 'env') && rest.trim()) {
    const value = env[rest.trim()]
    if (typeof value !== 'string' || !value.trim()) return null
    return { token: value.trim(), source: `${scheme}:${rest.trim()}` }
  }

  if (scheme === 'mcp-json') {
    return resolveMcpJson(rest)
  }

  return null
}
