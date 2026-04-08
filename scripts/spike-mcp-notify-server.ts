#!/usr/bin/env bun
/**
 * Q1 PoC Spike — minimal MCP server that emits server-initiated notifications.
 *
 * Logs to /tmp/spike-server.log so the test driver can verify the server
 * is alive even when stdio is captured by the parent claude process.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'node:fs'

const LOG = '/tmp/spike-server.log'
const log = (msg: string) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(LOG, line) } catch {}
  process.stderr.write(line)
}

const SPIKE_TOKEN = `SPIKE-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
let tickCount = 0
let chosenMethod: 'notifications/message' | 'notifications/log' | 'none' = 'notifications/message'

const server = new Server(
  { name: 'spike-notify', version: '0.0.1' },
  { capabilities: { tools: {}, logging: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log(`ListTools called, emitting tick`)
  await emitTick()
  return { tools: [] }
})

async function emitTick(): Promise<void> {
  tickCount += 1
  const data = `[spike-notify] tick #${tickCount} token=${SPIKE_TOKEN}`
  log(`emit ${chosenMethod}: ${data}`)
  if (chosenMethod === 'none') return
  try {
    await server.notification({
      method: chosenMethod,
      params: { level: 'info', logger: 'spike', data },
    })
  } catch (err) {
    log(`${chosenMethod} threw: ${(err as Error).message}`)
    if (chosenMethod === 'notifications/message') {
      chosenMethod = 'notifications/log'
      log(`falling back to notifications/log`)
      try {
        await server.notification({
          method: chosenMethod,
          params: { level: 'info', logger: 'spike', data },
        })
      } catch (err2) {
        log(`notifications/log also threw: ${(err2 as Error).message}`)
        chosenMethod = 'none'
      }
    } else {
      chosenMethod = 'none'
    }
  }
}

const transport = new StdioServerTransport()
await server.connect(transport)
log(`connected, token=${SPIKE_TOKEN}, pid=${process.pid}`)

setInterval(() => {
  emitTick().catch((err) => log(`tick failed: ${err}`))
}, 800)
