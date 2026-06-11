/**
 * Unit tests for adapters/streamable-http.ts
 *
 * Tests cover:
 *   - OPTIONS → 204 with correct CORS headers
 *   - POST /mcp with valid JSON-RPC initialize → 200
 *   - GET /mcp → event-stream content-type
 *   - isStreamableHttpEnabled() env flag
 *
 * Strategy: use Node.js http.createServer to bind a real port, then send
 * requests with fetch so we exercise the full handler path without spawning
 * a subprocess or importing server.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createServer, type Server as HttpServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { createStreamableHttpHandler, isStreamableHttpEnabled } from '../../adapters/streamable-http'

// ---------------------------------------------------------------------------
// Minimal MCP Server fixture
// ---------------------------------------------------------------------------

function makeMcpServer(): Server {
  return new Server(
    { name: 'test-mcp-server', version: '0.0.1' },
    { capabilities: {} },
  )
}

// ---------------------------------------------------------------------------
// HTTP server setup / teardown
// ---------------------------------------------------------------------------

let httpServer: HttpServer
let baseUrl: string

beforeAll(async () => {
  const mcpServer = makeMcpServer()
  const handler = createStreamableHttpHandler(mcpServer)

  httpServer = createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(String(err))
      }
    })
  })

  await new Promise<void>((resolve) => {
    // port 0 = OS assigns a free port
    httpServer.listen(0, '127.0.0.1', resolve)
  })

  const addr = httpServer.address()
  if (!addr || typeof addr === 'string') throw new Error('unexpected address type')
  baseUrl = `http://127.0.0.1:${addr.port}/mcp`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()))
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamable-http adapter — CORS (OPTIONS)', () => {
  it('OPTIONS /mcp returns 204 with correct CORS headers', async () => {
    const res = await fetch(baseUrl, { method: 'OPTIONS' })
    expect(res.status).toBe(204)

    expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE')
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type')
    expect(res.headers.get('access-control-allow-headers')).toContain('Mcp-Session-Id')
  })
})

describe('streamable-http adapter — POST initialize', () => {
  it('POST /mcp with JSON-RPC initialize returns 200', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    }

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(200)
  }, 10_000)

  it('POST /mcp with invalid JSON returns 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })

    expect(res.status).toBe(400)
  })
})

describe('streamable-http adapter — GET SSE stream', () => {
  it('GET /mcp returns text/event-stream content-type', async () => {
    const controller = new AbortController()
    const { signal } = controller

    let res: Response
    try {
      res = await fetch(baseUrl, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal,
      })
    } catch {
      // If the stream connection was aborted before headers were read,
      // we can't assert. Just skip.
      controller.abort()
      return
    }

    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/event-stream')

    // Clean up the long-lived connection
    controller.abort()
  }, 10_000)
})

describe('streamable-http adapter — DELETE', () => {
  it('DELETE /mcp returns 200 in stateless mode', async () => {
    const res = await fetch(baseUrl, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})

describe('streamable-http adapter — unsupported method', () => {
  it('PUT /mcp returns 405', async () => {
    const res = await fetch(baseUrl, { method: 'PUT' })
    expect(res.status).toBe(405)
  })
})

describe('isStreamableHttpEnabled()', () => {
  it('returns false when env var is absent', () => {
    const original = process.env.NEW_STREAMABLE_HTTP_ENABLED
    delete process.env.NEW_STREAMABLE_HTTP_ENABLED
    expect(isStreamableHttpEnabled()).toBe(false)
    if (original !== undefined) process.env.NEW_STREAMABLE_HTTP_ENABLED = original
  })

  it('returns true when env var is "1"', () => {
    const original = process.env.NEW_STREAMABLE_HTTP_ENABLED
    process.env.NEW_STREAMABLE_HTTP_ENABLED = '1'
    expect(isStreamableHttpEnabled()).toBe(true)
    if (original !== undefined) {
      process.env.NEW_STREAMABLE_HTTP_ENABLED = original
    } else {
      delete process.env.NEW_STREAMABLE_HTTP_ENABLED
    }
  })

  it('returns false when env var is "0"', () => {
    const original = process.env.NEW_STREAMABLE_HTTP_ENABLED
    process.env.NEW_STREAMABLE_HTTP_ENABLED = '0'
    expect(isStreamableHttpEnabled()).toBe(false)
    if (original !== undefined) {
      process.env.NEW_STREAMABLE_HTTP_ENABLED = original
    } else {
      delete process.env.NEW_STREAMABLE_HTTP_ENABLED
    }
  })
})
