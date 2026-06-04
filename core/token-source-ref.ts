import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const quote = trimmed[0]
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function readEnvFileValue(filePath: string, key: string): string | null {
  let text = ''
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const index = normalized.indexOf('=')
    if (index <= 0) continue
    const name = normalized.slice(0, index).trim()
    if (name !== key) continue
    const value = unquoteEnvValue(normalized.slice(index + 1))
    return value.trim() ? value.trim() : null
  }

  return null
}

function resolveEnvFile(rest: string): TokenSourceResolution | null {
  const hashIndex = rest.indexOf('#')
  if (hashIndex <= 0 || hashIndex === rest.length - 1) return null

  const filePath = rest.slice(0, hashIndex).trim()
  const key = rest.slice(hashIndex + 1).trim()
  if (!filePath || !key) return null
  const token = readEnvFileValue(filePath, key)
  if (!token) return null
  return { token, source: `env-file:${filePath}#${key}` }
}

function resolveAgentComApiKeys(key: string, env: TokenSourceEnv): TokenSourceResolution | null {
  const trimmedKey = key.trim()
  if (!trimmedKey) return null
  const filePath = env.AGENT_COM_API_KEYS_FILE?.trim()
    || (env.HOME?.trim() ? join(env.HOME.trim(), '.agent-com-api-keys') : null)
  if (!filePath) return null
  const token = readEnvFileValue(filePath, trimmedKey)
  if (!token) return null
  return { token, source: `agent-com-api-keys:${trimmedKey}` }
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

  if (scheme === 'env-file') {
    return resolveEnvFile(rest)
  }

  if (scheme === 'agent-com-api-keys') {
    return resolveAgentComApiKeys(rest, env)
  }

  return null
}
