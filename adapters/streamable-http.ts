/**
 * Streamable HTTP Adapter (NORM-022 / MCP Streamable HTTP transport)
 *
 * Provides a /mcp endpoint using StreamableHTTPServerTransport from
 * @modelcontextprotocol/sdk ^1.12.1.
 *
 * Activation: set NEW_STREAMABLE_HTTP_ENABLED=1 in the environment.
 * Without that env var the endpoint registration is skipped so existing
 * SSE-based routes (/sse, /messages) are unaffected.
 *
 * Design decisions:
 * - Stateless mode (sessionIdGenerator: undefined) — simplest first
 * - Per-request transport instances for POST (each JSON-RPC call is
 *   independent; no shared in-memory session state is required)
 * - GET /mcp opens a long-lived SSE stream on a shared transport so the
 *   server can push notifications without a preceding POST
 * - CORS headers are set on every response; origin is configurable via
 *   the CORS_ORIGIN env var (default: *)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Authorization',
}

function applyCorsHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v)
  }
}

// ---------------------------------------------------------------------------
// Body reader
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Shared GET transport (server-initiated notifications over SSE)
// ---------------------------------------------------------------------------

let _sharedGetTransport: StreamableHTTPServerTransport | null = null

function getSharedGetTransport(mcpServer: Server): StreamableHTTPServerTransport {
  if (!_sharedGetTransport) {
    _sharedGetTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    _sharedGetTransport.onclose = () => {
      _sharedGetTransport = null
    }
    // Connect to the MCP server so it can push messages
    mcpServer.connect(_sharedGetTransport).catch(() => {
      _sharedGetTransport = null
    })
  }
  return _sharedGetTransport
}

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

/**
 * Returns a Node.js HTTP request handler that serves the /mcp endpoint.
 *
 * Routing:
 *   OPTIONS /mcp  → 204 with CORS preflight headers
 *   POST    /mcp  → new per-request StreamableHTTPServerTransport (stateless)
 *   GET     /mcp  → shared SSE transport for server-push streams
 *   DELETE  /mcp  → session termination (no-op in stateless mode, 200 OK)
 *   *       /mcp  → 405 Method Not Allowed
 */
export function createStreamableHttpHandler(
  mcpServer: Server,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    applyCorsHeaders(res)

    const method = req.method?.toUpperCase() ?? ''

    // -----------------------------------------------------------------------
    // OPTIONS — CORS preflight
    // -----------------------------------------------------------------------
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // -----------------------------------------------------------------------
    // POST — stateless per-request transport
    // -----------------------------------------------------------------------
    if (method === 'POST') {
      let body: unknown
      try {
        body = await readBody(req)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON body' }))
        return
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      try {
        await mcpServer.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      } finally {
        // Clean up transport after request completes
        transport.close().catch(() => {
          // ignore close errors on ephemeral transports
        })
      }
      return
    }

    // -----------------------------------------------------------------------
    // GET — shared SSE stream for server-initiated notifications
    // -----------------------------------------------------------------------
    if (method === 'GET') {
      const transport = getSharedGetTransport(mcpServer)
      try {
        await transport.handleRequest(req, res)
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      }
      return
    }

    // -----------------------------------------------------------------------
    // DELETE — session termination (stateless: always OK)
    // -----------------------------------------------------------------------
    if (method === 'DELETE') {
      // In stateless mode there is no session to close; signal success.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // -----------------------------------------------------------------------
    // Unsupported method
    // -----------------------------------------------------------------------
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE, OPTIONS' })
    res.end(JSON.stringify({ error: 'Method Not Allowed' }))
  }
}

// ---------------------------------------------------------------------------
// Feature flag check — caller can gate registration on this
// ---------------------------------------------------------------------------

/**
 * Returns true when NEW_STREAMABLE_HTTP_ENABLED=1 is set in the environment.
 * Use this to guard /mcp endpoint registration in server.ts without modifying
 * the existing SSE-based routing.
 */
export function isStreamableHttpEnabled(): boolean {
  return process.env.NEW_STREAMABLE_HTTP_ENABLED === '1'
}
